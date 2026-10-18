"""Built-in test and check scripts (D28): a curated catalog the user, or the Ask agent, picks from and runs.

Users don't write or register scripts. Every entry is defined here, with what it checks, when it applies to a
repo (by the files present), and how it runs. There are three kinds:

  * `check`   pure Python inside the API process, reading files under the checkout (secrets, merge markers,
              JSON/YAML/TOML validity, AST lints, ...). It never executes the repo's code, never starts a process,
              and never follows a symlink out of the checkout, so it runs without the run gate and the Ask agent
              may call it.
  * `graph`   a read-only question to the repo's FalkorDB graph (untested hubs, cycles, dead code, ...).
              Same rules as `check`.
  * `command` a subprocess (ruff, tsc, go vet, npm test, ...) or a pytest run through runtime/jobs.py. These can
              execute repo code or config, so they sit behind AFTERSHOCK_ALLOW_RUN plus a loopback client, as
              test runs always have (D18, D26). Tools are never downloaded: a command whose tool isn't installed
              (in the repo's venv, node_modules/.bin, or PATH) is skipped and says so.

`listing(repo)` is the catalog with, per script, whether it applies to this checkout and whether its tool is
installed. `run(repo, ids, emit)` runs a selection and streams `script` / `result` events.
"""

from __future__ import annotations

import contextlib
import glob
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

from .. import tools as T

log = logging.getLogger(__name__)

Emit = Callable[[str, dict], None]

CATEGORIES = {
    "tests": "Run the test suite, or part of it",
    "lint": "Style and likely-bug lints",
    "types": "Static type checking",
    "security": "Secrets, risky calls, known-vulnerable dependencies",
    "deps": "Dependency manifests and lockfiles",
    "build": "Does it compile / import / build",
    "hygiene": "Repository hygiene: stray files, markers, whitespace",
    "config": "Config file validity (JSON, YAML, TOML, CI, Docker)",
    "graph": "Questions to the code graph",
}
ECOSYSTEMS = ("python", "node", "go", "rust", "java", "ruby", "php", "dotnet", "shell", "docker", "ci", "generic",
              "graph")
KINDS = ("check", "graph", "command")

MAX_FILES = 25_000
MAX_READ = 2_000_000  # bytes; larger files are only looked at by the size checks
MAX_FINDINGS = 200
MAX_SELECT = 60
OUTPUT_TAIL = 6000
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".ruff_cache",
             ".pytest_cache", ".tox", ".nox", "dist", "build", ".next", "target", ".gradle", "vendor", ".idea",
             ".aftershock", "coverage", ".turbo", ".cache"}
SCRIPT_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]{1,63}$")


@dataclass
class Finding:
    file: str = ""
    line: int | None = None
    message: str = ""

    def as_dict(self) -> dict:
        return {"file": self.file, "line": self.line, "message": self.message[:400]}


@dataclass(frozen=True)
class Script:
    id: str
    name: str
    category: str
    ecosystem: str
    summary: str
    kind: str  # check | graph | command
    applies: Callable[[Ctx], bool] = lambda c: True
    fn: Callable[[Ctx], Iterable[Finding]] | None = None  # check / graph
    argv: tuple[str, ...] = ()  # command: "{python}" is the repo's interpreter, "{tool}" the resolved tool
    tool: str | None = None  # executable the command needs; looked up in the venv, node_modules/.bin, PATH
    pytest_mode: str | None = None  # command: delegate to runtime.jobs.run_tests (recorded, culprits ranked)
    # command: an in-process driver (catalog/probes.py) that runs the repo's interpreter itself, several times or
    # with a helper; called as runner(ctx, emit=, cancel=, timeout=) and returns a result like `_command`'s
    runner: Callable[..., dict] | None = None
    local_only: bool = False  # never for a showcase visitor (D29): it spends model credit or writes to the checkout
    severity: str = "warn"  # a check with findings: "error" fails it, "warn" warns, "info" only reports
    timeout: int = 900
    tags: tuple[str, ...] = ()

    @property
    def executes(self) -> bool:
        return self.kind == "command"

    def meta(self) -> dict:
        return {"id": self.id, "name": self.name, "category": self.category, "ecosystem": self.ecosystem,
                "summary": self.summary, "kind": self.kind, "executes": self.executes, "tool": self.tool,
                "severity": self.severity, "tags": list(self.tags), "local_only": self.local_only}


