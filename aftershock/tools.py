"""The task-shaped operations every surface shares: MCP tools, REST routes, the CLI and the agent all call these.

Each returns plain JSON plus `receipts` (the graph queries it ran, with timings), so any answer can show its work.
Inputs are validated here, once, rather than in each surface.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

from .analysis import architecture, culprit, diff, evaluate, impact, lookup, paths, report
from .config import get_settings
from .graph import NAME_RE, RepoGraph, get_store, recording

CHANGES = ("body", "signature", "rename", "delete")


class ToolError(ValueError):
    """Bad input a caller can fix (unknown repo, path outside the allowed roots, ...). Surfaces map it to 4xx."""


class NotFound(ToolError):
    pass


@contextmanager
def _receipts(out: dict):
    t0 = time.perf_counter()
    with recording() as rec:
        yield
    out["receipts"] = {"queries": len(rec), "graph_ms": round(sum(r["ms"] for r in rec), 1),
                       "total_ms": round((time.perf_counter() - t0) * 1000, 1), "log": rec[:60]}


def _graph(repo: str) -> RepoGraph:
    if not isinstance(repo, str) or not NAME_RE.match(repo):
        raise ToolError(f"invalid repo name {repo!r}")
    g = get_store().repo(repo)
    if not g.exists():
        raise NotFound(f"repo {repo!r} is not indexed; index it first")
    return g


def _repo_props(g: RepoGraph) -> dict:
    return (g.ro("repo") or [{"repo": {}}])[0]["repo"]


def _depth(depth: int | None) -> int | None:
    if depth is None:
        return None
    return max(1, min(int(depth), get_settings().max_depth))


def run(fn, *args, **kwargs) -> dict:
    out: dict = {}
    with _receipts(out):
        res = fn(*args, **kwargs)
    return {**res, **out} if isinstance(res, dict) else {"result": res, **out}


# ---- repos -----------------------------------------------------------------------------------------------------------


def list_repos(include_lab: bool = False) -> dict:
    store = get_store()
    rows = []
    lab = store.lab_repos() if include_lab else set()
    for name in store.list_repos(include_lab):
        props = _repo_props(store.repo(name))
        rows.append({k: props.get(k) for k in ("name", "url", "files", "symbols", "calls", "resolution_rate",
                                                "indexed_at", "commit", "history_commits", "parser_version")}
                    | {"name": name} | ({"lab": True} if name in lab else {}))
    return {"repos": rows}


def set_lab(repo: str, on: bool) -> dict:
    _graph(repo)
    if repo not in get_store().list_repos(include_lab=True):
        raise NotFound(f"no repository named {repo!r}")
    get_store().set_lab(repo, on)
    return {"repo": repo, "lab": on}


def allowed_path(path: str | Path) -> Path:
    """Local indexing is confined to configured roots (default: the server's cwd) so an API caller can't read /etc."""
    p = Path(path).expanduser().resolve()
    roots = get_settings().roots() + [get_settings().clone_dir.resolve()]
    if not any(p == r or r in p.parents for r in roots):
        # Don't echo server paths back to API callers; the operator sees roots in their own config.
        raise ToolError("path is outside the allowed roots; the server operator sets AFTERSHOCK_REPO_ROOTS")
    if not p.is_dir():
        raise NotFound("path is not a directory")
    return p


def repo_name_for(path: Path, name: str | None = None) -> str:
    n = name or re.sub(r"[^A-Za-z0-9_.-]+", "-", path.name).strip("-.")[:64] or "repo"
    if not NAME_RE.match(n):
        raise ToolError(f"invalid repo name {n!r}")
    return n


def check_url(url: str, name: str | None = None) -> str:
    """Validate a clone URL and return the repo name it will be indexed under. Raises ToolError."""
    s = get_settings()
    u = urlparse(url.strip())
    if u.scheme != "https" or not u.hostname or u.username or u.password:
        raise ToolError("only plain https:// clone URLs are accepted")
    if u.hostname.lower() not in s.clone_hosts():
        raise ToolError(f"host {u.hostname} is not in AFTERSHOCK_ALLOWED_CLONE_HOSTS")
    parts = [p for p in u.path.split("/") if p]
    if len(parts) < 2 or any(p in (".", "..") for p in parts):
        raise ToolError("expected https://host/owner/repo")
    return repo_name_for(Path(parts[-1].removesuffix(".git")), name)


def clone(url: str, name: str | None = None) -> tuple[Path, str]:
    """Shallow, hook-free clone of an https URL from an allowed host. Repo code is only ever parsed, never run."""
    s = get_settings()
    repo = check_url(url, name)
    dest = (s.clone_dir / repo).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1",
           "HOME": str(dest.parent), "GIT_CONFIG_NOSYSTEM": "1"}
    safe = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "core.symlinks=false"]
    try:
        if (dest / ".git").is_dir():
            subprocess.run(["git", *safe, "-C", str(dest), "pull", "--ff-only", "--depth", str(s.history_commits)],
                           env=env, capture_output=True, timeout=s.clone_timeout_s, check=True)
        else:
            shutil.rmtree(dest, ignore_errors=True)
            subprocess.run(["git", *safe, "clone", "--depth", str(s.history_commits), "--single-branch",
                            "--no-recurse-submodules", "--", url.strip(), str(dest)],
                           env=env, capture_output=True, timeout=s.clone_timeout_s, check=True)
    except subprocess.TimeoutExpired as e:
        shutil.rmtree(dest, ignore_errors=True)
        raise ToolError(f"clone timed out after {s.clone_timeout_s}s") from e
    except subprocess.CalledProcessError as e:
        raise ToolError(f"git failed: {e.stderr.decode(errors='replace').strip()[-300:]}") from e
    size = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file() and not f.is_symlink())
    if size > s.clone_max_mb * 1024 * 1024:
        shutil.rmtree(dest, ignore_errors=True)
        raise ToolError(f"repository is {size // 2**20} MB, over the {s.clone_max_mb} MB limit")
    return dest, repo


def index(path: str | None = None, *, url: str | None = None, name: str | None = None, full: bool = False,
          history: bool = True, progress=None) -> dict:
    from .ingest.pipeline import index_repo

    if bool(path) == bool(url):
        raise ToolError("give exactly one of path or url")
    if url:
        root, repo = clone(url, name)
    else:
        root = allowed_path(path)
        repo = repo_name_for(root, name)
    rep = index_repo(root, repo, full=full, with_history=history, url=url or "", progress=progress)
    return rep.as_dict()


# ---- analysis --------------------------------------------------------------------------------------------------------


def impact_of(repo: str, targets: list[str], change: str = "body", depth: int | None = None,
              markdown: bool = False) -> dict:
    """What breaks if these symbols change. `targets` are names, `file::qname` ids, or file paths."""
    if change not in CHANGES:
        raise ToolError(f"change must be one of {', '.join(CHANGES)}")
    if not targets:
        raise ToolError("give at least one target")
    _graph(repo)
    res = impact.impact_of(repo, [str(t) for t in targets[:50]], change, _depth(depth))
    if markdown and not res.get("error"):
        res["markdown"] = report.render(res)
    return res


def diff_impact(repo: str, rev: str | None = None, depth: int | None = None, link: str | None = None) -> dict:
    """Detect symbol changes in the repo's working tree (or `rev`) against the graph, then simulate their impact."""
    g = _graph(repo)
    root = Path(_repo_props(g).get("root") or "")
    if not root.is_dir():
        raise ToolError("the indexed checkout is no longer on disk; re-index it")
    allowed_path(root)
    if rev is not None and (rev.startswith("-") or not re.fullmatch(r"[A-Za-z0-9_./~^@{}-]{1,200}", rev)):
        raise ToolError("invalid git revision")
    res = diff.analyze(g, root, rev, _depth(depth))
    res["markdown"] = report.render(res["impact"], changes=res["changes"], link=link)
    return res


def replay_eval(repo: str, commits: int = 200, depth: int | None = 3, max_files: int = 12, progress=None) -> dict:
    """Replay recent commits: how well does the simulator predict the other files each commit had to touch?"""
    g = _graph(repo)
    root = Path(_repo_props(g).get("root") or "")
    if not root.is_dir():
        raise ToolError("the indexed checkout is no longer on disk; re-index it")
    allowed_path(root)
    return evaluate.evaluate(g, root, commits=max(1, min(commits, 5000)), depth=_depth(depth), max_files=max_files,
                             progress=progress)


def select_tests(repo: str, targets: list[str] | None = None, rev: str | None = None, diff_mode: bool = False) -> dict:
    """The tests that statically reach a change, ranked by how directly. From targets, or from the current diff."""
    res = diff_impact(repo, rev) if diff_mode or not targets else {"impact": impact_of(repo, targets or [], "signature")}
    imp = res.get("impact") or {}
    own = _changed_tests(res, imp)
    if not imp or imp.get("error"):
        if own and not imp.get("error"):  # only tests changed (or were added): run exactly those
            return {"tests": own, "files": sorted({t["file"] for t in own}), "untested_seeds": [], "seed_ids": [],
                    "runtime_tests": 0, "note": "Only tests changed; running the changed tests."}
        return {"tests": [], "files": [], "note": (imp or {}).get("error") or "no changes detected"}
    tests = [{k: t.get(k) for k in ("id", "name", "file", "line", "p", "hop", "runtime")} for t in imp["tests"]]
    # Impact drops anything under min_p, which is right for "what will probably break" but wrong for "what to run":
    # a test that reaches the change through a long or dispatch-heavy chain must still run. Add those by plain
    # reverse reachability, ranked after the probable ones.
    seed_ids = [s["id"] for s in imp.get("seeds", [])]
    if seed_ids:
        g = _graph(repo)
        have = {t["id"] for t in tests}
        reach = set().union(*culprit._tests_reaching(g, seed_ids, get_settings().max_depth).values()) - have
        for i in range(0, len(extra := sorted(reach)), 1000):
            for r in g.ro("symbols_by_ids", {"ids": extra[i : i + 1000]}):
                s = r["symbol"]
                tests.append({"id": s["id"], "name": s.get("name"), "file": s.get("file"), "line": s.get("line"),
                              "p": 0.0, "hop": None, "runtime": False, "reach": True})
    have = {t["id"] for t in tests}
    tests[:0] = [t for t in own if t["id"] not in have]
    files = sorted({t["file"] for t in tests})
    if imp.get("runtime_tests"):
        note = (f"Static reachability plus recorded per-test coverage ({imp['runtime_tests']} tests ran the changed "
                "code when coverage was recorded). Re-record after large changes: `aftershock coverage <repo>`.")
    else:
        note = ("Static reachability: a test that reaches the change through a resolved call/inherit edge. Tests that "
                "reach it only via dynamic dispatch, fixtures or config are not seen; record per-test coverage with "
                "`aftershock coverage <repo>` to add them.")
    return {"tests": tests, "files": files, "untested_seeds": [s["name"] for s in imp["untested_seeds"]],
            "seed_ids": seed_ids, "runtime_tests": imp.get("runtime_tests", 0),
            "note": note}


def wider_tests(repo: str, seed_ids: list[str], exclude: list[str]) -> list[str]:
    """Tests that reach the seeds only by a longer chain than select_tests follows (up to culprit.CHANGED_DEPTH)."""
    if not seed_ids:
        return []
    reach = set().union(*culprit._tests_reaching(_graph(repo), seed_ids, culprit.CHANGED_DEPTH).values())
    return sorted(reach - set(exclude))


_TEST_FILE = re.compile(r"(^|/)(test_[^/]*|[^/]*_test)\.py$|(^|/)tests?/[^/]*\.py$")


def _changed_tests(res: dict, imp: dict) -> list[dict]:
    """Tests that were themselves edited or added (testmon's baseline): impact lists only what *reaches* a seed, and
    added symbols are never seeds. A deleted test has nothing left to run; a renamed one runs under its new id."""
    changed = (res.get("changes") or {}).get("symbols")
    if changed is None:  # targets mode: the targets themselves
        changed = [{"id": s["id"], "change": "target", "line": s.get("line")} for s in imp.get("seeds", [])]
    out: dict[str, dict] = {}
    for c in changed:
        if c["change"] == "delete":
            continue
        sid = c.get("renamed_to") or c["id"]
        file, _, qname = sid.partition("::")
        if _looks_like_test(file, qname):
            out.setdefault(sid, {"id": sid, "name": re.sub(r"#\d+$", "", qname.rsplit(".", 1)[-1]), "file": file,
                                 "line": c.get("line"), "p": 1.0, "hop": 0, "runtime": False, "changed": c["change"]})
    return list(out.values())


def _looks_like_test(file: str, qname: str) -> bool:
    """A pytest test function or method by pytest's default discovery rules (Python only)."""
    leaf = re.sub(r"#\d+$", "", qname.rsplit(".", 1)[-1])
    return bool(_TEST_FILE.search(file)) and leaf.startswith("test") and (
        "." not in qname or qname.split(".", 1)[0].startswith("Test"))


def explain_path(repo: str, source: str, target: str, depth: int = 8) -> dict:
    return paths.explain(_graph(repo), source, target, max(1, min(int(depth), 10)))


def culprits(repo: str, failing: list[str], changed: list[str] | None = None, limit: int = 15) -> dict:
    if not failing:
        raise ToolError("give at least one failing test")
    g = _graph(repo)
    changed_ids = []
    for ref in changed or []:
        m = lookup.find(g, ref)
        changed_ids += m.ids
    return culprit.suspects(g, failing[:200], changed_ids, max(1, min(limit, 50)))


def overview(repo: str) -> dict:
    return architecture.overview(_graph(repo))


def hotspots(repo: str, limit: int = 20) -> dict:
    g = _graph(repo)
    return {"hotspots": g.ro("hotspots", {"limit": max(1, min(limit, 200))}),
            "central": g.ro("central", {"limit": max(1, min(limit, 200))})}


def owners(repo: str, paths_: list[str], limit: int = 8) -> dict:
    g = _graph(repo)
    return {"owners": g.ro("owners", {"paths": paths_[:400], "limit": max(1, min(limit, 50))}),
            "cochange": g.ro("cochanged_with", {"paths": paths_[:400], "limit": 20})}


def search(repo: str, q: str, limit: int = 20) -> dict:
    g = _graph(repo)
    return {"symbols": lookup.search(g, q, max(1, min(limit, 100))),
            "files": g.ro("search_files", {"q": q.strip().lower()})[:limit] if q.strip() else []}


def symbol(repo: str, ref: str) -> dict:
    """A symbol with its callers and callees, or the candidate list when the reference is ambiguous."""
    g = _graph(repo)
    m = lookup.find(g, ref)
    if not m.ok:
        if m.candidates:
            return {"candidates": m.candidates}
        raise NotFound(m.error or f"no symbol {ref!r}")
    if m.file:
        return file_detail(repo, m.file)
    sid = m.ids[0]
    sym = g.ro("symbol", {"id": sid})[0]["symbol"]
    edges = g.ro("neighborhood", {"id": sid, "limit": 400})
    others = sorted({e["other"] for e in edges})
    names = {r["symbol"]["id"]: r["symbol"] for r in g.ro("symbols_by_ids", {"ids": others})} if others else {}

    def side(out: bool) -> list[dict]:
        rows = []
        for e in edges:
            if e["outgoing"] is out:
                o = names.get(e["other"], {})
                rows.append({"id": e["other"], "name": o.get("qname"), "file": o.get("file"), "line": o.get("line"),
                             "type": e["type"], "how": e["how"], "confidence": e["confidence"], "lines": e["lines"]})
        return sorted(rows, key=lambda r: (r["file"] or "", r["line"] or 0))

    return {"symbol": sym, "callers": side(False), "callees": side(True)}


def file_detail(repo: str, path: str) -> dict:
    g = _graph(repo)
    rows = g.ro("file", {"path": path})
    if not rows or not rows[0]["file"]:
        raise NotFound(f"no file {path!r}")
    return {"file": rows[0]["file"], "symbols": [s for s in rows[0]["symbols"] if s],
            "imports": g.ro("file_imports", {"path": path}), "importers": g.ro("file_importers", {"path": path}),
            "externals": [r["name"] for r in g.ro("file_externals", {"path": path})],
            "cochange": g.ro("cochanged_with", {"paths": [path], "limit": 10}),
            "owners": g.ro("owners", {"paths": [path], "limit": 5})}


def file_graph(repo: str, limit: int = 600) -> dict:
    return architecture.file_graph(_graph(repo), max(1, min(limit, 3000)))


def dead_code(repo: str, limit: int = 100) -> dict:
    return {"candidates": architecture.dead_code(_graph(repo), max(1, min(limit, 500))),
            "note": "Candidates, not verdicts: reflection, string dispatch and entry points named in config are invisible."}


def cypher(repo: str, query: str, params: dict | None = None) -> dict:
    """Escape hatch: a read-only, depth-bounded, row-capped Cypher query against one repo graph."""
    from .graph import QueryRejected

    if not isinstance(query, str) or len(query) > 4000:
        raise ToolError("query must be a string under 4000 characters")
    try:
        rows = _graph(repo).user_query(query, params or {})
    except QueryRejected as e:
        raise ToolError(str(e)) from e
    return {"rows": rows, "count": len(rows)}


# ---- test libraries and recorded runs (D25) --------------------------------------------------------------------------

LIB_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")
RUN_ID = re.compile(r"^[0-9a-f]{8,24}$")


def test_libraries(repo: str) -> dict:
    from .ingest.discover import LIB_PREFIX, libraries

    g = _graph(repo)
    libs = libraries(_repo_props(g))
    files = [r["path"] for r in g.ro("file_index") if r["path"].startswith(LIB_PREFIX)]
    tests = [t for t in g.ro("tests") if t["file"].startswith(LIB_PREFIX)]
    return {"libraries": [{"name": n, "path": d, "on_disk": Path(d).is_dir(),
                           "files": sum(f.startswith(f"{LIB_PREFIX}{n}/") for f in files),
                           "tests": sum(t["file"].startswith(f"{LIB_PREFIX}{n}/") for t in tests)}
                          for n, d in sorted(libs.items())]}


def library_set(repo: str, name: str, path: str | None) -> dict:
    """Register (`path`) or forget (None) a directory of pytest tests that lives outside the repo. Re-index after."""
    import json

    from .ingest.discover import libraries

    if not isinstance(name, str) or not LIB_NAME.match(name):
        raise ToolError("library names are 1-40 letters, digits, '-' or '_'")
    g = _graph(repo)
    props = _repo_props(g)
    libs = libraries(props)
    if path is None:
        if libs.pop(name, None) is None:
            raise NotFound(f"no test library {name!r} on {repo}")
    else:
        d = allowed_path(path)
        root = Path(props.get("root") or "").resolve()
        if d == root or root in d.parents or d in root.parents:
            raise ToolError("a test library must be a directory outside the repo (tests inside it are indexed already)")
        libs[name] = str(d)
    g.rw("upsert_repo", {"name": repo, "props": {"libraries": json.dumps(libs)}})
    return {"repo": repo, "libraries": libs, "note": "re-index the repo to pick up the change"}


def test_runs(repo: str, limit: int = 20) -> dict:
    from .runtime import runs

    return {"runs": runs.list_runs(_graph(repo), limit)}


def run_detail(repo: str, run_id: str) -> dict:
    from .runtime import runs

    if not isinstance(run_id, str) or not RUN_ID.match(run_id):
        raise ToolError(f"invalid run id {run_id!r}")
    out = runs.detail(_graph(repo), run_id)
    if out is None:
        raise NotFound(f"no recorded run {run_id!r}")
    out["next"] = next_steps(out)
    return out


def next_steps(run: dict) -> list[dict]:
    """What the graph suggests doing next with a recorded run: concrete tool calls with the reason for each, so an
    agent (or a person) picks the right tool from the evidence rather than by guessing (D26)."""
    sus = ((run.get("culprits") or {}).get("suspects") or [])
    fails = run.get("failures") or []
    if not fails:
        return []
    top, test = (sus[0] if sus else None), fails[0]["test"]
    out = []
    if top:
        out.append({"tool": "explain_path", "args": {"source": test, "target": top["id"]},
                    "why": f"how `{test.split('::')[-1]}` reaches the top suspect, edge by edge"})
        out.append({"tool": "impact", "args": {"targets": [top["id"]]},
                    "why": "what else depends on the suspect, i.e. what a fix there could break"})
    flaky = [t for t, h in (run.get("history") or {}).items() if 0 < h["failed"] < h["runs"]]
    if flaky:
        out.append({"tool": "cypher", "args": {"query": "MATCH (r:TestRun)-[e:RAN]->(t:Symbol {id: $t}) RETURN r.id, "
                                                        "r.started, e.outcome ORDER BY r.started DESC LIMIT 20",
                                               "params": {"t": flaky[0]}},
                    "why": f"`{flaky[0].split('::')[-1]}` both passed and failed before: check for flakiness"})
    if not run.get("measured"):
        out.append({"tool": "run_tests", "args": {"mode": "targets", "targets": [top["id"]] if top else [test]},
                    "why": "this run was not measured; a measured re-run ranks suspects on executed code",
                    "needs": "AFTERSHOCK_ALLOW_RUN on a local stdio server"})
    if sus and not run.get("retries"):
        out.append({"tool": "heal", "args": {"run_id": run["id"]}, "why": "let Claude fix the top suspect, re-verified",
                    "needs": "AFTERSHOCK_ALLOW_RUN on a local stdio server"})
    return out
