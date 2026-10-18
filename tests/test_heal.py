"""Unit tests for aftershock.analysis.heal, run without FalkorDB or a model.

`run_selected` (the real runtime layer) is exercised for real against a tiny on-disk fixture
(fixtures/heal_repo): a genuine subprocess + output-parsing round trip, not a mock, using this interpreter the same
way `aftershock run`/`aftershock heal` would use the repo's own `.venv` python. The orchestration loop (`heal`) is
tested against a stub graph and a monkeypatched `tools.culprits` / `_propose_fix`, since those need a live FalkorDB
graph and a model respectively -- but the file-write, revert, and re-run behavior around them is real.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

from aftershock.analysis import heal

FIXTURE = Path(__file__).parent / "fixtures" / "heal_repo"
PY = sys.executable


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    dest = tmp_path / "heal_repo"
    shutil.copytree(FIXTURE, dest)
    return dest


class FakeGraph:
    name = "fake"


def test_extract_code_block_takes_the_first_fenced_block():
    text = "Here is the fix:\n```python\nprint(1)\n```\nDone."
    assert heal._extract_code_block(text) == "print(1)\n"


def test_extract_code_block_returns_none_without_a_fence():
    assert heal._extract_code_block("I can't fix this without seeing another file.") is None


def test_heal_reports_all_passed_without_touching_claude(repo: Path, monkeypatch):
    (repo / "calc.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")

    def boom(*a, **k):
        raise AssertionError("_propose_fix must not be called when tests already pass")

    monkeypatch.setattr(heal, "_propose_fix", boom)
    report = heal.heal(FakeGraph(), repo, PY, ["test_calc.py::test_add"], None, apply=True,
                       anthropic_api_key="sk-fake")
    assert report.verdict == "all_passed"


def test_heal_dry_run_never_calls_claude_or_writes(repo: Path, monkeypatch):
    before = (repo / "calc.py").read_text()

    def boom(*a, **k):
        raise AssertionError("_propose_fix must not be called when apply=False")

    monkeypatch.setattr(heal, "_propose_fix", boom)
    report = heal.heal(FakeGraph(), repo, PY, ["test_calc.py::test_add"], None, apply=False,
                       anthropic_api_key="sk-fake")
    assert report.verdict == "unresolved"
    assert (repo / "calc.py").read_text() == before  # untouched


def test_heal_dry_run_without_api_key_also_refuses(repo: Path, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("_propose_fix must not be called without an API key")

    monkeypatch.setattr(heal, "_propose_fix", boom)
    report = heal.heal(FakeGraph(), repo, PY, ["test_calc.py::test_add"], None, apply=True,
                       anthropic_api_key=None)
    assert report.verdict == "unresolved"
    assert "ANTHROPIC_API_KEY" in report.note


def test_heal_applies_a_real_fix_and_reruns_to_confirm(repo: Path, monkeypatch):
    def fake_culprits(repo_name, failing, changed, limit=15):
        return {"suspects": [{"id": "calc.py::add", "name": "add", "file": "calc.py", "line": 2, "score": 1.0,
                              "failed": 1, "passed": 0}]}

    def fake_propose(api_key, model, test_output, suspect, file_text):
        return "def add(a, b):\n    return a + b\n", "fixed the operator"

    monkeypatch.setattr(heal.T, "culprits", fake_culprits)
    monkeypatch.setattr(heal, "_propose_fix", fake_propose)
    report = heal.heal(FakeGraph(), repo, PY, ["test_calc.py::test_add"], None, apply=True,
                       anthropic_api_key="sk-fake")
    assert report.verdict == "fixed"
    assert len(report.rounds) == 1
    assert report.rounds[0].outcome == "fixed"
    assert (repo / "calc.py").read_text() == "def add(a, b):\n    return a + b\n"


def test_heal_reverts_a_fix_that_does_not_help(repo: Path, monkeypatch):
    before = (repo / "calc.py").read_text()

    def fake_culprits(repo_name, failing, changed, limit=15):
        return {"suspects": [{"id": "calc.py::add", "name": "add", "file": "calc.py", "line": 2, "score": 1.0,
                              "failed": 1, "passed": 0}]}

    def fake_propose(api_key, model, test_output, suspect, file_text):
        return "def add(a, b):\n    return a * b\n", "tried multiplication, also wrong"  # still fails

    monkeypatch.setattr(heal.T, "culprits", fake_culprits)
    monkeypatch.setattr(heal, "_propose_fix", fake_propose)
    report = heal.heal(FakeGraph(), repo, PY, ["test_calc.py::test_add"], None, apply=True,
                       anthropic_api_key="sk-fake", max_rounds=1)
    assert report.verdict == "unresolved"
    assert report.rounds[0].reverted is True
    assert (repo / "calc.py").read_text() == before  # reverted, not left half-fixed


def test_heal_with_no_tests_selected(repo: Path):
    report = heal.heal(FakeGraph(), repo, PY, [], None, apply=True, anthropic_api_key="sk-fake")
    assert report.verdict == "no_tests"


def test_heal_does_not_call_a_run_where_nothing_ran_green(repo: Path):
    """A selected file with nothing pytest collects (exit 5) runs nothing; that must not read as "all passed"."""
    (repo / "test_empty.py").write_text("HELPER = 1\n", encoding="utf-8")
    report = heal.heal(FakeGraph(), repo, PY, ["test_empty.py::<module>"], None, apply=True,
                       anthropic_api_key="sk-fake")
    assert report.verdict == "no_tests"
    assert "ran no tests" in report.note



def test_heal_widens_a_green_selection_before_calling_it_green(repo: Path):
    """The selected tests pass but a test further from the change fails: run that one before saying "all passed"."""
    (repo / "test_near.py").write_text("def test_near():\n    assert True\n", encoding="utf-8")
    (repo / "test_far.py").write_text("def test_far():\n    assert False\n", encoding="utf-8")
    report = heal.heal(FakeGraph(), repo, PY, ["test_near.py::test_near"], None, apply=False,
                       anthropic_api_key=None, widen=lambda: ["test_near.py::test_near", "test_far.py::test_far"])
    assert report.widened == 1
    assert report.initial["failing"] == ["test_far.py::test_far"]
    assert report.verdict == "unresolved"
    green = heal.heal(FakeGraph(), repo, PY, ["test_near.py::test_near"], None, apply=False,
                      anthropic_api_key=None, widen=lambda: [])
    assert green.verdict == "all_passed" and green.widened == 0

def test_heal_keeps_a_partial_fix_and_narrows_on_the_next_round(repo: Path, monkeypatch):
    """calc.py has two bugs; a one-round fix only clears one of them. heal() should keep that partial
    edit (fewer failures, nothing new) and try again, rather than reverting a real step forward."""
    (repo / "calc.py").write_text(
        "def add(a, b):\n    return a - b\n\n\ndef double(x):\n    return x - x\n", encoding="utf-8"
    )
    (repo / "test_calc.py").write_text(
        "from calc import add, double\n\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\n"
        "def test_double():\n    assert double(4) == 8\n",
        encoding="utf-8",
    )
    calls = {"n": 0}

    def fake_culprits(repo_name, failing, changed, limit=15):
        # round 1: both tests failing -> point at `add` first; round 2: only test_double remains -> `double`
        target = "add" if calls["n"] == 0 else "double"
        return {"suspects": [{"id": f"calc.py::{target}", "name": target, "file": "calc.py", "line": 1,
                              "score": 1.0, "failed": 1, "passed": 0}]}

    def fake_propose(api_key, model, test_output, suspect, file_text):
        calls["n"] += 1
        if suspect["name"] == "add":
            return file_text.replace("return a - b", "return a + b"), "fixed add"
        return file_text.replace("return x - x", "return x + x"), "fixed double"

    monkeypatch.setattr(heal.T, "culprits", fake_culprits)
    monkeypatch.setattr(heal, "_propose_fix", fake_propose)
    report = heal.heal(FakeGraph(), repo, PY, ["test_calc.py::test_add", "test_calc.py::test_double"], None,
                       apply=True, anthropic_api_key="sk-fake", max_rounds=3)
    assert report.verdict == "fixed"
    assert [r.outcome for r in report.rounds] == ["partial", "fixed"]
    assert "a + b" in (repo / "calc.py").read_text()
    assert "x + x" in (repo / "calc.py").read_text()


def test_heal_edits_only_the_suspect_function_in_a_file_too_large_to_send(repo: Path, monkeypatch):
    pad = "# " + "x" * 98 + "\n"
    big = pad * 150 + "def add(a, b):\n    return a - b\n\n\n" + pad * 100
    (repo / "calc.py").write_text(big, encoding="utf-8")
    line = big.splitlines().index("def add(a, b):") + 1
    sent = {}

    def fake_culprits(repo_name, failing, changed, limit=15):
        return {"suspects": [{"id": "calc.py::add", "name": "add", "file": "calc.py", "line": line,
                              "end_line": line + 1, "score": 1.0, "failed": 1, "passed": 0}]}

    def fake_propose(api_key, model, test_output, suspect, file_text):
        sent.update(region=suspect.get("region"), text=file_text)
        return "def add(a, b):\n    return a + b\n\n\n", "fixed the operator"

    monkeypatch.setattr(heal.T, "culprits", fake_culprits)
    monkeypatch.setattr(heal, "_propose_fix", fake_propose)
    report = heal.heal(FakeGraph(), repo, PY, ["test_calc.py::test_add"], None, apply=True,
                       anthropic_api_key="sk-fake")
    assert report.verdict == "fixed"
    assert sent == {"region": [line, line + 1], "text": "def add(a, b):\n    return a - b\n"}  # not the whole file
    assert (repo / "calc.py").read_text() == big.replace("return a - b", "return a + b")  # the rest is untouched
    assert "-    return a - b" in report.rounds[0].diff_preview


def test_propose_fix_routes_to_the_claude_cli_without_an_api_key(monkeypatch):
    calls = []

    def fake_cli(model, prompt, tools=None):
        calls.append(prompt)
        return "```python\ndef add(a, b):\n    return a + b\n```", ""

    monkeypatch.setattr(heal, "_ask_cli", fake_cli)
    code, _ = heal._propose_fix(heal.CLI_BACKEND, heal.FIX_MODEL, "E assert -1 == 5",
                                {"name": "add", "file": "calc.py", "line": 1}, "def add(a, b):\n    return a - b\n")
    assert code == "def add(a, b):\n    return a + b\n"
    assert "E assert -1 == 5" in calls[0] and "return a - b" in calls[0]
