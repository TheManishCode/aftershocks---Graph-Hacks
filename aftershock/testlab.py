"""Testlab: end-to-end scenarios with known answers, run through the whole product.

A suite (`testlab/scenarios/<name>.toml`) names a fixture repo under `testlab/repos/` and a list of scenarios. Each
scenario is one code change (find/replace edits, or a file swapped for a buggy twin) plus what must follow from it.
For every scenario the runner drives the same path a user does:

    index (once per suite) → change the working tree → diff → impact → select tests
    → run the whole suite (ground truth) → run only the selected tests → rank culprits → restore

and scores each step against the expectation. A check a scenario declares as a known gap (`gaps.<check> = "why"`)
is reported apart: it documents a limit instead of failing the run, and flags when the limit is gone.

Runs repo code (the fixture's own tests), so it is CLI-only like `coverage`/`run`/`mutate`.
"""

from __future__ import annotations

import shutil
import sys
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from . import tools as T
from .config import get_settings
from .graph import get_store
from .ingest.pipeline import index_repo
from .runtime.pytest_run import node_to_symbol, record_coverage, run_pytest, run_selected

LAB = Path(__file__).resolve().parent.parent / "testlab"
CHECKS = ("changes", "impacted", "not_impacted", "selected", "max_selected", "truth", "selection", "rerun", "culprit")


class ScenarioError(ValueError):
    """The scenario itself is malformed (an edit that doesn't apply, a missing bug file)."""


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    gap: str = ""  # declared known limit; a failing gap check doesn't fail the scenario

    @property
    def status(self) -> str:
        if self.gap:
            return "gap-fixed" if self.ok else "gap"
        return "pass" if self.ok else "fail"


@dataclass
class Scenario:
    id: str
    title: str
    edits: list[dict]
    expect: dict
    gaps: dict[str, str] = field(default_factory=dict)
    why: str = ""


def suites() -> list[str]:
    return sorted(p.stem for p in (LAB / "scenarios").glob("*.toml"))


def load(name: str) -> tuple[dict, list[Scenario]]:
    path = LAB / "scenarios" / f"{name}.toml"
    if not path.is_file():
        raise T.NotFound(f"no suite {name!r}; have {', '.join(suites())}")
    spec = tomllib.loads(path.read_text())
    out = [Scenario(s["id"], s.get("title", s["id"]), s.get("edit", []), s.get("expect", {}), s.get("gaps", {}),
                    s.get("why", "")) for s in spec.get("scenario", [])]
    gen = spec.get("generate")
    if gen:  # one scenario per buggy twin: swap the file, expect its own tests to fail and its function to rank first
        for bug in sorted((LAB / gen["bugs"]).glob("*.py")):
            n = bug.stem
            fmt = {"name": n}
            out.append(Scenario(
                f"{name}-{n}", f"real bug in {n}", [{"file": gen["target"].format(**fmt), "swap": str(bug)}],
                {"culprit": gen["culprit"].format(**fmt), "culprit_top": gen.get("culprit_top", 1),
                 "failing_in": gen["failing_in"].format(**fmt), "changes": []},
                {k: v for k, v in gen.get("gaps", {}).get(n, {}).items()}))
    return spec, out


def _apply(root: Path, edits: list[dict]) -> dict[Path, bytes]:
    """Apply every edit or none: a failing later edit restores the earlier ones, so the next scenario starts clean."""
    saved: dict[Path, bytes] = {}
    try:
        for e in edits:
            p = root / e["file"]
            if not p.is_file():
                raise ScenarioError(f"{e['file']} does not exist")
            saved.setdefault(p, p.read_bytes())
            text = p.read_text()
            if "swap" in e:
                text = Path(e["swap"]).read_text()
            else:
                n = text.count(e["find"])
                if n != 1:
                    raise ScenarioError(f"edit to {e['file']}: `find` occurs {n} times, need exactly 1")
                text = text.replace(e["find"], e.get("replace", ""))
            p.write_text(text)
    except BaseException:
        _restore(saved)
        raise
    return saved


def _restore(saved: dict[Path, bytes]) -> None:
    for p, data in saved.items():
        p.write_bytes(data)


