"""Mutation evaluation: break a function for real, run the whole suite, and check whether test selection would
have caught it.

The history replay (analysis/evaluate.py) scores against co-change, a weak proxy for "broke". Here the ground truth
is the set of tests that actually fail. Each mutant inserts `raise RuntimeError` at the top of one function's body in
a scratch copy of the repo, so the original checkout is never edited. For every mutant that some test kills, a
selector is scored on recall (share of the failing tests it selected), whether it caught the break at all (selected
at least one failing test) and how many tests it asked to run.

Caveat, stated in every report: a raise at function entry fails exactly the tests that execute the function, which
is what per-test coverage records. Coverage-based selection is therefore close to perfect here by construction; the
informative numbers are static selection's and the baseline's, and the share of mutants no test kills.
"""

from __future__ import annotations

import ast
import random
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..analysis.culprit import _tests_reaching
from ..analysis.impact import Seed, simulate
from ..config import get_settings
from ..graph import RepoGraph
from .pytest_run import RuntimeErrorReport, node_to_symbol, run_pytest

MARK = "raise RuntimeError('aftershock mutant')"
IGNORE = shutil.ignore_patterns(".git", ".venv", "node_modules", "__pycache__", ".aftershock", ".mypy_cache",
                                ".pytest_cache", ".ruff_cache", ".tox", ".nox")


