"""discover -> parse (cached by content sha) -> resolve (whole repo, in memory) -> write only what changed.

Incremental rule, per file F (see graph.py "Ownership"):
  * F vanished            -> DETACH DELETE F and its symbols.
  * F's sha changed       -> upsert F and its symbols, delete symbols F no longer defines, rewrite F's outgoing edges.
  * F unchanged, but the edges leaving it resolve differently (a callee moved, a new export now matches)
                          -> rewrite F's outgoing edges only.
Resolution is global and cheap (well under a second for ~2k files), so it always runs over the whole repo; what we
save is parsing (cache) and graph writes (digest diff), which dominate.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from redis.exceptions import RedisError

from ..config import get_settings
from ..graph import RepoGraph, Store, get_store
from . import history as hist
from .discover import is_git, libraries, library_sources, list_sources, read_configs
from .model import Call, Def, FileFacts, Import
from .parse import PARSER_VERSION, file_sha, parse_file
from .resolve import Edge, RepoConfig, Resolution, resolve

log = logging.getLogger("aftershock.ingest")
Progress = Callable[[str, dict], None]


@dataclass
class IndexReport:
    repo: str
    root: str
    files: int = 0
    parsed: int = 0  # files actually re-parsed (cache misses)
    changed: list[str] = field(default_factory=list)
    relinked: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    symbols: int = 0
    edges: int = 0
    call_sites: int = 0
    resolved_sites: int = 0
    unresolved_sites: int = 0
    external_sites: int = 0  # unresolved but provably into libraries/builtins: not blind spots
    edge_mix: dict[str, int] = field(default_factory=dict)
    parse_errors: list[str] = field(default_factory=list)
    commit: str = ""
    history_commits: int = 0
    seconds: dict[str, float] = field(default_factory=dict)

    @property
    def resolution_rate(self) -> float:
        return round(self.resolved_sites / self.call_sites, 4) if self.call_sites else 0.0

    @property
    def repo_resolution_rate(self) -> float:
        """Resolved share of the calls that could be repo calls (provably external ones left out)."""
        bound = self.call_sites - self.external_sites
        return round(min(1.0, self.resolved_sites / bound), 4) if bound > 0 else 0.0

    def as_dict(self) -> dict:
        d = asdict(self)
        d["resolution_rate"] = self.resolution_rate
        d["repo_resolution_rate"] = self.repo_resolution_rate
        for k in ("changed", "relinked", "removed"):
            d[f"{k}_count"] = len(d[k])
            d[k] = d[k][:200]
        return d


# ---- parse cache ---------------------------------------------------------------------------------------------------


def _facts_to_json(f: FileFacts) -> dict:
    return asdict(f)


def _facts_from_json(d: dict) -> FileFacts:
    return FileFacts(
        path=d["path"], lang=d["lang"], sha=d["sha"], loc=d["loc"], is_test=d["is_test"],
        defs=[Def(**x) for x in d["defs"]],
        calls=[Call(**x) for x in d["calls"]],
        imports=[Import(**{**x, "names": [tuple(n) for n in x["names"]]}) for x in d["imports"]],
        impls=[tuple(x) for x in d["impls"]], package=d["package"], error=d["error"],
    )


class ParseCache:
    """{path: facts} for one repo, keyed by content sha + PARSER_VERSION. A corrupt cache is simply discarded."""

    def __init__(self, path: Path):
        self.path = path
        self.items: dict[str, dict] = {}
        try:
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                data = json.load(fh)
            if data.get("v") == PARSER_VERSION:
                self.items = data["files"]
        except (OSError, ValueError, KeyError, EOFError):
            self.items = {}

    def get(self, path: str, sha: str) -> FileFacts | None:
        d = self.items.get(path)
        if d and d.get("sha") == sha:
            try:
                return _facts_from_json(d)
            except (TypeError, KeyError):
                return None
        return None

    def save(self, facts: list[FileFacts]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=3) as fh:
            json.dump({"v": PARSER_VERSION, "files": {f.path: _facts_to_json(f) for f in facts}}, fh)
        tmp.replace(self.path)


def load_facts(root: Path, name: str, progress: Progress | None = None,
               libs: dict[str, str] | None = None) -> tuple[list[FileFacts], int, list[str]]:
    """Parse every source file, reusing cached facts for unchanged content. Returns (facts, parsed, paths).

    Files of the repo's registered test libraries (`libs`) are indexed too, under `@lib/<name>/...`, always as tests:
    their imports resolve into the repo like any test's, so selection and culprit ranking reach them."""
    s = get_settings()
    cache = ParseCache(s.cache_dir / f"{name}.facts.json.gz")
    lib_files = library_sources(libs or {})
    paths = list_sources(root) + sorted(lib_files)
    facts, parsed = [], 0
    for i, p in enumerate(paths):
        try:
            data = (lib_files.get(p) or root / p).read_bytes()
        except OSError:
            continue
        sha = file_sha(data)
        f = cache.get(p, sha)
        if f is None:
            f = parse_file(p, data)
            parsed += 1
        if p in lib_files:
            f.is_test = True
        facts.append(f)
        if progress and i % 250 == 0:
            progress("parse", {"done": i, "total": len(paths)})
    if parsed or len(cache.items) != len(facts):
        cache.save(facts)
    return facts, parsed, paths


