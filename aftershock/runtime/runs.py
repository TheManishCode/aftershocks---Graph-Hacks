"""Test runs as graph facts (D25): every run `aftershock run`, the API and `heal` perform is written to the repo's graph.

    (:TestRun {id, mode, trigger, started, seconds, passed, failed, skipped, exit_code, commit, ...})
    (TestRun)-[:RAN {outcome, seconds, message}]->(Symbol test)     one edge per test symbol (parametrized cases fold)
    (TestRun)-[:SUSPECTS {rank, score, hops}]->(Symbol)              the culprit ranking of its failures
    (TestRun)-[:RETRY_OF]->(TestRun)                                 a heal re-run after an edit, back to the run it fixes

So a failure stays queryable after the terminal scrolls away: the Culprit page opens a run by id, MCP clients read
`test_runs` / `run_detail`, and a test's outcome history across runs is one hop. The full culprit report (with the
call chain from each failing test to each suspect) is kept on the run as JSON, because chains are lists of edges,
which a node property cannot hold. Only the last `KEEP` runs are kept.
"""

from __future__ import annotations

import json
import secrets
import subprocess
import time
from pathlib import Path

from ..graph import GraphUnavailable, RepoGraph
from .pytest_run import Outcome, node_to_symbol

KEEP = 50
MAX_FAILURES = 100
MAX_MESSAGE = 1500
_ORDER = {"failed": 0, "passed": 1, "skipped": 2}


def new_id() -> str:
    return f"{int(time.time() * 1000):x}{secrets.token_hex(2)}"


def _commit(root: Path | None) -> str:
    if root is None:
        return ""
    p = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    return p.stdout.strip() if p.returncode == 0 else ""


def fold(results: list[dict]) -> dict[str, dict]:
    """{test symbol id: {outcome, seconds, message}} from pytest rows: a failure in any phase or parametrized case
    makes the symbol failed; otherwise passed if any case passed."""
    out: dict[str, dict] = {}
    for r in results:
        sid = node_to_symbol(r["nodeid"])
        cur = out.setdefault(sid, {"test": sid, "outcome": r["outcome"], "seconds": 0.0, "message": ""})
        cur["seconds"] = round(cur["seconds"] + (r.get("seconds") or 0.0), 4)
        if _ORDER.get(r["outcome"], 3) < _ORDER.get(cur["outcome"], 3):
            cur["outcome"] = r["outcome"]
        if r["outcome"] == "failed" and not cur["message"]:
            cur["message"] = (r.get("message") or "")[-MAX_MESSAGE:]
    return out


def record(g: RepoGraph, out: Outcome, *, mode: str, trigger: str = "run", root: Path | None = None,
           culprits: dict | None = None, changed: list[str] | None = None, selected: int | None = None,
           parent: str | None = None, extra: dict | None = None) -> str:
    """Write one run (its outcome per test, its suspects, its link to the run it retries) and return its id."""
    rid = new_id()
    by = out.by_outcome()
    failed = out.failed
    folded = fold(out.results)
    failures = [{"nodeid": r["nodeid"], "test": node_to_symbol(r["nodeid"]), "when": r.get("when"),
                 "message": (r.get("message") or "")[-MAX_MESSAGE:]} for r in failed[:MAX_FAILURES]]
    props = {
        "id": rid, "mode": mode, "trigger": trigger, "started": int(time.time() - out.seconds),
        "seconds": out.seconds, "exit_code": out.exit_code, "passed": len(by.get("passed", [])),
        "failed": len(failed), "skipped": len(by.get("skipped", [])), "tests": len(folded),
        "selected": selected if selected is not None else len(folded), "commit": _commit(root),
        "failures": json.dumps(failures), "changed": json.dumps((changed or [])[:200]),
        "output_tail": out.stdout_tail[-3000:] if failed or out.exit_code not in (0, 5) else "",
        "culprits": json.dumps(culprits) if culprits else "",
        **(extra or {}),
    }
    try:
        g.rw("idx_testrun")
    except GraphUnavailable:
        raise
    except Exception as e:  # already indexed
        if "already" not in str(e).lower():
            raise
    g.rw("run_upsert", {"id": rid, "props": props})
    rows = list(folded.values())
    for i in range(0, len(rows), 1000):
        g.rw("run_link_ran", {"id": rid, "rows": rows[i : i + 1000]})
    sus = [{"id": s["id"], "rank": n, "score": s["score"], "hops": s["hops"]}
           for n, s in enumerate((culprits or {}).get("suspects", []), 1)]
    if sus:
        g.rw("run_link_suspects", {"id": rid, "rows": sus})
    if parent:
        g.rw("run_link_retry", {"id": rid, "parent": parent})
    g.rw("run_prune", {"keep": KEEP})
    return rid


def _loads(v, default):
    try:
        return json.loads(v) if v else default
    except ValueError:
        return default


def _summary(row: dict) -> dict:
    r = dict(row["run"])
    for k in ("failures", "changed", "culprits", "output_tail", "heal_rounds"):
        r.pop(k, None)
    return {**r, "parent": row.get("parent")}


def list_runs(g: RepoGraph, limit: int = 20) -> list[dict]:
    return [_summary(r) for r in g.ro("runs", {"limit": max(1, min(int(limit), KEEP))})]


def detail(g: RepoGraph, run_id: str) -> dict | None:
    """One run with its failures, its culprit report (chains included), every test outcome and its heal lineage."""
    rows = g.ro("run", {"id": run_id})
    if not rows:
        return None
    run = dict(rows[0]["run"])
    out = {**_summary(rows[0]),
           "failures": _loads(run.get("failures"), []), "changed": _loads(run.get("changed"), []),
           "culprits": _loads(run.get("culprits"), None), "output_tail": run.get("output_tail", ""),
           "heal_rounds": _loads(run.get("heal_rounds"), []),
           "results": g.ro("run_results", {"id": run_id, "limit": 5000}),
           "retries": [r["id"] for r in g.ro("run_children", {"id": run_id})]}
    failing = [f["test"] for f in out["failures"]]
    if failing:  # flaky or chronic? the same tests in earlier runs (not heal re-runs: those ran edited code)
        hist: dict[str, list[str]] = {}
        for h in g.ro("test_history", {"ids": sorted(set(failing))[:50], "limit": 2000}):
            if h["run"] != run_id:
                hist.setdefault(h["test"], []).append(h["outcome"])
        out["history"] = {t: {"runs": len(v), "failed": v.count("failed")} for t, v in hist.items()}
    return out
