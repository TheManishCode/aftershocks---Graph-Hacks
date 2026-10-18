"""The test loop (D25): an external test library indexed with the repo, runs recorded in the graph, a failing run
opened with its suspects, and a heal from that run re-verified and linked RETRY_OF. Pytest runs for real; Claude is
monkeypatched (the fix it "proposes" is the known correct one), so what is checked is the loop around it."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aftershock.analysis import heal
from aftershock.config import get_settings
from aftershock.runtime import runs
from aftershock.runtime.pytest_run import Outcome, _alias, run_selected

from .conftest import SCRATCH, index_copy, needs_graph

LIB_TEST = '''from shop.service import load_user


def test_load_user_keeps_the_url():
    assert load_user(7)["url"] == "sqlite://"


def test_load_user_keeps_the_key():
    assert load_user(7)["key"] == 7
'''
BUG = ('        return {"key": key, "url": self.url}\n', '        return {"key": key, "url": self.url + "/"}\n')


def test_fold_marks_a_symbol_failed_if_any_case_or_phase_failed():
    rows = [{"nodeid": "t.py::test_a[1]", "when": "call", "outcome": "passed", "seconds": 0.1},
            {"nodeid": "t.py::test_a[2]", "when": "call", "outcome": "failed", "seconds": 0.2, "message": "boom"},
            {"nodeid": "t.py::TestB::test_c", "when": "call", "outcome": "skipped", "seconds": 0.0}]
    got = runs.fold(rows)
    assert got["t.py::test_a"] == {"test": "t.py::test_a", "outcome": "failed", "seconds": 0.3, "message": "boom"}
    assert got["t.py::TestB.test_c"]["outcome"] == "skipped"


def test_alias_rewrites_a_library_nodeid_to_its_graph_path(tmp_path: Path):
    lib = tmp_path / "lib"
    row = {"nodeid": "../lib/sub/test_x.py::TestA::test_b[1]", "path": str(lib / "sub" / "test_x.py")}
    assert _alias(row, {str(lib): "@lib/mine/"})["nodeid"] == "@lib/mine/sub/test_x.py::TestA::test_b[1]"
    other = {"nodeid": "tests/test_y.py::test_c", "path": str(tmp_path / "repo" / "tests" / "test_y.py")}
    assert _alias(other, {str(lib): "@lib/mine/"})["nodeid"] == "tests/test_y.py::test_c"


def test_library_tests_run_from_their_own_directory_under_graph_ids(tmp_path: Path):
    repo = tmp_path / "repo"
    shutil.copytree(Path(__file__).parent / "fixtures" / "heal_repo", repo)
    lib = tmp_path / "suite"
    lib.mkdir()
    (lib / "test_more.py").write_text("from calc import add\n\n\ndef test_zero():\n    assert add(0, 0) == 0\n")
    out = run_selected(repo, sys.executable, ["@lib/suite/test_more.py::test_zero", "test_calc.py::test_add"],
                       timeout=60, libs={"suite": str(lib)})
    got = {r["nodeid"]: r["outcome"] for r in out.results if r["when"] == "call"}
    assert got == {"@lib/suite/test_more.py::test_zero": "passed", "test_calc.py::test_add": "failed"}
    gone = run_selected(repo, sys.executable, ["@lib/removed/test_x.py::test_a"], timeout=60, libs={})
    assert gone.results == [] and gone.exit_code == 0  # a library unregistered since indexing is skipped


class _Spans:
    name = "stub"

    def __init__(self, syms: dict[str, dict]):
        self.syms = syms

    def ro(self, name, params):
        return [{"symbol": self.syms[i]} for i in params["ids"] if i in self.syms]


def test_graph_context_gives_the_chain_and_the_source_of_each_hop(tmp_path: Path):
    (tmp_path / "t.py").write_text("def test_a():\n    assert mid() == 1\n")
    (tmp_path / "m.py").write_text("def mid():\n    return leaf() + 0\n")
    path = [{"from": "t.py::test_a", "to": "m.py::mid", "type": "CALLS", "how": "import", "lines": [2]},
            {"from": "m.py::mid", "to": "l.py::leaf", "type": "CALLS", "how": "import", "lines": [2]}]
    g = _Spans({"t.py::test_a": {"id": "t.py::test_a", "file": "t.py", "line": 1, "end_line": 2},
                "m.py::mid": {"id": "m.py::mid", "file": "m.py", "line": 1, "end_line": 2}})
    ctx = heal.graph_context(g, tmp_path, {"path": path})
    assert "test_a -[CALLS import]-> mid at line 2" in ctx and "mid -[CALLS import]-> leaf" in ctx
    assert "assert mid() == 1" in ctx and "return leaf() + 0" in ctx
    assert heal.graph_context(object(), tmp_path, {"path": path}).count("```") == 0  # no spans: chain only
    assert heal.graph_context(g, tmp_path, {}) == ""


@pytest.fixture
def looped():
    """The mini fixture with a test library outside it, registered and indexed, and a runnable .venv."""
    from aftershock import tools as T
    from aftershock.graph import get_store

    name = "pytest-loop"
    root = index_copy(name)
    py = root / ".venv" / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    py.chmod(0o755)
    lib = SCRATCH / "loop-library"
    shutil.rmtree(lib, ignore_errors=True)
    lib.mkdir()
    (lib / "test_service_lib.py").write_text(LIB_TEST)
    T.library_set(name, "contract", str(lib))
    T.index(str(root), name=name, history=False)
    yield name, root, lib
    get_store().drop_repo(name)
    shutil.rmtree(lib, ignore_errors=True)


@needs_graph
def test_a_library_is_indexed_as_tests_that_reach_repo_code(looped):
    from aftershock import tools as T
    from aftershock.analysis import diff

    name, root, lib = looped
    libs = T.test_libraries(name)["libraries"]
    assert libs == [{"name": "contract", "path": str(lib.resolve()), "on_disk": True, "files": 1, "tests": 2}]
    sel = T.select_tests(name, ["shop/service.py::load_user"])
    assert "@lib/contract/test_service_lib.py::test_load_user_keeps_the_url" in {t["id"] for t in sel["tests"]}
    cs = diff.detect(T._graph(name), root)
    assert not cs.files_removed and not cs.files_changed  # library files are not "missing from the repo"
    with pytest.raises(T.ToolError, match="outside the repo"):
        T.library_set(name, "inside", str(root / "tests"))
    with pytest.raises(T.ToolError, match="library names"):
        T.library_set(name, "../x", str(lib))


@needs_graph
def test_a_failing_run_is_recorded_with_its_suspects_and_history(looped):
    from aftershock import tools as T
    from aftershock.runtime.jobs import run_tests

    name, root, _ = looped
    db = root / "shop" / "db.py"
    db.write_text(db.read_text().replace(*BUG))
    first = run_tests(name, "all", lambda k, d: None, timeout=120)
    second = run_tests(name, "all", lambda k, d: None, timeout=120)
    assert first["failed"] == 1 and first["run_id"] != second["run_id"]
    listed = T.test_runs(name)["runs"]
    assert [r["id"] for r in listed[:2]] == [second["run_id"], first["run_id"]]
    d = T.run_detail(name, second["run_id"])
    assert [f["test"] for f in d["failures"]] == ["@lib/contract/test_service_lib.py::test_load_user_keeps_the_url"]
    assert "AssertionError" in d["failures"][0]["message"]
    top = d["culprits"]["suspects"][0]
    assert top["name"] in ("Store.get", "load_user", "connect") and not top["file"].startswith("@lib/")
    assert top["path"] and top["path"][0]["from"].startswith("@lib/contract/")  # the chain starts at the library test
    outcomes = {r["test"]: r["outcome"] for r in d["results"]}
    assert outcomes["tests/test_db.py::test_connect"] == "passed"
    assert outcomes["@lib/contract/test_service_lib.py::test_load_user_keeps_the_key"] == "passed"
    assert d["history"]["@lib/contract/test_service_lib.py::test_load_user_keeps_the_url"] == {"runs": 1, "failed": 1}
    with pytest.raises(T.NotFound):
        T.run_detail(name, "0123456789ab")
    with pytest.raises(T.ToolError, match="invalid run id"):
        T.run_detail(name, "x' OR 1=1")


@needs_graph
def test_only_the_last_runs_are_kept(looped, monkeypatch):
    from aftershock import tools as T

    monkeypatch.setattr(runs, "KEEP", 3)
    g = T._graph(looped[0])
    ids = [runs.record(g, Outcome(0, 0.1, [{"nodeid": "tests/test_db.py::test_connect", "when": "call",
                                             "outcome": "passed", "seconds": 0.1}]), mode="all") for _ in range(5)]
    assert {r["id"] for r in runs.list_runs(g, 50)} == set(ids[-3:])


@pytest.fixture
def api(monkeypatch):
    def make(allow: bool) -> TestClient:
        monkeypatch.delenv("AFTERSHOCK_API_KEY", raising=False)
        monkeypatch.setenv("AFTERSHOCK_ALLOW_RUN", "1" if allow else "0")
        get_settings.cache_clear()
        from aftershock.api import app

        return TestClient(app, base_url="http://localhost")

    yield make
    get_settings.cache_clear()


def test_heal_from_the_app_is_behind_the_run_gate(api):
    assert api(False).post("/api/v1/repos/x/runs/0123456789ab/heal/stream", json={}).status_code == 403
    c = api(True)
    assert c.post("/api/v1/repos/x/runs/nope/heal/stream", json={}).status_code == 400
    r = c.post("/api/v1/repos/x/runs/0123456789ab/heal/stream", json={}, headers={"Host": "testserver"})
    assert r.status_code == 403


@needs_graph
def test_heal_a_recorded_run_fixes_reverifies_and_links_the_reruns(looped, api, monkeypatch):
    import json

    name, root, _ = looped
    db = root / "shop" / "db.py"
    clean = db.read_text()
    db.write_text(clean.replace(*BUG))
    from aftershock.runtime.jobs import run_tests

    failing = run_tests(name, "all", lambda k, d: None, timeout=120)
    seen: dict = {}

    def fake_propose(api_key, model, tail, suspect, text):
        seen.update(suspect=suspect, tail=tail)
        return text.replace(BUG[1], BUG[0]), "restored the url"

    monkeypatch.setattr(heal, "_propose_fix", fake_propose)
    monkeypatch.setattr(heal, "cli_backend", lambda: heal.CLI_BACKEND)
    monkeypatch.setattr(heal.T, "culprits", lambda repo, failing_, changed, limit=10: {"suspects": [
        {"id": "shop/db.py::Store.get", "name": "Store.get", "file": "shop/db.py", "line": 8, "end_line": 9,
         "score": 1.0, "hops": 3, "path": [
             {"from": "@lib/contract/test_service_lib.py::test_load_user_keeps_the_url",
              "to": "shop/service.py::load_user", "type": "CALLS", "how": "import", "lines": [5]},
             {"from": "shop/service.py::load_user", "to": "shop/db.py::Store.get", "type": "CALLS",
              "how": "inferred", "lines": [6]}]}]})
    r = api(True).post(f"/api/v1/repos/{name}/runs/{failing['run_id']}/heal/stream", json={"max_rounds": 1})
    assert r.status_code == 200
    events = [(b.split("\n")[0][7:], json.loads(b.split("\n")[1][6:])) for b in r.text.strip().split("\n\n")
              if b.startswith("event:")]
    kinds = [k for k, _ in events]
    assert kinds[0] == "start" and "asking" in kinds and "round" in kinds and kinds[-1] == "end", kinds
    done = dict(events)["done"]
    assert done["verdict"] == "fixed" and db.read_text() == clean
    # Claude saw the graph's chain from the library test, and the source of the test itself
    assert "test_load_user_keeps_the_url -[CALLS import]-> load_user" in seen["suspect"]["context"]
    assert 'assert load_user(7)["url"] == "sqlite://"' in seen["suspect"]["context"]
    from aftershock import tools as T

    rerun = T.run_detail(name, T.run_detail(name, failing["run_id"])["retries"][0])
    assert rerun["trigger"] == "heal" and rerun["heal_step"] == "initial" and rerun["failed"] == 1
    fixed = T.run_detail(name, rerun["retries"][0])
    assert fixed["parent"] == rerun["id"] and fixed["failed"] == 0 and fixed["heal_round"] == 1
    assert "-        return {\"key\": key, \"url\": self.url + \"/\"}" in fixed["heal_diff"]
    assert fixed["heal_why"] == "restored the url"  # the fixer's stated cause travels with the run (D26)
    assert rerun["measured"] and not fixed["measured"]  # only the first heal run is measured: later ones run edits
    # history: a heal verify run passed on edited code, which says nothing about flakiness
    url_test = "@lib/contract/test_service_lib.py::test_load_user_keeps_the_url"
    assert T.run_detail(name, rerun["id"])["history"][url_test] == {"runs": 1, "failed": 1}


SHOP = {
    "shop/__init__.py": "",
    "shop/pricing.py": (
        "def discount_rate(code):\n    return {'SAVE10': 10}.get(code, 0) / 10  # bug: / 100\n\n\n"
        "def apply_discount(amount, code):\n    if not code:\n        return amount\n"
        "    return round(amount * (1 - discount_rate(code)), 2)\n"),
    "shop/cart.py": (
        "from shop.pricing import apply_discount\n\n\nclass Cart:\n    def __init__(self):\n        self.items = []\n\n"
        "    def add(self, price):\n        self.items.append(price)\n\n"
        "    def total(self, coupon=None):\n        return apply_discount(sum(self.items), coupon)\n"),
    "tests/test_cart.py": (
        "from shop.cart import Cart\n\n\ndef test_plain():\n    c = Cart()\n    c.add(20.0)\n    assert c.total() == 20.0\n\n\n"
        "def test_coupon():\n    c = Cart()\n    c.add(20.0)\n    assert c.total('SAVE10') == 18.0\n"),
    "pyproject.toml": "[tool.pytest.ini_options]\npythonpath = [\".\"]\n",
}


@needs_graph
def test_coverage_includes_libraries_and_clears_code_a_passing_test_skipped():
    """Statically, test_plain reaches discount_rate (via total -> apply_discount), so the bug ties with its callers.
    Recorded coverage shows test_plain returned early: discount_rate ranks alone at the top. Coverage only measures
    function bodies, so the class keeps its static count; library tests get COVERS edges under their @lib/ ids."""
    from aftershock import tools as T
    from aftershock.graph import get_store
    from aftershock.runtime.pytest_run import record_coverage

    name = "pytest-covlib"
    root, lib = SCRATCH / name, SCRATCH / "covlib-library"
    for d in (root, lib):
        shutil.rmtree(d, ignore_errors=True)
    for rel, text in SHOP.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    lib.mkdir()
    (lib / "test_contract.py").write_text("from shop.cart import Cart\n\n\ndef test_contract_coupon():\n"
                                          "    c = Cart()\n    c.add(10.0)\n    assert c.total('SAVE10') == 9.0\n")
    try:
        T.index(str(root), name=name, history=False)
        T.library_set(name, "contract", str(lib))
        T.index(str(root), name=name, history=False)
        failing = ["tests/test_cart.py::test_coupon", "@lib/contract/test_contract.py::test_contract_coupon"]
        before = {s["name"]: s for s in T.culprits(name, failing)["suspects"]}
        assert before["discount_rate"]["score"] == before["apply_discount"]["score"]  # static: a tie

        g = T._graph(name)
        res = record_coverage(g, root, sys.executable, libs={"contract": str(lib)})
        assert res["tests_run"] == 3 and res["unmatched_tests"] == 0
        assert {r["src"] for r in g.ro("covered_by", {"ids": failing, "limit": 100})} == set(failing)

        after = T.culprits(name, failing)
        top, by = after["suspects"][0], {s["name"]: s for s in after["suspects"]}
        assert top["name"] == "discount_rate" and top["passed"] == 0 and top["score"] == 1.0
        assert by["apply_discount"]["passed"] == 1  # test_plain did run it
        assert by["Cart"]["score"] < 1.0  # a class is not measured: its static reach stands
    finally:
        get_store().drop_repo(name)
        shutil.rmtree(lib, ignore_errors=True)