# ---- graph rows ----------------------------------------------------------------------------------------------------


def _file_of(symbol_id: str) -> str:
    return symbol_id.split("::", 1)[0]


def _symbol_row(d: Def, f: FileFacts) -> dict:
    return {
        "id": d.id,
        "props": {
            "id": d.id, "file": d.path, "name": d.name, "qname": d.qname, "kind": d.kind, "line": d.line,
            "end_line": d.end_line, "signature": d.signature[:400], "params": d.params[:40], "digest": d.digest,
            "sig_digest": d.sig_digest, "complexity": d.complexity, "loc": d.loc, "doc": d.doc[:600],
            "exported": d.exported, "is_test": d.is_test or (f.is_test and d.kind != "module" and d.name.startswith("test")),
            "min_args": d.min_args, "max_args": d.max_args, "decorators": d.decorators[:10], "returns": d.returns[:120],
            "bases": d.bases[:10], "lang": f.lang,
            # name=digest pairs (FalkorDB properties hold no maps); `diff` compares them to find changed values
            **({"values": [f"{k}={v}" for k, v in sorted(d.values.items())][:2000]} if d.kind == "module" else {}),
        },
    }


def _out_digest(path: str, edges: list[Edge], links: list, externals: set[str]) -> str:
    h = hashlib.blake2b(digest_size=10)
    for e in sorted(edges, key=lambda e: (e.src, e.dst, e.type)):
        h.update(f"{e.src}>{e.dst}:{e.type}:{e.how}:{e.confidence}:{e.lines}:{e.args}:{e.kind}:{e.names}\n".encode())
    for fl in sorted(links, key=lambda x: x.dst):
        h.update(f"I{fl.dst}:{sorted(fl.names)}:{fl.line}\n".encode())
    for x in sorted(externals):
        h.update(f"X{x}\n".encode())
    return h.hexdigest()


# ---- the run -------------------------------------------------------------------------------------------------------