REGISTRY: dict[str, Script] = {}


def register(*scripts: Script) -> None:
    for s in scripts:
        assert SCRIPT_ID.match(s.id), s.id
        assert s.category in CATEGORIES and s.ecosystem in ECOSYSTEMS and s.kind in KINDS, s.id
        assert s.id not in REGISTRY, f"duplicate script id {s.id}"
        assert (s.fn is not None) == (s.kind != "command"), s.id
        REGISTRY[s.id] = s


class Ctx:
    """One checkout, read lazily and only inside its root."""

    def __init__(self, root: Path, repo: str = "", graph=None):
        self.root = root.resolve()
        self.repo = repo
        self.graph = graph
        self._text: dict[str, str | None] = {}

    @cached_property
    def files(self) -> list[str]:
        """Repo-relative POSIX paths: git's view (tracked + untracked, not ignored) when it is a git checkout."""
        out: list[str] = []
        if (self.root / ".git").exists():
            p = subprocess.run(["git", "-C", str(self.root), "ls-files", "-z", "--cached", "--others",
                                "--exclude-standard"], capture_output=True, check=False, timeout=60)
            if p.returncode == 0:
                out = [f for f in p.stdout.decode("utf-8", "replace").split("\0") if f]
                return sorted({f for f in out if not (set(f.split("/")[:-1]) & SKIP_DIRS)})[:MAX_FILES]
        for dirpath, dirs, names in os.walk(self.root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            rel = Path(dirpath).relative_to(self.root)
            out.extend((rel / n).as_posix() for n in sorted(names))
            if len(out) >= MAX_FILES:
                break
        return out[:MAX_FILES]

    @cached_property
    def fileset(self) -> frozenset[str]:
        return frozenset(self.files)

    def has(self, *names: str) -> bool:
        """Any of these exact paths, or file names anywhere (`"Dockerfile"`, `"package.json"`)."""
        want = set(names)
        return any(f in want or f.rsplit("/", 1)[-1] in want for f in self.files)

    def ext(self, *exts: str) -> list[str]:
        return [f for f in self.files if f.lower().endswith(exts)]

    def named(self, *names: str) -> list[str]:
        return [f for f in self.files if f.rsplit("/", 1)[-1] in names]

    def path(self, rel: str) -> Path | None:
        """The file, only when it resolves inside the checkout (a symlink to /etc/passwd is not ours to read)."""
        p = (self.root / rel)
        try:
            r = p.resolve()
        except OSError:
            return None
        return r if r.is_relative_to(self.root) and r.is_file() else None

    def size(self, rel: str) -> int:
        p = self.path(rel)
        try:
            return p.stat().st_size if p else 0
        except OSError:
            return 0

    def text(self, rel: str) -> str | None:
        """Decoded text, or None for binaries, unreadable or oversized files."""
        if rel not in self._text:
            val = None
            p = self.path(rel)
            if p is not None:
                try:
                    if p.stat().st_size <= MAX_READ:
                        raw = p.read_bytes()
                        if b"\0" not in raw[:8192]:
                            val = raw.decode("utf-8", "replace")
                except OSError:
                    pass
            self._text[rel] = val
        return self._text[rel]

    def lines(self, rel: str) -> Iterator[tuple[int, str]]:
        t = self.text(rel)
        if t is not None:
            yield from enumerate(t.splitlines(), 1)

    @cached_property
    def package_json(self) -> dict:
        t = self.text("package.json") if "package.json" in self.fileset else None
        try:
            return json.loads(t) if t else {}
        except ValueError:
            return {}

    def npm_script(self, name: str) -> bool:
        return isinstance(self.package_json.get("scripts"), dict) and name in self.package_json["scripts"]

    def node_dep(self, name: str) -> bool:
        pj = self.package_json
        return any(isinstance(pj.get(k), dict) and name in pj[k] for k in ("dependencies", "devDependencies"))

    @cached_property
    def python(self) -> str | None:
        from ..runtime.pytest_run import RuntimeErrorReport, python_for

        try:
            return python_for(self.root, self.repo)
        except RuntimeErrorReport:
            return None

    def resolve_tool(self, tool: str) -> str | None:
        """The repo's own copy first (venv, node_modules/.bin), then Aftershock's tool prefix, then PATH. Filesystem
        lookups only: nothing runs."""
        from ..runtime.setup import node_bin

        cands = []
        if self.python:
            cands.append(Path(self.python).parent / tool)
        cands.append(self.root / "node_modules" / ".bin" / tool)
        cands.append(node_bin() / tool)  # where the Install button puts Node tools (D29)
        for c in cands:
            if c.is_file() and os.access(c, os.X_OK):
                return str(c)
        return shutil.which(tool)

    def has_module(self, module: str) -> bool | None:
        """Is `module` installed in the repo's interpreter? Looked up on disk; None when that can't be told."""
        if not self.python:
            return False
        env = Path(self.python).parent.parent
        sp = glob.glob(str(env / "lib" / "python3*" / "site-packages"))
        if not sp:
            return None
        return any((Path(d) / module).exists() or glob.glob(str(Path(d) / f"{module}-*.dist-info")) for d in sp)


def scripts() -> list[Script]:
    _load()
    return sorted(REGISTRY.values(), key=lambda s: (list(CATEGORIES).index(s.category), s.ecosystem, s.id))


def _load() -> None:
    # Import all three every time: importing one module elsewhere first must not leave the others unregistered.
    from . import commands, graph_checks, probes, static  # noqa: F401  registration happens on import (once each)


def _available(s: Script, ctx: Ctx) -> bool | None:
    if s.kind != "command":
        return True
    if s.pytest_mode or s.tool == "pytest" or (s.argv and s.argv[:3] == ("{python}", "-m", "pytest")):
        return ctx.has_module("pytest")
    if s.argv[:2] == ("{python}", "-m") and s.tool:
        return ctx.has_module(s.tool.replace("-", "_"))
    if (s.argv[:1] == ("{python}",) or s.runner) and not s.tool:
        return ctx.python is not None
    return ctx.resolve_tool(s.tool) is not None if s.tool else True


def install_for(s: Script, ctx: Ctx) -> dict | None:
    """How to get a missing script runnable (D29): `setup` (the repo has no test interpreter yet, or the script
    needs pytest), a `pip`/`npm` recipe, or a `manual` hint for tools that need the system package manager."""
    from ..runtime.setup import recipe_for

    python_tool = s.pytest_mode or s.runner or (s.argv[:1] == ("{python}",))
    if python_tool and (ctx.python is None or s.tool in (None, "pytest")):
        return {"method": "setup", "package": "", "hint": "set up the test environment"}
    r = recipe_for(s.tool)
    if r is None:
        return None
    if r.method == "pip" and ctx.python is None:
        return {"method": "setup", "package": r.package, "hint": "set up the test environment, then install"}
    return {**r.as_dict(), "tool": s.tool}


def _checkout(repo: str) -> tuple[object, Path]:
    g = T._graph(repo)
    root = Path(T._repo_props(g).get("root") or "")
    if not root.is_dir():
        raise T.ToolError("the indexed checkout is no longer on disk; re-index it")
    T.allowed_path(root)
    return g, root


def listing(repo: str, *, q: str | None = None, category: str | None = None, ecosystem: str | None = None,
            applicable_only: bool = False) -> dict:
    """The catalog for `repo`: every script, with `applies` (the files it looks at exist here) and `available`
    (its tool is installed; null when that can't be told without running anything)."""
    g, root = _checkout(repo)
    ctx = Ctx(root, repo, g)
    words = [w for w in (q or "").lower().split() if w]
    rows = []
    for s in scripts():
        if category and s.category != category or ecosystem and s.ecosystem != ecosystem:
            continue
        hay = " ".join((s.id, s.name, s.summary, s.category, s.ecosystem, *s.tags)).lower()
        if words and not all(w in hay for w in words):
            continue
        try:
            applies = bool(s.applies(ctx))
        except Exception:  # noqa: BLE001 -- a broken manifest makes a script not apply, not the listing fail
            applies = False
        if applicable_only and not applies:
            continue
        available = _available(s, ctx) if applies else None
        rows.append({**s.meta(), "applies": applies, "available": available,
                     "install": install_for(s, ctx) if available is False else None})
    by_cat: dict[str, int] = {}
    for r in rows:
        if r["applies"]:
            by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
    return {"scripts": rows, "total": len(REGISTRY), "applicable": sum(r["applies"] for r in rows),
            "categories": [{"id": k, "label": v, "applicable": by_cat.get(k, 0)} for k, v in CATEGORIES.items()],
            "files_scanned": len(ctx.files),
            "env": {"python": ctx.python is not None, "pytest": bool(ctx.has_module("pytest"))}}


def pick(ids: list[str], *, allow_exec: bool) -> list[Script]:
    """Validate a selection: known ids, no duplicates, within the cap, and no `command` unless allowed."""
    _load()
    if not ids:
        raise T.ToolError("pick at least one script")
    if len(ids) > MAX_SELECT:
        raise T.ToolError(f"at most {MAX_SELECT} scripts per run")
    out, seen = [], set()
    for i in ids:
        s = REGISTRY.get(i)
        if s is None:
            raise T.NotFound(f"no built-in script {i!r}; list them with `test_scripts`")
        if s.id in seen:
            continue
        if s.executes and not allow_exec:
            raise T.ToolError(f"{s.id} executes code; run it from the Tests page or `aftershock scripts run` on a "
                              "machine started with AFTERSHOCK_ALLOW_RUN=1")
        seen.add(s.id)
        out.append(s)
    return out


def run(repo: str, ids: list[str], emit: Emit | None = None, *, allow_exec: bool = False,
        cancel: threading.Event | None = None, timeout: int | None = None, trigger: str | None = None) -> dict:
    """Run the picked scripts one after another. Emits `start`, then `script` (running) and `result` per script.
    With `trigger`, the batch is recorded (`run_id` in the result) so the Tests page can show it later."""
    emit = emit or (lambda kind, data: None)
    chosen = pick(ids, allow_exec=allow_exec)
    g, root = _checkout(repo)
    ctx = Ctx(root, repo, g)
    emit("start", {"scripts": [s.id for s in chosen]})
    results, t0 = [], time.monotonic()
    for s in chosen:
        if cancel is not None and cancel.is_set():
            break
        emit("script", {"id": s.id, "status": "running"})
        res = run_one(s, ctx, emit=emit, cancel=cancel, timeout=timeout)
        results.append(res)
        emit("result", res)
    counts = {k: sum(r["status"] == k for r in results) for k in ("passed", "warned", "failed", "error", "skipped")}
    out = {"results": results, **counts, "seconds": round(time.monotonic() - t0, 3),
           "stopped": len(results) < len(chosen)}
    if trigger:
        try:
            out["run_id"] = record(repo, out, trigger)
        except Exception:  # noqa: BLE001 -- results already streamed; losing the record must not lose them
            log.exception("could not record the script run for %s", repo)
    return out


RUNS_KEEP = 20


def record(repo: str, res: dict, trigger: str = "web") -> str | None:
    """Keep a finished batch in the repo's graph (D29), so its results are still there when the page is reopened.
    Output tails are cut to what the page shows; the last RUNS_KEEP batches are kept."""
    from ..runtime.runs import new_id

    if not res.get("results"):
        return None
    rid = new_id()
    rows = [{**r, "output_tail": (r.get("output_tail") or "")[-2000:], "findings": (r.get("findings") or [])[:50]}
            for r in res["results"]]
    props = {"id": rid, "started": int(time.time() - (res.get("seconds") or 0)), "seconds": res.get("seconds", 0),
             "scripts": len(rows), "trigger": trigger, "stopped": bool(res.get("stopped")),
             **{k: res.get(k, 0) for k in ("passed", "warned", "failed", "error", "skipped")},
             "results": json.dumps(rows, default=str)}
    g = T._graph(repo)
    g.rw("script_run_upsert", {"id": rid, "props": props})
    g.rw("script_run_prune", {"keep": RUNS_KEEP})
    return rid


def history(repo: str, limit: int = 10) -> dict:
    return {"runs": T._graph(repo).ro("script_runs", {"limit": max(1, min(int(limit), RUNS_KEEP))})}


def recorded(repo: str, run_id: str) -> dict:
    rows = T._graph(repo).ro("script_run", {"id": run_id})
    if not rows:
        raise T.NotFound(f"no script run {run_id}")
    run = dict(rows[0]["run"])
    try:
        run["results"] = json.loads(run.get("results") or "[]")
    except ValueError:
        run["results"] = []
    return run


def run_one(s: Script, ctx: Ctx, *, emit: Emit | None = None, cancel: threading.Event | None = None,
            timeout: int | None = None) -> dict:
    base = {"id": s.id, "name": s.name, "category": s.category, "kind": s.kind}
    t0 = time.monotonic()
    try:
        if not s.applies(ctx):
            return {**base, "status": "skipped", "reason": "does not apply to this repository", "seconds": 0.0,
                    "findings": [], "count": 0}
        if s.kind == "command":
            out = _command(s, ctx, emit=emit, cancel=cancel, timeout=timeout or s.timeout)
        else:
            found: list[Finding] = []
            for f in s.fn(ctx):
                found.append(f)
                if len(found) > 5000:
                    break
            status = "passed" if not found else {"error": "failed", "warn": "warned"}.get(s.severity, "passed")
            out = {"status": status, "findings": [f.as_dict() for f in found[:MAX_FINDINGS]], "count": len(found)}
    except T.ToolError as e:
        out = {"status": "error", "reason": str(e), "findings": [], "count": 0}
    except Exception as e:  # noqa: BLE001 -- one broken script must not end the batch
        out = {"status": "error", "reason": f"{type(e).__name__}: {str(e)[:300]}", "findings": [], "count": 0}
    return {**base, **out, "seconds": round(time.monotonic() - t0, 3)}


# ---- command scripts -------------------------------------------------------------------------------------------------

# `path:line[:col]: message` (ruff, flake8, mypy, go vet, shellcheck -f gcc, eslint -f unix, ...) and tsc's
# `path(line,col): message`
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)")
_LOC = re.compile(r"^(?P<file>[^\s:()][^:()]*?)(?::(?P<line>\d+)(?::\d+)?:|\((?P<tline>\d+),\d+\):)\s*(?P<msg>.+)$")


