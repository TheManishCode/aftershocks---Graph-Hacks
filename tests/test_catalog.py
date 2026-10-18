"""The built-in script library (D28): registry integrity, what the read-only checks find, confinement, the exec
gate on `pick`, and the API routes. Static checks need no graph: they run on a plain directory through `Ctx`."""

from __future__ import annotations

import json
import os

import pytest
from fastapi.testclient import TestClient

from aftershock import catalog
from aftershock import tools as T
from aftershock.catalog import commands
from aftershock.config import get_settings

from .conftest import SCRATCH, index_copy, needs_graph


def _repo(name: str, files: dict[str, str]):
    root = SCRATCH / name
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    return root


def _findings(script_id: str, root) -> list[dict]:
    res = catalog.run_one(catalog.REGISTRY[script_id], catalog.Ctx(root))
    assert res["status"] != "error", res
    return res["findings"]


def test_registry_is_consistent():
    scripts = catalog.scripts()
    assert len(scripts) >= 150
    ids = [s.id for s in scripts]
    assert len(ids) == len(set(ids))
    for s in scripts:
        assert s.category in catalog.CATEGORIES and s.ecosystem in catalog.ECOSYSTEMS and s.kind in catalog.KINDS, s.id
        assert s.name and s.summary, s.id
        if s.kind == "command":
            assert s.argv or s.pytest_mode, s.id
            assert s.fn is None, s.id
        else:
            assert callable(s.fn) and not s.argv, s.id


def test_static_checks_find_seeded_problems():
    key = "AKIA" + "Q7RZ" * 4  # built here so this file does not trip the scanner itself
    root = _repo("cat-seeded", {
        "app/conflict.py": "x = 1\n<<<<<<< HEAD\ny = 2\n=======\ny = 3\n>>>>>>> branch\n",
        "app/settings.py": f'AWS_KEY = "{key}"\n',
        "data/bad.json": '{"a": 1,}\n',
        "tests/test_dupe.py": "def test_a():\n    assert 1\n\n\ndef test_a():\n    assert 2\n",
        "web/a.test.js": "it.only('runs alone', () => {})\n",
    })
    assert [(f["file"], f["line"]) for f in _findings("repo.merge-markers", root)] == [("app/conflict.py", 2)]
    secret = _findings("sec.secrets", root)
    assert len(secret) == 1 and secret[0]["file"] == "app/settings.py"
    assert key not in secret[0]["message"], "a found secret is masked, never echoed"
    assert _findings("cfg.json", root)[0]["file"] == "data/bad.json"
    assert any("test_a" in f["message"] for f in _findings("pytest.duplicate-names", root))
    assert _findings("js.focused-tests", root)[0]["file"] == "web/a.test.js"
    assert catalog.run_one(catalog.REGISTRY["repo.merge-markers"], catalog.Ctx(root))["status"] == "failed"


def test_clean_files_pass():
    root = _repo("cat-clean", {"pkg/__init__.py": "", "pkg/m.py": "def f(x):\n    return x + 1\n",
                               "conf.json": '{"ok": true}\n'})
    for sid in ("repo.merge-markers", "sec.secrets", "cfg.json", "py.syntax", "py.bare-except"):
        assert catalog.run_one(catalog.REGISTRY[sid], catalog.Ctx(root))["status"] == "passed", sid


def test_checks_do_not_follow_symlinks_out_of_the_checkout():
    outside = _repo("cat-outside", {"leak.json": "{not json"})
    root = _repo("cat-link", {"ok.json": "{}"})
    link = root / "evil.json"
    if not link.exists():
        os.symlink(outside / "leak.json", link)
    assert catalog.Ctx(root).path("evil.json") is None
    assert _findings("cfg.json", root) == []


def test_pick_gates_scripts_that_execute():
    assert [s.id for s in catalog.pick(["py.syntax", "py.syntax"], allow_exec=False)] == ["py.syntax"]
    with pytest.raises(T.ToolError, match="executes code"):
        catalog.pick(["py.syntax", "pytest.collect"], allow_exec=False)
    assert catalog.pick(["pytest.collect"], allow_exec=True)[0].executes
    with pytest.raises(T.NotFound):
        catalog.pick(["no.such-script"], allow_exec=True)
    with pytest.raises(T.ToolError):
        catalog.pick([], allow_exec=True)
    with pytest.raises(T.ToolError, match="at most"):
        catalog.pick([s.id for s in catalog.scripts()][: catalog.MAX_SELECT + 1], allow_exec=True)