def index_repo(
    root: Path,
    name: str,
    *,
    store: Store | None = None,
    full: bool = False,
    with_history: bool = True,
    url: str = "",
    progress: Progress | None = None,
) -> IndexReport:
    store = store or get_store()
    g = store.repo(name)
    root = root.resolve()
    rep = IndexReport(repo=name, root=str(root))
    emit = progress or (lambda stage, data: None)
    t = time.perf_counter()

    def lap(stage: str) -> None:
        nonlocal t
        now = time.perf_counter()
        rep.seconds[stage] = round(now - t, 3)
        t = now

    emit("start", {"repo": name, "root": str(root)})
    facts, rep.parsed, _ = load_facts(root, name, emit, libraries((g.ro("repo") or [{"repo": {}}])[0]["repo"]))
    rep.files = len(facts)
    rep.parse_errors = [f"{f.path}: {f.error}" for f in facts if f.error][:50]
    lap("parse")
    emit("parsed", {"files": rep.files, "parsed": rep.parsed})

    res = resolve(facts, RepoConfig.load(read_configs(root)))
    lap("resolve")
    # Resolution rate counts real call sites only (not callbacks passed as values or JSX tags). Calls into libraries
    # count against it, so it is a lower bound on how much of the repo's own call graph we see.
    rep.call_sites = sum(1 for f in facts for c in f.calls if c.kind in ("call", "new"))
    calls = [e for e in res.edges if e.type == "CALLS"]
    rep.resolved_sites = sum(e.count for e in calls if e.kind in ("call", "new"))
    rep.unresolved_sites = sum(res.unresolved.values())
    rep.external_sites = sum(res.external.values())
    rep.edge_mix = dict(Counter(e.how for e in calls).most_common())
    rep.edges = len(res.edges)
    rep.symbols = sum(len(f.defs) for f in facts)
    emit("resolved", {"edges": rep.edges, "resolution_rate": rep.resolution_rate})

    g.ensure_schema()
    write_graph(g, facts, res, rep, full=full, progress=emit)
    lap("write")

    if rep.changed or rep.relinked or rep.removed or full:
        compute_metrics(g, rep.symbols)
        emit("metrics", {})
    lap("metrics")

    repo_props = {
        "name": name, "root": str(root), "url": url, "parser_version": PARSER_VERSION, "files": rep.files,
        "symbols": rep.symbols, "calls": len(calls), "call_sites": rep.call_sites, "resolved_sites": rep.resolved_sites,
        "resolution_rate": rep.resolution_rate, "external_sites": rep.external_sites,
        "repo_resolution_rate": rep.repo_resolution_rate, "indexed_at": int(time.time()),
        "edge_mix": json.dumps(rep.edge_mix), "langs": json.dumps(dict(Counter(f.lang for f in facts))),
        "unresolved_top": json.dumps(Counter(res.unresolved).most_common(20)),
    }
    git = is_git(root)
    head = hist.head_commit(root) if git else ""
    if head:  # the snapshot's commit is what `diff` compares against, so record it even without history mining
        rep.commit = repo_props["commit"] = head
    if with_history and git:
        prev = g.ro("repo")
        if full or not prev or prev[0]["repo"].get("history_head") != head or rep.changed or rep.removed:
            h = hist.mine(root, {f.path for f in facts}, get_settings().history_commits)
            write_history(g, h)
            rep.history_commits = h.commits
            repo_props.update({"history_head": h.head, "history_commits": h.commits})
            emit("history", {"commits": h.commits, "couples": len(h.couples)})
    lap("history")
    g.rw("upsert_repo", {"name": name, "props": repo_props})
    store.publish(name, {"type": "indexed", "report": {k: v for k, v in rep.as_dict().items() if not isinstance(v, list)}})
    emit("done", rep.as_dict())
    return rep