def _failing(out) -> set[str]:
    return {node_to_symbol(r["nodeid"]) for r in out.failed}


def _missing(want: list[str], have: set[str]) -> list[str]:
    return [w for w in want if w not in have]


def _rank(ranked: list[str], culprit: str) -> int | None:
    """1-based rank of the culprit, or of a function nested in it (`f.helper`): naming the inner function the bug
    is in is more precise, not wrong."""
    for i, r in enumerate(ranked, 1):
        if r == culprit or r.startswith(culprit + "."):
            return i
    return None


def run_scenario(repo: str, root: Path, sc: Scenario, *, python: str | None, suite_tests: int) -> dict:
    ex = sc.expect
    checks: list[Check] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append(Check(name, ok, detail, sc.gaps.get(name, "")))

    t0 = time.perf_counter()
    saved = _apply(root, sc.edits)
    try:
        d = T.diff_impact(repo)
        imp = d.get("impact") or {}
        changes = {f"{c['change']}:{c['id']}" for c in d["changes"]["symbols"]}
        impacted = {r["id"] for r in imp.get("impacted", [])}
        sel = T.select_tests(repo, diff_mode=True)
        selected = {t["id"] for t in sel["tests"]}
        seeds = sel.get("seed_ids") or []
        if ex.get("changes"):
            miss = _missing(ex["changes"], changes)
            check("changes", not miss, f"missing {miss}; detected {sorted(changes)}" if miss else f"{len(changes)} detected")
        if ex.get("impacted"):
            miss = _missing(ex["impacted"], impacted)
            check("impacted", not miss, f"missing {miss}" if miss else f"{len(impacted)} impacted")
        if ex.get("not_impacted"):
            wrong = [x for x in ex["not_impacted"] if x in impacted]
            check("not_impacted", not wrong, f"wrongly impacted {wrong}" if wrong else "")
        if ex.get("selected"):
            miss = _missing(ex["selected"], selected)
            check("selected", not miss, f"missing {miss}" if miss else f"{len(selected)} selected")
        if "max_selected" in ex:
            check("max_selected", len(selected) <= ex["max_selected"], f"{len(selected)} selected")

        truth: set[str] = set()
        rerun_failed: set[str] = set()
        ranked: list[str] = []
        if python:
            full = run_pytest(root, python, [], timeout=600)
            truth = _failing(full)
            if "failing" in ex:
                want = set(ex["failing"])
                check("truth", truth == want, "" if truth == want else
                      f"suite failed {sorted(truth)}, scenario expects {sorted(want)}")
            if "failing_in" in ex:
                stray = sorted(t for t in truth if not t.startswith(ex["failing_in"]))
                check("truth", bool(truth) and not stray,
                      "no test failed" if not truth else (f"failures outside {ex['failing_in']}: {stray}" if stray
                                                           else f"{len(truth)} failing"))
            if truth:
                caught = truth & selected
                check("selection", caught == truth,
                      f"selected {len(caught)}/{len(truth)} failing tests"
                      + (f"; missed {sorted(truth - caught)[:5]}" if caught != truth else ""))
                rerun_failed = _failing(run_selected(root, python, sorted(selected), timeout=600)) if selected else set()
                check("rerun", rerun_failed == caught,
                      f"selected run failed {len(rerun_failed)}, expected {len(caught)}")
                if ex.get("culprit"):
                    res = T.culprits(repo, sorted(truth), seeds or None, 10)
                    ranked = [r["id"] for r in res.get("suspects", [])]
                    k = ex.get("culprit_top", 3)
                    rank = _rank(ranked, ex["culprit"])
                    check("culprit", rank is not None and rank <= k,
                          f"rank {rank or '>10'} (need ≤{k}); top {ranked[:3]}")
            else:
                rerun_failed = set()
    finally:
        _restore(saved)
    rank = _rank(ranked, ex["culprit"]) if ex.get("culprit") else None
    return {
        "id": sc.id, "title": sc.title, "why": sc.why,
        "ok": all(c.ok for c in checks if not c.gap),
        "checks": [{"name": c.name, "status": c.status, "detail": c.detail, **({"gap": c.gap} if c.gap else {})}
                   for c in checks],
        "changes": sorted(changes), "impacted": len(impacted), "risk": (imp.get("risk") or {}).get("level"),
        "selected": len(selected), "suite_tests": suite_tests, "failing": sorted(truth),
        "caught": len(truth & selected), "culprit_rank": rank, "seconds": round(time.perf_counter() - t0, 2),
    }