def test_expand_is_capped_and_refuses_option_like_names():
    root = _repo("cat-expand", {"-rf.sh": "echo\n", "a.sh": "echo\n"})
    assert commands.expand("{each:.sh}", catalog.Ctx(root)) == ["a.sh"]
    assert commands.expand("plain", catalog.Ctx(root)) is None
    many = _repo("cat-many", {f"f{i}.sh": "" for i in range(commands.MAX_ARGS + 5)})
    assert len(commands.expand("{each:.sh}", catalog.Ctx(many))) == commands.MAX_ARGS


def test_brief_keeps_output_only_for_failures():
    res = {"results": [
        {"id": "a", "status": "passed", "count": 0, "findings": [], "output_tail": "noise"},
        {"id": "b", "status": "failed", "count": 30, "output_tail": "x" * 5000,
         "findings": [{"file": "m.py", "line": 3, "message": "bad"}] * 30},
    ], "passed": 1, "warned": 0, "failed": 1, "error": 0, "skipped": 0, "seconds": 1.0, "stopped": False}
    b = catalog.brief(res)
    assert "output_tail" not in b["results"][0]
    assert len(b["results"][1]["findings"]) == 8 and b["results"][1]["findings"][0] == "m.py:3: bad"
    assert len(b["results"][1]["output_tail"]) <= 1200


# ---- through an indexed repo and the API ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def indexed():
    name = "pytest-catalog"
    index_copy(name)
    yield name
    from aftershock.graph import get_store

    get_store().drop_repo(name)


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


def _frames(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            out.append((lines["event"], json.loads(lines.get("data", "{}"))))
    return out


@needs_graph
def test_listing_marks_what_applies(indexed):
    res = catalog.listing(indexed, applicable_only=True)
    ids = {r["id"] for r in res["scripts"]}
    assert "py.syntax" in ids and "graph.untested-hubs" in ids and "js.focused-tests" not in ids
    assert res["applicable"] == len(res["scripts"]) <= res["total"]
    assert {r["id"] for r in catalog.listing(indexed, q="merge conflict")["scripts"]} == {"repo.merge-markers"}


@needs_graph
def test_api_runs_read_only_scripts_with_the_gate_off(api, indexed):
    c = api(False)
    listing = c.get(f"/api/v1/repos/{indexed}/scripts", params={"applicable": True}).json()
    assert listing["can_exec"] is False and "AFTERSHOCK_ALLOW_RUN" in listing["exec_reason"]
    r = c.post(f"/api/v1/repos/{indexed}/scripts/run/stream", json={"ids": ["py.syntax", "graph.untested-hubs"]})
    assert r.status_code == 200
    frames = _frames(r.text)
    assert [k for k, _ in frames][0] == "start" and frames[-1][0] == "end"
    done = next(d for k, d in frames if k == "done")
    assert done["error"] == 0 and len(done["results"]) == 2


@needs_graph
def test_api_refuses_executing_scripts_without_the_gate(api, indexed):
    c = api(False)
    url = f"/api/v1/repos/{indexed}/scripts/run/stream"
    assert c.post(url, json={"ids": ["py.syntax", "pytest.collect"]}).status_code == 403
    assert c.post(url, json={"ids": ["no.such"]}).status_code == 403  # no id feedback before the gate
    assert c.post(url, json={"ids": []}).status_code == 422
    assert c.post(url, json={"ids": ["a"] * 61}).status_code == 422
    open_ = api(True)
    assert open_.post(url, json={"ids": ["no.such"]}).status_code == 404


@needs_graph
def test_agent_offers_run_scripts_only_with_a_runner(indexed):
    from aftershock import agent

    names = lambda specs: {s["name"] for s in specs}  # noqa: E731
    specs, _ = agent._with_runs(None)
    assert {"test_scripts", "run_checks"} <= names(specs) and "run_scripts" not in names(specs)
    seen = []
    specs, dispatch = agent._with_runs(lambda ids: seen.append(ids) or {"passed": 1})
    assert "run_scripts" in names(specs)
    assert dispatch(indexed, "run_scripts", {"ids": ["pytest.collect"]}) == {"passed": 1} and seen == [["pytest.collect"]]
    with pytest.raises(T.ToolError):
        dispatch(indexed, "run_scripts", {"ids": []})
    out = dispatch(indexed, "run_checks", {"ids": ["py.syntax"]})
    assert out["passed"] == 1
