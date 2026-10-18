"""Drive pytest in the target repo's own interpreter, record per-test coverage into the graph, run selected tests.

Per-test coverage is the technique behind Datadog Test Impact Analysis and pytest-testmon: coverage.py dynamic
contexts label each executed line with the running test. Here those lines are folded onto the graph's function and
method spans, giving (test)-[:COVERS]->(symbol) edges. They are runtime facts, so they see what static resolution
cannot (duck typing, fixtures, registries), but only for code the suite actually runs.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..config import get_settings
from ..graph import RepoGraph
from ..ingest.discover import LIB_PREFIX, library_dirs

HERE = Path(__file__).parent
PLUGIN = "_aftershock_pytest"


class RuntimeErrorReport(RuntimeError):
    """A test run could not be performed (no interpreter, pytest missing, timeout)."""


def python_for(root: Path, repo: str, explicit: str | None = None) -> str:
    """The interpreter that can import the repo and its test deps: --python, the repo's .venv, or a bench env."""
    for cand in ([Path(explicit)] if explicit else []) + [root / ".venv" / "bin" / "python",
                                                          get_settings().env_dir / repo / "bin" / "python"]:
        if cand.is_file():
            return str(cand.absolute())
    raise RuntimeErrorReport(
        f"no interpreter for {repo}: pass --python, create {root / '.venv'}, or run "
        f"`python scripts/bench_env.py {repo}` for a benchmark repo")


def node_to_symbol(nodeid: str) -> str:
    """`tests/test_x.py::TestA::test_b[p-1]` -> `tests/test_x.py::TestA.test_b` (the graph's symbol id)."""
    head = nodeid.split("[", 1)[0]
    file, _, rest = head.partition("::")
    return f"{file}::{rest.replace('::', '.')}" if rest else file


def symbol_to_node(sid: str) -> str:
    file, _, q = sid.partition("::")
    if not q or q == "<module>":
        return file
    # pytest collects functions and Test* classes, not what is nested in a function: `test_a.helper` runs as `test_a`
    # (an id pytest cannot find aborts the WHOLE run with "not found", so one nested name would hide every result).
    out = []
    for part in re.sub(r"#\d+", "", q).split("."):
        out.append(part)
        if not part.startswith("Test"):
            break
    return file + "::" + "::".join(out)


@dataclass
class Outcome:
    exit_code: int
    seconds: float
    results: list[dict] = field(default_factory=list)
    stdout_tail: str = ""

    def by_outcome(self) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        for r in self.results:
            out.setdefault(r["outcome"], []).append(r)
        return out

    @property
    def failed(self) -> list[dict]:
        seen, rows = set(), []
        for r in self.results:
            if r["outcome"] == "failed" and r["nodeid"] not in seen:
                seen.add(r["nodeid"])
                rows.append(r)
        return rows


