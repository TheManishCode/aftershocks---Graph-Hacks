"""D29: showcase repos anyone may run, the install recipes, recorded script runs, and the probe scripts Aftershock
writes itself (import/CLI smoke, flaky and isolation). Probe repos are tiny synthetic checkouts in the scratch dir
whose `.venv` points at this interpreter's environment, so they run without installing anything."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aftershock import catalog
from aftershock.config import get_settings
from aftershock.runtime import setup
from aftershock.runtime.pytest_run import child_env

from .conftest import SCRATCH, index_copy, needs_graph

VENV = Path(sys.prefix)


def _repo(name: str, files: dict[str, str], venv: bool = True) -> Path:
    root = SCRATCH / name
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    if venv and not (root / ".venv").exists():
        os.symlink(VENV, root / ".venv")
    return root


def _run(sid: str, root: Path) -> dict:
    return catalog.run_one(catalog.REGISTRY[sid], catalog.Ctx(root, root.name), timeout=300)


# ---- environment and recipes ------------------------------------------------------------------------------------


def test_child_env_drops_secrets(monkeypatch):
    monkeypatch.setenv("AFTERSHOCK_API_KEY", "x")
    monkeypatch.setenv("OPENROUTER_API_KEY", "x")
    monkeypatch.setenv("GITHUB_TOKEN", "x")
    monkeypatch.setenv("DB_PASSWORD", "x")
    monkeypatch.setenv("FALKORDB_URL", "x")
    monkeypatch.setenv("PLAIN_SETTING", "kept")
    env = child_env()
    assert not {"AFTERSHOCK_API_KEY", "OPENROUTER_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "FALKORDB_URL"} & set(env)
    assert env["PLAIN_SETTING"] == "kept" and "PATH" in env


def test_test_requirements_reads_extras_groups_and_files():
    root = _repo("d29-reqs", {
        "pyproject.toml": '[build-system]\nrequires=["setuptools"]\n[project]\nname="x"\nversion="0"\n'
                          '[project.optional-dependencies]\ntest=["pytest"]\ndocs=["sphinx"]\n'
                          '[dependency-groups]\ndev=["ruff"]\n',
        "requirements.txt": "requests\n", "requirements/test.txt": "pytest\n", "requirements/docs.txt": "x\n",
    }, venv=False)
    r = setup.test_requirements(root)
    assert r["installable"] and r["extras"] == ["test"] and r["groups"] == ["dev"]
    assert r["files"] == ["requirements.txt", "requirements/test.txt"]
    assert setup.test_requirements(_repo("d29-bare", {"a.py": ""}, venv=False))["installable"] is False


def test_every_tool_the_library_names_has_a_recipe():
    tools = {s.tool for s in catalog.scripts() if s.tool}
    assert tools <= set(setup.RECIPES), sorted(tools - set(setup.RECIPES))


def test_install_tools_refuses_unknown_names_and_reports_manual_ones():
    root = _repo("d29-install", {"a.py": ""}, venv=False)
    with pytest.raises(setup.RuntimeErrorReport, match="no install recipe"):
        setup.install_tools("d29-install", root, ["ruff", "rm -rf /"])
    with pytest.raises(setup.RuntimeErrorReport):
        setup.install_tools("d29-install", root, [])
    out = setup.install_tools("d29-install", root, ["shellcheck"])
    assert out["tools"]["shellcheck"]["status"] == "manual" and out["manual"] == 1


def test_missing_scripts_say_how_to_install():
    root = _repo("d29-noenv", {"pkg/__init__.py": "", "tests/test_a.py": "def test_a():\n    pass\n"}, venv=False)
    ctx = catalog.Ctx(root, "d29-noenv-unknown")
    assert catalog.install_for(catalog.REGISTRY["pytest.flaky"], ctx)["method"] == "setup"
    res = catalog.run_one(catalog.REGISTRY["pytest.flaky"], ctx)
    assert res["status"] == "skipped" and res["install"]["method"] == "setup"


# ---- probes -----------------------------------------------------------------------------------------------------


def test_import_smoke_names_the_broken_module():
    root = _repo("d29-smoke", {
        "pkg/__init__.py": "", "pkg/ok.py": "X = 1\n",
        "pkg/broken.py": "import os\nimport no_such_dependency_d29\n",
        "pyproject.toml": '[project]\nname="pkg"\nversion="0"\n[project.scripts]\npkg-ok="pkg.cli:main"\n'
                          'pkg-bad="pkg.cli:missing"\n',
        "pkg/cli.py": "import sys\n\ndef main():\n    print('usage: pkg-ok')\n    sys.exit(0)\n",
    })
    res = _run("py.import-smoke", root)
    assert res["status"] == "failed", res
    assert [f["file"] for f in res["findings"]] == ["pkg/broken.py"]
    assert "no_such_dependency_d29" in res["findings"][0]["message"]
    cli = _run("py.cli-smoke", root)
    assert cli["status"] == "failed", cli
    assert "pkg-bad" in cli["output_tail"] and "pkg-ok" in cli["output_tail"]


def test_flaky_probe_finds_order_dependence():
    root = _repo("d29-flaky", {
        "pytest.ini": "[pytest]\n",
        "tests/test_order.py": "STATE = []\n\n\ndef test_first():\n    STATE.append(1)\n\n\n"
                               "def test_second():\n    assert STATE\n\n\ndef test_solid():\n    assert True\n",
    })
    res = _run("pytest.flaky", root)
    assert res["status"] == "failed", res
    assert res["summary"]["tests"] == 3 and res["summary"]["unstable"] == 1
    f = res["findings"][0]
    assert f["file"] == "tests/test_order.py" and f["line"] == 8 and "order-dependent" in f["message"]


def test_isolation_probe_finds_a_test_that_needs_another_file():
    root = _repo("d29-iso", {
        "pytest.ini": "[pytest]\n",
        "tests/test_a_setup.py": "import builtins\n\n\ndef test_sets():\n    builtins.D29_FLAG = True\n",
        "tests/test_b_uses.py": "import builtins\n\n\ndef test_reads():\n    assert getattr(builtins, 'D29_FLAG', "
                                "False)\n\n\ndef test_alone_ok():\n    assert 1\n",
    })
    res = _run("pytest.isolation", root)
    assert res["status"] == "failed", res
    assert [(f["file"], f["line"]) for f in res["findings"]] == [("tests/test_b_uses.py", 4)]
    assert "fails when its file runs alone" in res["findings"][0]["message"]
    assert res["summary"]["files_run"] == 2


def test_probes_pass_on_a_stable_suite():
    root = _repo("d29-stable", {"pytest.ini": "[pytest]\n", "pkg/__init__.py": "",
                                "tests/test_ok.py": "def test_a():\n    assert 1\n\n\ndef test_b():\n    assert 2\n"})
    for sid in ("pytest.flaky", "pytest.isolation", "py.import-smoke"):
        assert _run(sid, root)["status"] == "passed", sid


# ---- API: showcase, locks, the proxy header, recorded runs ------------------------------------------------------


@pytest.fixture(scope="module")
def showcase():
    name = "pytest-d29"
    index_copy(name)
    yield name
    from aftershock.graph import get_store

    get_store().drop_repo(name)


@pytest.fixture
def api(monkeypatch):
    def make(allow: bool, showcase: str = "") -> TestClient:
        monkeypatch.delenv("AFTERSHOCK_API_KEY", raising=False)
        monkeypatch.setenv("AFTERSHOCK_ALLOW_RUN", "1" if allow else "0")
        monkeypatch.setenv("AFTERSHOCK_SHOWCASE_REPOS", showcase)
        get_settings.cache_clear()
        from aftershock.api import app

        return TestClient(app, base_url="http://localhost")

    yield make
    get_settings.cache_clear()


REMOTE = {"x-aftershock-remote": "1"}


def test_runtime_reports_gate_showcase_and_the_proxy_header(api):
    c = api(True, "demo")
    assert c.get("/api/v1/runtime").json()["enabled"] is True
    remote = c.get("/api/v1/runtime", headers=REMOTE).json()
    assert remote["enabled"] is False and "only allowed from this machine" in remote["reason"]
    shown = c.get("/api/v1/runtime", params={"repo": "demo"}, headers=REMOTE).json()
    assert shown["enabled"] and shown["public"] and shown["timeout"] == get_settings().public_run_timeout
    off = api(False, "demo").get("/api/v1/runtime").json()
    assert off["enabled"] is False and "you can run demo" in off["reason"] and off["showcase"] == ["demo"]


def test_showcase_repos_are_locked_against_visitors(api):
    c = api(False, "pytest-d29-locked")
    assert c.delete("/api/v1/repos/pytest-d29-locked", headers=REMOTE).status_code == 403
    assert c.post("/api/v1/repos/pytest-d29-locked/libraries", json={"name": "flask"},
                  headers=REMOTE).status_code in (403, 422)
    r = c.post("/api/v1/repos", json={"path": str(SCRATCH), "name": "pytest-d29-locked"}, headers=REMOTE)
    assert r.status_code == 403 and "showcase" in r.json()["detail"]


def test_install_route_gates_before_checking_names(api):
    c = api(False)
    url = "/api/v1/repos/anything/tools/install/stream"
    assert c.post(url, json={"tools": ["no-such-tool"]}).status_code == 403
    assert c.post("/api/v1/repos/anything/setup/stream", json={}).status_code == 403
    assert api(True).post(url, json={"tools": ["no-such-tool"]}).status_code == 400


@needs_graph
def test_public_runs_are_one_at_a_time(api, showcase):
    from aftershock import api as mod

    c = api(False, showcase)
    mod._public_runs.add("someone-else")
    try:
        r = c.post(f"/api/v1/repos/{showcase}/scripts/run/stream", json={"ids": ["pytest.collect"]},
                   headers=REMOTE)
        assert r.status_code == 429 and r.headers["retry-after"] == "10"
    finally:
        mod._public_runs.discard("someone-else")


@needs_graph
def test_local_only_scripts_need_the_operator(api, showcase):
    c = api(False, showcase)
    r = c.post(f"/api/v1/repos/{showcase}/scripts/run/stream", json={"ids": ["ai.unit-tests"]}, headers=REMOTE)
    assert r.status_code == 403 and "operator only" in r.json()["detail"]
    listing = c.get(f"/api/v1/repos/{showcase}/scripts").json()
    assert listing["can_exec"] is True and listing["public"] is True


@needs_graph
def test_script_runs_are_recorded_and_listed(showcase):
    res = catalog.run(showcase, ["py.syntax", "repo.merge-markers"], trigger="cli")
    assert res["run_id"]
    runs = catalog.history(showcase)["runs"]
    assert runs[0]["id"] == res["run_id"] and runs[0]["trigger"] == "cli"
    got = catalog.recorded(showcase, res["run_id"])
    assert [r["id"] for r in got["results"]] == ["py.syntax", "repo.merge-markers"]
    for _ in range(catalog.RUNS_KEEP + 2):
        catalog.run(showcase, ["py.syntax"], trigger="cli")
    assert len(catalog.history(showcase, 50)["runs"]) == catalog.RUNS_KEEP


# ---- heal on a showcase: a provider backend, capped, the checkout restored --------------------------------------


def test_heal_without_keep_restores_every_file_it_wrote(monkeypatch):
    from types import SimpleNamespace

    from aftershock.analysis import heal
    from aftershock.runtime.pytest_run import Outcome

    root = _repo("d29-heal", {"pkg/m.py": "def f():\n    return 1\n"}, venv=False)
    fails = {"nodeid": "tests/test_m.py::test_f", "outcome": "failed"}
    outcomes = iter([Outcome(1, 0.1, [fails]), Outcome(0, 0.1, [{**fails, "outcome": "passed"}])])
    monkeypatch.setattr(heal, "run_selected", lambda *a, **k: next(outcomes))
    monkeypatch.setattr(heal.T, "culprits", lambda *a, **k: {"suspects": [
        {"id": "pkg/m.py::f", "name": "f", "file": "pkg/m.py", "line": 1, "end_line": 2}]})
    monkeypatch.setattr(heal, "graph_context", lambda *a, **k: "")
    asked = []
    monkeypatch.setattr(heal, "_propose_fix", lambda key, model, *a: (asked.append((key, model)) or (
        "def f():\n    return 2\n", "Cause: wrong value.")))
    rep = heal.heal(SimpleNamespace(name="d29-heal"), root, sys.executable, ["tests/test_m.py::test_f"], None,
                    apply=True, anthropic_api_key=heal.PROVIDER_BACKEND, model="openrouter:x/y", keep=False)
    assert rep.verdict == "fixed" and "return 2" in rep.rounds[0].diff_preview
    assert (root / "pkg/m.py").read_text() == "def f():\n    return 1\n" and "restored" in rep.note
    assert asked == [(heal.PROVIDER_BACKEND, "openrouter:x/y")]


def test_provider_backend_answers_through_openrouter(monkeypatch):
    from aftershock import agent_openai
    from aftershock.analysis import heal

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "x")
    picked = heal.provider_backend()
    assert picked and picked[0] == heal.PROVIDER_BACKEND
    sent = {}
    monkeypatch.setattr(agent_openai, "_post", lambda p, k, body: sent.update(body) or {
        "choices": [{"message": {"content": "Cause: x\n```python\nX = 2\n```"}}]})
    text, err = heal._ask_provider("openrouter:anthropic/claude-sonnet-5", "fix it")
    assert not err and "X = 2" in text and sent["messages"][0]["content"] == heal.FIX_SYSTEM


def test_heal_is_open_on_showcase_repos_only(api):
    c = api(False, "d29-shown")
    url = "/api/v1/repos/{}/runs/0123abcd/heal/stream"
    assert c.post(url.format("elsewhere"), json={}, headers=REMOTE).status_code == 403
    r = c.post(url.format("d29-shown"), json={}, headers=REMOTE)
    assert r.status_code != 403, r.text  # past the gate; no such repo or run here