def run_suite(name: str, *, python: str | None = None, only: str | None = None, keep: bool = False,
              progress=None) -> dict:
    spec, scenarios = load(name)
    if only:
        scenarios = [s for s in scenarios if only in s.id]
    src = LAB / "repos" / spec["repo"]
    repo = f"testlab-{spec['repo']}"
    root = (get_settings().cache_dir.parent / "testlab" / spec["repo"]).resolve()
    shutil.rmtree(root, ignore_errors=True)
    shutil.copytree(src, root, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    store = get_store()
    t0 = time.perf_counter()
    if progress:
        progress("index", {"suite": name, "repo": repo})
    rep = index_repo(root, repo, full=True, with_history=False)
    store.set_lab(repo, True)
    py = (python or sys.executable) if spec.get("run", True) else None
    out: dict = {"suite": name, "repo": spec["repo"], "description": spec.get("description", ""),
                 "index": {"files": rep.files, "symbols": rep.symbols, "edges": rep.edges}, "runtime": py is not None}
    try:
        suite_tests = 0
        if py:
            base = run_pytest(root, py, [], timeout=600)
            suite_tests = len({node_to_symbol(r["nodeid"]) for r in base.results})
            out["baseline"] = {"tests": suite_tests, "failed": sorted(_failing(base)), "seconds": base.seconds}
            if base.failed:
                raise ScenarioError(f"{name}: the fixture suite fails before any change: {sorted(_failing(base))[:5]}")
            if spec.get("coverage"):
                out["coverage"] = {k: v for k, v in record_coverage(store.repo(repo), root, py).items()
                                   if k in ("tests_run", "edges", "seconds")}
        rows = []
        for sc in scenarios:
            if progress:
                progress("scenario", {"id": sc.id})
            try:
                rows.append(run_scenario(repo, root, sc, python=py, suite_tests=suite_tests))
            except ScenarioError as e:
                rows.append({"id": sc.id, "title": sc.title, "ok": False, "error": str(e), "checks": []})
        out["scenarios"] = rows
        out["summary"] = summarize(rows)
        out["seconds"] = round(time.perf_counter() - t0, 1)
    finally:
        if not keep:
            store.set_lab(repo, False)
            store.drop_repo(repo)
            shutil.rmtree(root, ignore_errors=True)
    return out


def summarize(rows: list[dict]) -> dict:
    statuses = [c["status"] for r in rows for c in r.get("checks", [])]
    failing = sum(len(r.get("failing", [])) for r in rows)
    caught = sum(r.get("caught", 0) for r in rows)
    ranked = [r for r in rows if any(c["name"] == "culprit" for c in r.get("checks", []))]
    shares = [r["selected"] / r["suite_tests"] for r in rows if r.get("suite_tests") and r.get("failing")]
    return {
        "scenarios": len(rows), "passed": sum(1 for r in rows if r["ok"]),
        "checks": {s: statuses.count(s) for s in ("pass", "fail", "gap", "gap-fixed")},
        "errors": sum(1 for r in rows if r.get("error")),
        "selection_recall": round(caught / failing, 3) if failing else None,
        "selected_share": round(sum(shares) / len(shares), 3) if shares else None,
        "culprit_top1": round(sum(1 for r in ranked if r["culprit_rank"] == 1) / len(ranked), 3) if ranked else None,
        "culprit_top3": round(sum(1 for r in ranked if (r["culprit_rank"] or 99) <= 3) / len(ranked), 3)
        if ranked else None,
    }


def run(names: list[str] | None = None, **kw) -> dict:
    results = [run_suite(n, **kw) for n in (names or suites())]
    return {"suites": results, "ok": all(s["summary"]["passed"] == s["summary"]["scenarios"] for s in results)}