def _mutate(text: str, line: int) -> str | None:
    """Insert MARK as the first statement (after any docstring) of the function defined on `line`."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.lineno == line:
            body = node.body
            first = body[1] if (len(body) > 1 and isinstance(body[0], ast.Expr)
                                and isinstance(body[0].value, ast.Constant)
                                and isinstance(body[0].value.value, str)) else body[0]
            if first.lineno == node.lineno or (len(body) == 1 and isinstance(first, ast.Expr)
                                               and isinstance(first.value, ast.Constant)):
                return None  # one-liner, or a docstring-only / `...` stub
            lines = text.splitlines(keepends=True)
            at = first.lineno - 1
            if first.col_offset > len(lines[at]) - len(lines[at].lstrip()):
                return None  # statement shares a line with something else (`x = 1; y`)
            indent = lines[at][: first.col_offset]
            return "".join(lines[:at] + [f"{indent}{MARK}\n"] + lines[at:])
    return None


def _module_name(path: str) -> str:
    parts = path[:-3].split("/")
    if parts[0] == "src":
        parts = parts[1:]
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _candidates(g: RepoGraph) -> list[dict]:
    rows = g.ro(None, query="""
        MATCH (s:Symbol) WHERE s.kind IN ['function', 'method'] AND NOT s.is_test AND s.file ENDS WITH '.py'
              AND s.end_line > s.line
        RETURN s.id AS id, s.file AS file, s.line AS line, s.decorators AS decorators ORDER BY s.id""")
    skip = ("overload", "abstractmethod")
    return [r for r in rows if not any(str(d).split("(")[0].rsplit(".", 1)[-1] in skip for d in r["decorators"] or [])
            and "/tests/" not in f"/{r['file']}" and not r["file"].rsplit("/", 1)[-1].startswith(("test_", "conftest"))]


def _score(selected: set[str], failing: set[str]) -> dict:
    hit = selected & failing
    return {"recall": len(hit) / len(failing), "caught": bool(hit), "selected": len(selected)}


def evaluate(g: RepoGraph, root: Path, python: str, n: int = 30, seed: int = 7, depth: int | None = None,
             timeout: int = 900, progress=None) -> dict:
    tests = g.ro("tests")
    total_tests = len(tests)
    by_file: dict[str, set[str]] = {}
    for t in tests:
        stem = t["file"].rsplit("/", 1)[-1][:-3]
        by_file.setdefault(stem, set()).add(t["id"])
    covered = bool(g.ro(None, query="MATCH ()-[e:COVERS]->() RETURN count(e) AS n")[0]["n"])
    pool = _candidates(g)
    rng = random.Random(seed)  # noqa: S311 - reproducible sampling, not security
    picks = rng.sample(pool, min(n, len(pool)))
    with tempfile.TemporaryDirectory(prefix="aftershock-mut-") as tmp:
        work = Path(tmp) / "repo"
        shutil.copytree(root, work, ignore=IGNORE, symlinks=True)
        extra = [work / "src", work] if (work / "src").is_dir() else [work]
        # The copy must shadow any installed (e.g. editable) copy of the package, or mutants would never run.
        mod = _module_name(picks[0]["file"]) if picks else ""
        if mod:
            env_path = ":".join(str(p) for p in extra)
            p = subprocess.run([python, "-c", f"import {mod} as m; print(m.__file__)"], cwd=work, capture_output=True,
                               text=True, check=False, env={"PYTHONPATH": env_path, "PATH": "/usr/bin:/bin"})
            if p.returncode == 0 and not p.stdout.strip().startswith(str(work)):
                raise RuntimeErrorReport(f"{mod} imports from {p.stdout.strip()}, not the scratch copy; "
                                         "mutants would not run")
        if progress:
            progress("baseline", {"mutants": len(picks), "candidates": len(pool)})
        base = run_pytest(work, python, [], extra_path=extra, timeout=timeout)
        broken_before = {r["nodeid"] for r in base.failed}
        rows = []
        for i, c in enumerate(picks, 1):
            path = work / c["file"]
            original = path.read_text(encoding="utf-8")
            mutated = _mutate(original, c["line"])
            if mutated is None:
                rows.append({"id": c["id"], "status": "skipped", "why": "no body to mutate"})
                continue
            path.write_text(mutated, encoding="utf-8")
            try:
                out = run_pytest(work, python, [], extra_path=extra, timeout=timeout)
            finally:
                path.write_text(original, encoding="utf-8")
            failing = {node_to_symbol(r["nodeid"]) for r in out.failed if r["nodeid"] not in broken_before}
            row = {"id": c["id"], "status": "killed" if failing else "survived", "failing": len(failing),
                   "seconds": out.seconds}
            if failing:
                static = simulate(g, [Seed(c["id"], "body")], depth=depth, runtime=False)
                # what `select_tests` runs: the probable tests plus any test that statically reaches the change
                reach = _tests_reaching(g, [c["id"]], depth or get_settings().max_depth)[c["id"]]
                row["static"] = _score({t["id"] for t in static["tests"]} | reach, failing)
                if covered:
                    dyn = simulate(g, [Seed(c["id"], "body")], depth=depth, runtime=True)
                    row["coverage"] = _score({t["id"] for t in dyn["tests"]}, failing)
                stem = c["file"].rsplit("/", 1)[-1][:-3].lstrip("_")
                row["same_name"] = _score(by_file.get(f"test_{stem}", set()), failing)
            rows.append(row)
            if progress:
                progress("mutant", {"done": i, "total": len(picks), "status": row["status"]})
    killed = [r for r in rows if r["status"] == "killed"]
    summary = {}
    for name in ("static", "coverage", "same_name"):
        scored = [r[name] for r in killed if name in r]
        if scored:
            summary[name] = {
                "mutants": len(scored),
                "recall": round(sum(s["recall"] for s in scored) / len(scored), 3),
                "caught": round(sum(s["caught"] for s in scored) / len(scored), 3),
                "selected": round(sum(s["selected"] for s in scored) / len(scored), 1),
                "suite_share": round(sum(s["selected"] for s in scored) / len(scored) / max(total_tests, 1), 4),
            }
    tried = [r for r in rows if r["status"] != "skipped"]
    return {
        "mutants": len(tried), "killed": len(killed), "survived": len(tried) - len(killed),
        "skipped": len(rows) - len(tried), "tests_in_graph": total_tests, "pre_failing": len(broken_before),
        "coverage_recorded": covered, "selectors": summary, "rows": rows, "seed": seed,
        "note": "Ground truth: tests that fail when the function raises on entry (whole suite, scratch copy). "
                "Survived = no test noticed the function was broken. Coverage selection is near-perfect on this "
                "mutant by construction; compare static against same_name, and read survived as untested code.",
    }
