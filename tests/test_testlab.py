"""The testlab end to end: known-answer scenarios through index → diff → impact → select → run → culprit.

Ledger (9 hand-written scenarios) and inventory (TypeScript, static) run whole; QuixBugs runs one real bug here
because its full 40 take minutes (`aftershock testlab quixbugs`).
"""

from __future__ import annotations

import pytest

from aftershock import testlab
from aftershock.testlab import ScenarioError, _apply, _rank, _restore

from .conftest import needs_graph


def test_every_suite_loads():
    assert {"ledger", "inventory", "quixbugs"} <= set(testlab.suites())
    for name in testlab.suites():
        spec, scenarios = testlab.load(name)
        assert scenarios and (testlab.LAB / "repos" / spec["repo"]).is_dir()
        assert len({s.id for s in scenarios}) == len(scenarios)


def test_quixbugs_generates_one_scenario_per_bug():
    _, scenarios = testlab.load("quixbugs")
    assert len(scenarios) == len(list((testlab.LAB / "bugs" / "quixbugs").glob("*.py"))) == 40
    assert all(s.expect["failing_in"] == f"tests/test_{s.id[9:]}.py" for s in scenarios)


def test_edits_apply_exactly_once_and_restore(tmp_path):
    f = tmp_path / "m.py"
    f.write_text("a = 1\nb = 1\n")
    saved = _apply(tmp_path, [{"file": "m.py", "find": "a = 1", "replace": "a = 2"}])
    assert f.read_text() == "a = 2\nb = 1\n"
    _restore(saved)
    assert f.read_text() == "a = 1\nb = 1\n"
    with pytest.raises(ScenarioError, match="2 times"):
        _apply(tmp_path, [{"file": "m.py", "find": " = 1", "replace": ""}])


def test_culprit_rank_accepts_a_nested_function():
    ranked = ["m.py::f.helper", "m.py::f", "m.py::fx"]
    assert _rank(ranked, "m.py::f") == 1
    assert _rank(ranked, "m.py::fx") == 3
    assert _rank(ranked, "m.py::g") is None


@needs_graph
@pytest.mark.parametrize("suite", ["ledger", "inventory"])
def test_suite_passes(suite):
    res = testlab.run_suite(suite)
    bad = [(r["id"], r.get("error") or [c for c in r["checks"] if c["status"] == "fail"])
           for r in res["scenarios"] if not r["ok"]]
    assert not bad, bad
    s = res["summary"]
    assert s["errors"] == 0 and s["checks"]["fail"] == 0
    if res["runtime"]:
        assert s["selection_recall"] == 1.0 and s["culprit_top1"] == 1.0


@needs_graph
def test_a_real_quixbugs_bug_is_selected_and_ranked_first():
    res = testlab.run_suite("quixbugs", only="quixbugs-gcd")
    (row,) = res["scenarios"]
    assert row["ok"], row["checks"]
    assert row["caught"] == len(row["failing"]) > 0 and row["culprit_rank"] == 1