def _findings_from(output: str, ctx: Ctx) -> list[Finding]:
    out = []
    for raw in output.splitlines():
        m = _LOC.match(raw.strip())
        if not m:
            continue
        f = m["file"]
        if f.startswith(str(ctx.root)):
            f = f[len(str(ctx.root)):].lstrip("/")
        f = f.removeprefix("./")
        if f not in ctx.fileset:
            continue
        out.append(Finding(f, int(m["line"] or m["tline"]), m["msg"].strip()))
    return out


def scrubbed_env() -> dict[str, str]:
    from ..runtime.pytest_run import child_env

    env = child_env()
    env.pop("FORCE_COLOR", None)  # some tools read any value, even 0, as "force colour on"
    env.update({"CI": "1", "NO_COLOR": "1", "TERM": "dumb", "PYTHONDONTWRITEBYTECODE": "1",
                "npm_config_yes": "false", "NPM_CONFIG_UPDATE_NOTIFIER": "false"})
    return env


def _command(s: Script, ctx: Ctx, *, emit: Emit | None, cancel: threading.Event | None, timeout: int) -> dict:
    from .commands import expand

    if s.pytest_mode:
        return _pytest(s, ctx, emit=emit, cancel=cancel, timeout=timeout)
    avail = _available(s, ctx)
    if s.runner is not None:
        if avail is False:
            return {"status": "skipped", "reason": f"{s.tool or 'an interpreter'} is not installed for this repo; "
                                                   "set up its test environment", "findings": [], "count": 0,
                    "install": install_for(s, ctx)}
        return s.runner(ctx, emit=emit, cancel=cancel, timeout=timeout)
    if avail is False:
        need = s.tool or "an interpreter"
        return {"status": "skipped", "reason": f"{need} is not installed for this repo; use Install on the Tests "
                                               "page or `aftershock setup`", "findings": [], "count": 0,
                "install": install_for(s, ctx)}
    argv = []
    for a in s.argv:
        if a == "{python}":
            if not ctx.python:
                return {"status": "skipped", "reason": "no interpreter for this repo; set up its test environment",
                        "findings": [], "count": 0}
            argv.append(ctx.python)
        elif a == "{tool}":
            argv.append(ctx.resolve_tool(s.tool or "") or s.tool or "")
        elif (many := expand(a, ctx)) is not None:
            if not many:
                return {"status": "skipped", "reason": "no matching files", "findings": [], "count": 0}
            argv.extend(many)
        else:
            argv.append(a)
    rc, output, why = execute(argv, ctx, cancel=cancel, timeout=timeout)
    if rc is None and why and why.startswith("could not start"):
        return {"status": "error", "reason": why, "findings": [], "count": 0}
    found = _findings_from(output, ctx)
    status = "error" if why else ("passed" if rc == 0 else "failed")
    res = {"status": status, "exit_code": rc, "command": " ".join(_display(argv, ctx)),
           "findings": [f.as_dict() for f in found[:MAX_FINDINGS]], "count": len(found),
           "output_tail": output[-OUTPUT_TAIL:]}
    if why:
        res["reason"] = why
    return res


