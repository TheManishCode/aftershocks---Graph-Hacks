"""Test runs driven from the API (D18): the same steps as `aftershock run` / `coverage`, reported as events.

`run_tests` executes the repo's own code, so the API only calls it when `AFTERSHOCK_ALLOW_RUN` is set and the client
is on loopback, and MCP only on a local stdio server started with the same flag (D26); never the HTTP /mcp mount or
the Ask agent. Every run is recorded in the graph (runtime/runs.py, D25), and `heal_run` takes a recorded failing run
to the Claude fix loop (analysis/heal.py) behind the same gate. Selected runs are measured (per-test coverage) when
the repo's interpreter has `coverage`, so a failure is ranked on what its tests actually executed (D26).
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from pathlib import Path

from .. import tools as T
from ..ingest.discover import libraries
from . import runs
from .pytest_run import node_to_symbol, python_for, record_coverage, run_measured

MODES = ("diff", "targets", "all", "coverage")
Emit = Callable[[str, dict], None]


def _checkout(repo: str):
    g = T._graph(repo)
    props = T._repo_props(g)
    root = Path(props.get("root") or "")
    if not root.is_dir():
        raise T.ToolError("the indexed checkout is no longer on disk; re-index it")
    T.allowed_path(root)
    return g, root, libraries(props)


def run_tests(repo: str, mode: str, emit: Emit, *, targets: list[str] | None = None, rev: str | None = None,
              cancel: threading.Event | None = None, timeout: int = 1800) -> dict:
    """Select (per `mode`), run with per-test events, rank culprits when anything fails, and record the run in the
    graph. Returns the summary, with `run_id` for every mode but coverage."""
    if mode not in MODES:
        raise T.ToolError(f"mode must be one of {', '.join(MODES)}")
    if mode == "targets" and not targets:
        raise T.ToolError("pick at least one symbol to select tests for")
    g, root, libs = _checkout(repo)
    python = python_for(root, repo)
    total = len(g.ro("tests"))
    emit("start", {"mode": mode, "python": python, "suite_tests": total, "libraries": sorted(libs)})

    def on_result(row: dict) -> None:
        emit("test", {k: row.get(k) for k in ("nodeid", "when", "outcome", "seconds", "message")})

    if mode == "coverage":
        summary = record_coverage(g, root, python, timeout=timeout, on_result=on_result, cancel=cancel, libs=libs,
                                  progress=lambda stage, info: emit("progress", {"stage": stage, **info}))
        return {"mode": mode, **summary}

    sel: dict = {}
    if mode == "all":
        out, sel["coverage"] = run_measured(g, root, python, None, timeout, on_result=on_result, cancel=cancel,
                                            libs=libs)
    else:
        sel = T.select_tests(repo, targets if mode == "targets" else None, rev, diff_mode=mode == "diff")
        ids = [t["id"] for t in sel["tests"]]
        emit("selected", {"count": len(ids), "suite_tests": total, "files": sel["files"], "note": sel.get("note"),
                          "untested_seeds": sel.get("untested_seeds", []), "seed_ids": sel.get("seed_ids", []),
                          "runtime_tests": sel.get("runtime_tests", 0), "tests": sel["tests"][:2000]})
        if not ids:
            return {"mode": mode, "selected": 0, "passed": 0, "failed": 0, "skipped": 0, "seconds": 0.0,
                    "exit_code": 5, "note": sel.get("note")}
        out, cov = run_measured(g, root, python, ids, timeout, on_result=on_result, cancel=cancel, libs=libs)
        sel["coverage"] = cov

    by = out.by_outcome()
    failed = out.failed
    res = {"mode": mode, "selected": len(sel["tests"]) if "tests" in sel else None, "suite_tests": total,
           "exit_code": out.exit_code, "seconds": out.seconds, "passed": len(by.get("passed", [])),
           "failed": len(failed), "skipped": len(by.get("skipped", [])),
           "measured": bool(sel.get("coverage"))}
    if out.exit_code not in (0, 1, 5):  # 2 = interrupted / collection errors: the log is the only explanation
        res["output_tail"] = out.stdout_tail[-1500:]
    changed = (sel.get("seed_ids") or None) if sel else None
    if failed:
        emit("progress", {"stage": "culprits", "failing": len(failed)})
        res["culprits"] = T.run(T.culprits, repo, sorted({node_to_symbol(r["nodeid"]) for r in failed}), changed, 10)
    emit("progress", {"stage": "record"})
    res["run_id"] = runs.record(g, out, mode=mode, root=root, culprits=res.get("culprits"), changed=changed,
                                selected=res["selected"], extra={"measured": res["measured"]})
    return res


def heal_run(repo: str, run_id: str, emit: Emit, *, max_rounds: int = 3, timeout: int = 1800) -> dict:
    """Re-run a recorded failing run's tests and, when they still fail, let Claude fix the top suspect with the
    graph's evidence as context, re-verify, and keep only a strict improvement (analysis/heal.py). Each run it makes
    is recorded RETRY_OF the one before, starting from `run_id`."""
    from ..analysis import heal

    g, root, libs = _checkout(repo)
    base = runs.detail(g, run_id)
    if base is None:
        raise T.NotFound(f"no recorded run {run_id!r}")
    if not base.get("failed"):
        raise T.ToolError("that run has no failing tests to fix")
    api_key = os.environ.get("ANTHROPIC_API_KEY") or heal.cli_backend()
    if not api_key:
        raise T.ToolError("neither ANTHROPIC_API_KEY nor the claude CLI is available to the server")
    python = python_for(root, repo)
    ids = sorted({r["test"] for r in base["results"]} | {f["test"] for f in base["failures"]})
    changed = base.get("changed") or None

    def recorder(out, info: dict) -> str:
        failed = out.failed
        cul = (T.run(T.culprits, repo, sorted({node_to_symbol(r["nodeid"]) for r in failed}), changed, 10)
               if failed else None)
        extra = {"heal_step": info.get("step", ""), "heal_round": info.get("round", 0),
                 "heal_suspect": info.get("suspect", ""), "heal_diff": info.get("diff", ""),
                 "heal_why": info.get("why", ""), "measured": bool(info.get("measured"))}
        return runs.record(g, out, mode="heal", trigger="heal", root=root, culprits=cul, changed=changed,
                           parent=info.get("parent") or run_id, extra=extra)

    emit("start", {"run": run_id, "tests": len(ids), "model": heal.FIX_MODEL, "backend":
                   "claude-cli" if api_key == heal.CLI_BACKEND else "api"})
    rep = heal.heal(g, root, python, ids, changed, apply=True, anthropic_api_key=api_key, max_rounds=max_rounds,
                    timeout=timeout, libs=libs, emit=emit, recorder=recorder, measure=True)
    return rep.as_dict()