def write_graph(g: RepoGraph, facts: list[FileFacts], res: Resolution, rep: IndexReport, *, full: bool,
                progress: Progress) -> None:
    by_path = {f.path: f for f in facts}
    edges_by_file: dict[str, list[Edge]] = {}
    for e in res.edges:
        edges_by_file.setdefault(_file_of(e.src), []).append(e)
    links_by_file: dict[str, list] = {}
    for fl in res.file_links:
        links_by_file.setdefault(fl.src, []).append(fl)
    digests = {
        p: _out_digest(p, edges_by_file.get(p, []), links_by_file.get(p, []), res.externals.get(p, set()))
        for p in by_path
    }

    existing = {r["path"]: r for r in g.ro("file_index")}
    rep.removed = sorted(set(existing) - set(by_path))
    for p, f in by_path.items():
        old = existing.get(p)
        if full or old is None or old.get("sha") != f.sha or old.get("parser_version") != PARSER_VERSION:
            rep.changed.append(p)
        elif old.get("out_digest") != digests[p]:
            rep.relinked.append(p)
    progress("diff", {"changed": len(rep.changed), "relinked": len(rep.relinked), "removed": len(rep.removed)})

    if rep.removed:
        g.batched("drop_files", rep.removed, size=500, key="paths")
        g.rw("drop_orphan_externals")
    touched = rep.changed + rep.relinked
    if not touched:
        return

    changed = set(rep.changed)
    g.batched("upsert_files", [
        {"path": p, "props": {"path": p, "lang": by_path[p].lang, "sha": by_path[p].sha, "loc": by_path[p].loc,
                              "is_test": by_path[p].is_test, "error": by_path[p].error or "",
                              "out_digest": digests[p], "package": by_path[p].package,
                              "parser_version": PARSER_VERSION}}
        for p in touched
    ])
    # Remove symbols a changed file no longer defines first, so their incoming edges vanish with them.
    g.batched("drop_vanished_symbols", [{"path": p, "keep": [d.id for d in by_path[p].defs]} for p in changed], size=200)
    sym_rows, contains = [], []
    for p in rep.changed:
        f = by_path[p]
        ids = {d.qname for d in f.defs}
        for d in f.defs:
            sym_rows.append(_symbol_row(d, f))
            parent = d.parent if d.parent in ids else ("<module>" if d.qname != "<module>" else None)
            if parent:
                contains.append({"parent": f"{p}::{parent}", "child": d.id})
    g.batched("upsert_symbols", sym_rows)
    g.batched("link_contains", contains)
    progress("symbols", {"written": len(sym_rows)})

    g.batched("drop_outgoing", touched, size=500, key="paths")
    # Recorded coverage survives a re-index (it costs a full test run to rebuild); edges touching files whose content
    # changed are only flagged stale until the next `aftershock coverage`. A re-parse with the same content (parser
    # upgrade, --full) leaves coverage as it was.
    edited = sorted(p for p in rep.changed if existing.get(p) is None or existing[p].get("sha") != by_path[p].sha)
    g.batched("mark_coverage_stale", edited, size=500, key="paths")
    g.batched("drop_file_links", touched, size=500, key="paths")
    rows: dict[str, list[dict]] = {"CALLS": [], "INHERITS": [], "IMPLEMENTS": [], "OVERRIDES": []}
    for p in touched:
        for e in edges_by_file.get(p, []):
            props = {"how": e.how, "confidence": e.confidence}
            if e.type == "OVERRIDES":
                props["lines"] = e.lines[:1]
            if e.type == "CALLS":
                props.update({"count": e.count, "lines": e.lines[:50], "args": sorted(set(e.args))[:10], "kind": e.kind})
                if e.names:
                    props["names"] = sorted(e.names)[:50]
            rows[e.type].append({"src": e.src, "dst": e.dst, "props": props})
    g.batched("link_calls", rows["CALLS"])
    g.batched("link_inherits", rows["INHERITS"])
    g.batched("link_implements", rows["IMPLEMENTS"])
    g.batched("link_overrides", rows["OVERRIDES"])
    g.batched("link_imports", [
        {"src": fl.src, "dst": fl.dst, "props": {"names": sorted(fl.names)[:50], "line": fl.line}}
        for p in touched for fl in links_by_file.get(p, []) if fl.dst != fl.src
    ])
    g.batched("link_externals", [{"file": p, "name": x} for p in touched for x in sorted(res.externals.get(p, ()))])
    g.rw("drop_orphan_externals")
    progress("edges", {"calls": len(rows["CALLS"]), "overrides": len(rows["OVERRIDES"])})


def compute_metrics(g: RepoGraph, symbols: int) -> None:
    """Whole-graph scores written back onto nodes: PageRank (how load-bearing), betweenness (how much of a
    chokepoint), import communities (which subsystem). Betweenness is sampled on big graphs to stay bounded."""
    g.rw("fan_counts")
    g.rw("algo_pagerank")
    try:
        g.rw("algo_betweenness", {"sample": min(symbols, 400) or 1})
    except RedisError as e:  # sampling is an optimization; a failing build of FalkorDB should not block indexing
        log.warning("betweenness skipped: %s", e)
    g.rw("algo_communities")
    g.rw("symbol_community")


def write_history(g: RepoGraph, h: hist.History) -> None:
    g.rw("drop_history")
    g.batched("set_history", [
        {"path": p, "props": {"churn": fh.churn, "commits": fh.commits, "last_change": fh.last,
                              "authors": len(fh.authors)}}
        for p, fh in h.files.items()
    ])
    g.batched("link_cochange", [{"a": a, "b": b, "count": n, "strength": s} for a, b, n, s in h.couples])
    g.batched("link_authored", [
        {"path": p, "email": email, "name": h.people.get(email, email), "commits": n, "last": h.last_by.get((email, p), 0)}
        for p, fh in h.files.items() for email, n in fh.authors.most_common(5)
    ])