def execute(argv: list[str], ctx: Ctx, *, cancel: threading.Event | None, timeout: float,
            env: dict[str, str] | None = None) -> tuple[int | None, str, str | None]:
    """Run one process in the checkout (no shell, scrubbed env, own process group, bounded output) and return
    (exit code, output without colour codes, why it was cut short or could not start)."""
    t0 = time.monotonic()
    try:
        p = subprocess.Popen(argv, cwd=ctx.root, env={**scrubbed_env(), **(env or {})}, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as e:
        return None, "", f"could not start {Path(argv[0]).name}: {e.strerror}"
    chunks: list[bytes] = []
    size = [0]

    def pump():
        for line in iter(p.stdout.readline, b""):  # type: ignore[union-attr]
            chunks.append(line)
            size[0] += len(line)
            while size[0] > 400_000 and len(chunks) > 1:  # keep a bounded tail, not the whole log
                size[0] -= len(chunks.pop(0))

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    why = None
    while p.poll() is None:
        if cancel is not None and cancel.is_set():
            why = "stopped"
        elif time.monotonic() - t0 > timeout:
            why = f"timed out after {int(timeout)}s"
        if why:
            _kill(p)
            break
        time.sleep(0.1)
    p.wait()
    reader.join(5)
    return p.returncode, _ANSI.sub("", b"".join(chunks).decode("utf-8", "replace")), why


def _display(argv: list[str], ctx: Ctx) -> list[str]:
    """Paths shown relative to the checkout, so a result doesn't print the server's directory layout."""
    root = str(ctx.root) + "/"
    return [a.replace(root, "") for a in argv]


def _kill(p: subprocess.Popen) -> None:
    try:
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        with contextlib.suppress(ProcessLookupError):
            os.killpg(p.pid, signal.SIGKILL)


def _pytest(s: Script, ctx: Ctx, *, emit: Emit | None, cancel: threading.Event | None, timeout: int) -> dict:
    """The pytest modes go through the normal run path, so they are recorded in the graph and get culprits."""
    from ..runtime import jobs
    from ..runtime.pytest_run import RuntimeErrorReport

    def fwd(kind: str, data: dict) -> None:
        if emit and kind == "test":
            emit("test", {"script": s.id, **data})

    try:
        res = jobs.run_tests(ctx.repo, s.pytest_mode or "all", fwd, cancel=cancel, timeout=timeout)
    except RuntimeErrorReport as e:
        return {"status": "error", "reason": str(e)[-1500:], "findings": [], "count": 0}
    failed = res.get("failed") or 0
    finds = [Finding(c.get("file", ""), c.get("line"), f"suspect #{i + 1}: {c.get('id', '')}")
             for i, c in enumerate(((res.get("culprits") or {}).get("suspects") or [])[:10])]
    status = ("failed" if failed or res.get("exit_code") not in (0, 5, None) else "passed")
    return {"status": status, "exit_code": res.get("exit_code"), "run_id": res.get("run_id"),
            "summary": {k: res.get(k) for k in ("selected", "passed", "failed", "skipped", "suite_tests", "edges",
                                                "symbols_covered") if res.get(k) is not None},
            "findings": [f.as_dict() for f in finds], "count": failed,
            "output_tail": res.get("output_tail") or res.get("note") or ""}


def brief(res: dict, *, findings: int = 8, tail: int = 1200) -> dict:
    """A run result sized for a model's context: counts, and per script its status, a few findings, and the end
    of any tool output."""
    rows = []
    for r in res["results"]:
        row = {k: r[k] for k in ("id", "status", "count") if k in r}
        for k in ("reason", "exit_code", "run_id", "summary"):
            if r.get(k) not in (None, ""):
                row[k] = r[k]
        if r.get("findings"):
            row["findings"] = [f"{f['file']}:{f['line']}: {f['message']}" if f.get("line") else
                               f"{f['file'] or '(repo)'}: {f['message']}" for f in r["findings"][:findings]]
        if r.get("output_tail") and r["status"] in ("failed", "error"):
            row["output_tail"] = r["output_tail"][-tail:]
        rows.append(row)
    return {**{k: res[k] for k in ("passed", "warned", "failed", "error", "skipped", "seconds", "stopped")},
            "results": rows}
