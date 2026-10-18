"""Runtime evidence: per-test coverage into COVERS edges, running selected tests, mutation scoring.

The end-to-end tests run the mini fixture's own pytest suite with this interpreter (which has pytest and coverage
from the dev extra), on a scratch copy, like the CLI does on a real checkout.
"""

from __future__ import annotations

import sys
import textwrap

import pytest

from aftershock.runtime.mutate import MARK, _module_name, _mutate
from aftershock.runtime.pytest_run import node_to_symbol, symbol_to_node

from .conftest import needs_graph


@pytest.mark.parametrize("node, sym", [
    ("tests/test_x.py::test_a", "tests/test_x.py::test_a"),
    ("tests/test_x.py::TestA::test_b[p-1]", "tests/test_x.py::TestA.test_b"),
    ("tests/test_x.py::test_c[a::b]", "tests/test_x.py::test_c"),
    ("tests/test_x.py", "tests/test_x.py"),
])
def test_node_ids_map_to_symbol_ids(node, sym):
    assert node_to_symbol(node) == sym


def test_symbol_ids_map_back_to_node_ids():
    assert symbol_to_node("tests/t.py::TestA.test_b") == "tests/t.py::TestA::test_b"
    assert symbol_to_node("tests/t.py::test_b#2") == "tests/t.py::test_b"
    assert symbol_to_node("tests/t.py::<module>") == "tests/t.py"
    assert symbol_to_node("tests/t.py::test_prompts.test") == "tests/t.py::test_prompts"  # nested helper
    assert symbol_to_node("tests/t.py::TestA.TestB.test_c.inner") == "tests/t.py::TestA::TestB::test_c"


def test_mutant_goes_after_the_docstring_with_the_body_indent():
    src = textwrap.dedent('''\
        class A:
            def f(self, x):
                """Doc."""
                y = x + 1
                return y
        ''')
    out = _mutate(src, 2)
    assert out is not None
    lines = out.splitlines()
    assert lines[3] == f"        {MARK}" and lines[4] == "        y = x + 1"
    compile(out, "m.py", "exec")


@pytest.mark.parametrize("src", [
    "def f(x): return x\n",                     # one-liner
    'def f(x):\n    """Only a doc."""\n',        # docstring-only stub
    "def f(x):\n    ...\n",                      # ellipsis stub
])
def test_mutant_skips_bodies_it_cannot_safely_break(src):
    assert _mutate(src, 1) is None


def test_mutant_requires_a_def_on_that_line():
    assert _mutate("x = 1\n", 1) is None
    assert _mutate("def broken(:\n", 1) is None


def test_module_names_drop_src_and_init():
    assert _module_name("src/click/core.py") == "click.core"
    assert _module_name("httpx/__init__.py") == "httpx"
    assert _module_name("shop/db.py") == "shop.db"


@needs_graph
def test_coverage_records_covers_edges_that_impact_and_selection_use(scratch_repo):
    from aftershock import tools as T
    from aftershock.analysis.impact import Seed, simulate
    from aftershock.graph import get_store
    from aftershock.runtime.pytest_run import record_coverage

    name, root = scratch_repo
    g = get_store().repo(name)
    res = record_coverage(g, root, sys.executable, timeout=120)
    assert res["tests_run"] == 3 and res["failed"] == 0 and res["unmatched_tests"] == 0
    cov = {(r["src"], r["dst"]) for r in g.ro("covering_tests", {"ids": ["shop/db.py::Store.get"], "limit": 50})}
    assert cov == {("tests/test_api.py::test_get_user", "shop/db.py::Store.get")}
    # a def line belongs to its module, so importing shop.api does not make test_health "cover" get_user
    cov = {r["src"] for r in g.ro("covering_tests", {"ids": ["shop/api.py::get_user"], "limit": 50})}
    assert cov == {"tests/test_api.py::test_get_user"}

    with_rt = simulate(g, [Seed("shop/db.py::Store.get", "body")])
    assert with_rt["runtime_tests"] >= 1
    assert any(t["id"] == "tests/test_api.py::test_get_user" and t["runtime"] for t in with_rt["tests"])
    sel = T.select_tests(name, ["shop/db.py::Store.get"])
    assert sel["runtime_tests"] >= 1 and "coverage" in sel["note"]


@needs_graph
def test_run_selected_reports_the_failure_and_culprit_blames_the_broken_function(scratch_repo):
    from aftershock import tools as T
    from aftershock.runtime.pytest_run import run_selected

    name, root = scratch_repo
    db = root / "shop" / "db.py"
    db.write_text(db.read_text().replace('return {"key": key, "url": self.url}', 'return {"url": self.url}'))
    sel = T.select_tests(name, ["shop/db.py::Store.get"])
    out = run_selected(root, sys.executable, [t["id"] for t in sel["tests"]], timeout=120)
    failed = [node_to_symbol(r["nodeid"]) for r in out.failed]
    assert failed == ["tests/test_api.py::test_get_user"]
    assert "KeyError" in out.failed[0]["message"]
    sus = T.culprits(name, failed, ["shop/db.py::Store.get"])
    assert sus["suspects"][0]["id"] == "shop/db.py::Store.get"


@needs_graph
def test_culprit_uses_recorded_coverage_as_the_spectrum(scratch_repo):
    from aftershock import tools as T
    from aftershock.graph import get_store
    from aftershock.runtime.pytest_run import record_coverage

    name, root = scratch_repo
    record_coverage(get_store().repo(name), root, sys.executable, timeout=120)
    res = T.culprits(name, ["tests/test_api.py::test_get_user"])
    assert res["runtime"] and "coverage" in res["method"]
    score = {s["id"]: s["score"] for s in res["suspects"]}
    assert score["shop/db.py::Store.get"] == 1.0  # only the failing test ran it
    assert score["shop/db.py::connect"] < 1.0  # the passing test_connect ran it too


@needs_graph
def test_mutation_eval_scores_selectors_against_tests_that_really_fail(scratch_repo):
    from aftershock.graph import get_store
    from aftershock.runtime import mutate
    from aftershock.runtime.pytest_run import record_coverage

    name, root = scratch_repo
    g = get_store().repo(name)
    record_coverage(g, root, sys.executable, timeout=120)
    before = {p: p.read_text() for p in root.rglob("*.py")}
    res = mutate.evaluate(g, root, sys.executable, n=50, seed=1, timeout=120)
    assert {p: p.read_text() for p in root.rglob("*.py")} == before  # the checkout is never edited
    assert res["mutants"] >= 3 and res["killed"] >= 2 and res["pre_failing"] == 0
    rows = {r["id"]: r for r in res["rows"]}
    assert rows["shop/db.py::Store.get"]["status"] == "killed"
    assert rows["shop/service.py::ReportJob.run"]["status"] == "survived"  # no test runs it
    assert res["selectors"]["coverage"]["recall"] == 1.0


def test_run_selected_skips_files_pytest_would_not_collect(tmp_path):
    import sys

    from aftershock.runtime.pytest_run import run_selected

    (tmp_path / "tests" / "typing").mkdir(parents=True)
    (tmp_path / "tests" / "test_ok.py").write_text("def test_ok():\n    assert True\n")
    (tmp_path / "tests" / "typing" / "typing_sample.py").write_text("import not_installed_anywhere\n")
    out = run_selected(tmp_path, sys.executable, ["tests/test_ok.py::test_ok", "tests/typing/typing_sample.py"])
    assert out.exit_code == 0 and [r["outcome"] for r in out.results] == ["passed"]