def run_pytest(root: Path, python: str, args: list[str], *, coverage_file: Path | None = None,
               extra_path: list[Path] | None = None, timeout: int = 1800, on_result=None,
               cancel: threading.Event | None = None, aliases: dict[str, str] | None = None,
               append: bool = False) -> Outcome:
    """Run pytest in `root` with our plugin; with `coverage_file`, under per-test coverage (`append` adds to it).

    `on_result(row)` is called with each outcome row as the plugin writes it (live streaming); setting `cancel`
    kills the run, which then raises `RuntimeErrorReport`. `aliases` ({directory: graph prefix}, see
    `discover.library_dirs`) rewrites the nodeids of tests outside `root` to their graph paths.
    """
    with tempfile.TemporaryDirectory(prefix="aftershock-run-") as tmp:
        results = Path(tmp) / "results.jsonl"
        env = {k: v for k, v in os.environ.items() if not k.startswith(("AFTERSHOCK_", "COVERAGE_"))}
        env["AFTERSHOCK_RESULTS"] = str(results)
        env["PYTHONPATH"] = os.pathsep.join([*(str(p) for p in extra_path or []), str(HERE),
                                             *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        pytest = ["-m", "pytest", "-p", PLUGIN, "-p", "no:cacheprovider", "--rootdir", str(root), "-q",
                  "--no-header", *args]
        if coverage_file is not None:
            rc = Path(tmp) / "coveragerc"
            # our own config: the repo's [tool.coverage] may set parallel/omit/source in ways that break the read-back
            rc.write_text(f"[run]\nsource = {root}\nomit =\n    */.venv/*\n    */site-packages/*\n"
                          f"    */node_modules/*\n")
            cmd = [python, "-m", "coverage", "run", f"--rcfile={rc}", f"--data-file={coverage_file}",
                   *(["--append"] if append else []), *pytest]
        else:
            cmd = [python, *pytest]
        log = Path(tmp) / "output.log"
        t0 = time.perf_counter()
        rows: list[dict] = []
        with log.open("w") as sink:
            p = subprocess.Popen(cmd, cwd=root, env=env, stdout=sink, stderr=subprocess.STDOUT, text=True,
                                 start_new_session=True)
            seen = 0
            try:
                while True:
                    done = p.poll() is not None
                    seen = _drain(results, seen, rows, on_result, aliases)
                    if done:
                        break
                    if cancel is not None and cancel.is_set():
                        raise RuntimeErrorReport("run cancelled")
                    if time.perf_counter() - t0 > timeout:
                        raise RuntimeErrorReport(f"tests did not finish within {timeout}s")
                    time.sleep(0.1)
            finally:
                if p.poll() is None:
                    _kill(p)
        tail = log.read_text(errors="replace")[-3000:]
        out = Outcome(p.returncode, round(time.perf_counter() - t0, 2), rows, tail)
    if p.returncode in (3, 4) or (p.returncode == 1 and not rows and "No module named" in out.stdout_tail):
        raise RuntimeErrorReport(f"pytest could not run (exit {p.returncode}):\n{out.stdout_tail[-1200:]}")
    return out


def _alias(row: dict, aliases: dict[str, str]) -> dict:
    path = row.get("path") or ""
    for d, prefix in aliases.items():
        if path.startswith(d + os.sep):
            _, sep, rest = row["nodeid"].partition("::")
            row["raw"] = row["nodeid"]  # what pytest (and a coverage context) calls it
            row["nodeid"] = prefix + Path(path).relative_to(d).as_posix() + sep + rest
            break
    return row


def _drain(results: Path, offset: int, rows: list[dict], on_result, aliases: dict[str, str] | None = None) -> int:
    """Read whole lines the plugin appended since `offset`; a partly written last line waits for the next poll."""
    if not results.exists():
        return offset
    with results.open("rb") as f:
        f.seek(offset)
        chunk = f.read()
    end = chunk.rfind(b"\n") + 1
    for ln in chunk[:end].decode(errors="replace").splitlines():
        if ln.strip():
            rows.append(row := _alias(json.loads(ln), aliases or {}))
            if on_result:
                on_result(row)
    return offset + end


def _kill(p: subprocess.Popen) -> None:
    """Stop pytest and anything it spawned (its own session/process group)."""
    try:
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        with contextlib.suppress(ProcessLookupError):
            os.killpg(p.pid, signal.SIGKILL)
        p.wait()


def record_coverage(g: RepoGraph, root: Path, python: str, args: list[str] | None = None,
                    timeout: int = 1800, progress=None, on_result=None,
                    cancel: threading.Event | None = None, libs: dict[str, str] | None = None) -> dict:
    """Run the whole suite (then each registered test library, unless `args` picks tests) under per-test coverage
    and replace the graph's COVERS edges with the result."""
    probe = subprocess.run([python, "-c", "import coverage, pytest"], capture_output=True, text=True, check=False)
    if probe.returncode != 0:
        raise RuntimeErrorReport(f"{python} needs `coverage` and `pytest` installed: {probe.stderr.strip()[-300:]}")
    with tempfile.TemporaryDirectory(prefix="aftershock-cov-") as tmp:
        data = Path(tmp) / ".coverage"
        if progress:
            progress("tests", {"python": python})
        run = run_pytest(root, python, args or [], coverage_file=data, timeout=timeout, on_result=on_result,
                         cancel=cancel)
        dirs = [str(Path(d).resolve()) for d in (libs or {}).values() if Path(d).is_dir()] if not args else []
        if dirs and data.exists():
            more = run_pytest(root, python, dirs, coverage_file=data, timeout=timeout, on_result=on_result,
                              cancel=cancel, aliases=library_dirs(libs or {}), append=True)
            run = Outcome(run.exit_code if run.exit_code not in (0, 5) else more.exit_code,
                          round(run.seconds + more.seconds, 2), run.results + more.results,
                          (run.stdout_tail + "\n" + more.stdout_tail)[-3000:])
        if not data.exists():
            raise RuntimeErrorReport(f"coverage wrote no data (pytest exit {run.exit_code}):\n{run.stdout_tail[-800:]}")
        if progress:
            progress("map", {})
        edges, unmatched, mapped, spans = _map_coverage(g, root, python, data, run.results)
    g.rw("drop_coverage")
    g.batched("link_covers", [{"src": a, "dst": b, "runs": n} for (a, b), n in edges.items()])
    by = run.by_outcome()
    summary = {
        "tests_run": len({r["nodeid"] for r in run.results if r["when"] == "call"}),
        "passed": len(by.get("passed", [])), "failed": len(run.failed), "skipped": len(by.get("skipped", [])),
        "contexts": len(mapped["contexts"]), "unmatched_tests": unmatched, "edges": len(edges),
        "symbols_covered": len({b for _, b in edges}), "spans": spans, "files_measured": mapped["files"],
        "seconds": run.seconds, "recorded_at": int(time.time()), "commit": _head(root),
    }
    g.rw("upsert_repo", {"name": g.name, "props": {f"coverage_{k}": v for k, v in summary.items()}})
    return summary


def _head(root: Path) -> str:
    p = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    return p.stdout.strip() if p.returncode == 0 else ""


_DEFAULT_TEST_FILE = re.compile(r"(^|/)(test_[^/]*|[^/]*_test)\.py$")


def _configured(root: Path, key: str) -> bool:
    """Does the repo's pytest config set `key` (then its own patterns apply, and we do not second-guess them)?"""
    for name in ("pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"):
        f = root / name
        with contextlib.suppress(OSError):
            if f.is_file() and re.search(rf"^\s*{key}\s*=", f.read_text(errors="replace"), re.MULTILINE):
                return True
    return False


def run_all(root: Path, python: str, *, libs: dict[str, str] | None = None, timeout: int = 1800, on_result=None,
            cancel: threading.Event | None = None, coverage_file: Path | None = None) -> Outcome:
    """The whole suite as the repo configures it, then each registered test library, as one outcome."""
    out = run_pytest(root, python, [], timeout=timeout, on_result=on_result, cancel=cancel, coverage_file=coverage_file)
    dirs = [d for d in (libs or {}).values() if Path(d).is_dir()]
    if not dirs:
        return out
    more = run_pytest(root, python, [str(Path(d).resolve()) for d in dirs], timeout=timeout, on_result=on_result,
                      cancel=cancel, aliases=library_dirs(libs or {}), coverage_file=coverage_file,
                      append=coverage_file is not None and coverage_file.exists())
    code = out.exit_code if out.exit_code not in (0, 5) else more.exit_code if more.exit_code not in (0, 5) else min(
        out.exit_code, more.exit_code)
    return Outcome(code, round(out.seconds + more.seconds, 2), out.results + more.results,
                   (out.stdout_tail + "\n" + more.stdout_tail)[-3000:])


def _map_coverage(g: RepoGraph, root: Path, python: str, data: Path, results: list[dict]
                  ) -> tuple[dict[tuple[str, str], int], int, dict, int]:
    """Per-test coverage data -> {(test id, symbol id): hits}, mapped through the graph's symbol spans."""
    files = [r["path"] for r in g.ro("file_index") if r["path"].endswith(".py")]
    spans = g.ro("spans", {"files": files})
    ids = [r["id"] for r in spans]
    ranges: dict[str, list[list[int]]] = {}
    for i, r in enumerate(spans):
        if r["line"] and r["end_line"] and r["end_line"] > r["line"]:
            # the `def` line runs when the function is *defined*, so it belongs to the enclosing scope
            ranges.setdefault(r["file"], []).append([r["line"] + 1, r["end_line"], i])
    with tempfile.TemporaryDirectory(prefix="aftershock-covmap-") as tmp:
        sym_json, out_json = Path(tmp) / "spans.json", Path(tmp) / "pairs.json"
        sym_json.write_text(json.dumps(ranges))
        p = subprocess.run([python, str(HERE / "_aftershock_covread.py"), str(data), str(root), str(sym_json),
                            str(out_json)], capture_output=True, text=True, check=False, timeout=600)
        if p.returncode != 0:
            raise RuntimeErrorReport(f"could not read coverage data: {p.stderr[-800:]}")
        mapped = json.loads(out_json.read_text())
    known = {r["id"] for r in g.ro("tests")}
    graph_node = {r["raw"]: r["nodeid"] for r in results if "raw" in r}  # library tests: `../x` -> `@lib/...`
    edges: dict[tuple[str, str], int] = {}
    unmatched = 0
    for ci, syms in mapped["pairs"].items():
        ctx = mapped["contexts"][int(ci)]
        test = node_to_symbol(graph_node.get(ctx, ctx))
        if test not in known:
            unmatched += 1
            continue
        for si in syms:
            if ids[si] != test:
                edges[(test, ids[si])] = edges.get((test, ids[si]), 0) + 1
    return edges, unmatched, mapped, len(ids)


_COVERAGE_OK: dict[str, bool] = {}


def can_measure(python: str) -> bool:
    """Can this interpreter run tests under per-test coverage? (Cached; a missing `coverage` just means static.)"""
    if python not in _COVERAGE_OK:
        p = subprocess.run([python, "-c", "import coverage, pytest"], capture_output=True, text=True, check=False)
        _COVERAGE_OK[python] = p.returncode == 0
    return _COVERAGE_OK[python]


def run_measured(g: RepoGraph, root: Path, python: str, test_ids: list[str] | None, timeout: int = 1800, *,
                 on_result=None, cancel: threading.Event | None = None,
                 libs: dict[str, str] | None = None) -> tuple[Outcome, dict | None]:
    """`run_selected` (or `run_all` when `test_ids` is None) under per-test coverage when the interpreter has
    `coverage` (D26), so the culprit ranking of a failure uses what each test actually executed without a separate
    coverage pass. Only the COVERS edges of the tests that ran are replaced; the rest of the recorded coverage stays.
    Returns (outcome, coverage summary or None when it ran unmeasured)."""
    def go(data: Path | None) -> Outcome:
        if test_ids is None:
            return run_all(root, python, libs=libs, timeout=timeout, on_result=on_result, cancel=cancel,
                           coverage_file=data)
        return run_selected(root, python, test_ids, timeout, on_result=on_result, cancel=cancel, libs=libs,
                            coverage_file=data)

    if not can_measure(python):
        return go(None), None
    with tempfile.TemporaryDirectory(prefix="aftershock-cov-") as tmp:
        data = Path(tmp) / ".coverage"
        out = go(data)
        if not data.exists() or not out.results:
            return out, None
        try:
            edges, unmatched, _, _ = _map_coverage(g, root, python, data, out.results)
        except RuntimeErrorReport:
            return out, None  # the run itself stands; the ranking falls back to static reach
    tests = sorted({node_to_symbol(r["nodeid"]) for r in out.results})
    g.batched("drop_coverage_of", tests, key="ids")
    g.batched("link_covers", [{"src": a, "dst": b, "runs": n} for (a, b), n in edges.items()])
    return out, {"tests": len(tests), "edges": len(edges), "unmatched_tests": unmatched}


def run_selected(root: Path, python: str, test_ids: list[str], timeout: int = 1800, *, on_result=None,
                 cancel: threading.Event | None = None, libs: dict[str, str] | None = None,
                 coverage_file: Path | None = None) -> Outcome:
    """Run the tests a change selected (graph symbol ids), deduplicated to pytest node ids. Tests of a registered
    test library (`@lib/<name>/...`, see `discover.libraries`) run from the library's directory on disk."""
    nodes = sorted({symbol_to_node(t) for t in test_ids})
    if not _configured(root, "python_files"):  # a file named explicitly is collected even if pytest would skip it:
        # tests/typing/check_x.py is a type-check sample, and importing it can fail the whole run
        nodes = [n for n in nodes if _DEFAULT_TEST_FILE.search(n.split("::", 1)[0])]
    if not nodes:
        return Outcome(0, 0.0)
    if len(nodes) > 2000:  # keep the command line bounded; whole files are a superset
        nodes = sorted({n.split("::", 1)[0] for n in nodes})
    dirs = {f"{LIB_PREFIX}{k}/": str(Path(v).resolve()) for k, v in (libs or {}).items()}
    args = []
    for n in nodes:
        lib = next((p for p in dirs if n.startswith(p)), None)
        if lib is None and n.startswith(LIB_PREFIX):
            continue  # its library was removed since indexing
        args.append(f"{dirs[lib]}/{n[len(lib):]}" if lib else n)
    if not args:
        return Outcome(0, 0.0)
    return run_pytest(root, python, args, timeout=timeout, on_result=on_result, cancel=cancel,
                      aliases=library_dirs(libs or {}), coverage_file=coverage_file)

