"""Running a repo's tests from the API (D18): the gate, the DNS-rebinding guard, the job, and live per-test results."""

from __future__ import annotations

import sys
import threading

import pytest
from fastapi.testclient import TestClient

from aftershock.config import get_settings
from aftershock.tools import _changed_tests, _looks_like_test

from .conftest import index_copy, needs_graph

LOCAL = "http://localhost"


@pytest.fixture
def api(monkeypatch):
    """A keyless API, with running switched on or off per test."""
    def make(allow: bool) -> TestClient:
        monkeypatch.delenv("AFTERSHOCK_API_KEY", raising=False)
        monkeypatch.setenv("AFTERSHOCK_ALLOW_RUN", "1" if allow else "0")
        get_settings.cache_clear()
        from aftershock.api import app

        return TestClient(app, base_url=LOCAL)

    yield make
    get_settings.cache_clear()


def test_running_is_off_by_default(api):
    c = api(False)
    r = c.get("/api/v1/runtime")
    assert r.status_code == 200 and r.json()["enabled"] is False and "AFTERSHOCK_ALLOW_RUN" in r.json()["reason"]
    assert c.post("/api/v1/repos/anything/run/stream", json={}).status_code == 403


def test_running_needs_a_loopback_host(api):
    c = api(True)
    assert c.get("/api/v1/runtime").json()["enabled"] is True
    r = c.post("/api/v1/repos/anything/run/stream", json={}, headers={"Host": "testserver"})
    assert r.status_code == 403 and "this machine" in r.json()["detail"]


def test_run_body_is_validated(api):
    c = api(True)
    assert c.post("/api/v1/repos/x/run/stream", json={"mode": "rm -rf"}).status_code == 422
    assert c.post("/api/v1/repos/x/run/stream", json={"timeout": 1}).status_code == 422
    assert c.post("/api/v1/repos/x/run/stream", json={"targets": ["a"] * 51}).status_code == 422


def test_keyless_api_refuses_unknown_hosts(api):
    c = api(False)
    r = c.get("/api/v1/health", headers={"Host": "rebind.evil.example"})
    assert r.status_code == 421 and "AFTERSHOCK_ALLOWED_HOSTS" in r.json()["detail"]
    assert c.get("/api/v1/health", headers={"Host": "localhost:8100"}).status_code == 200
    assert c.get("/api/v1/health", headers={"Host": "[::1]:8100"}).status_code == 200


def test_a_second_run_of_the_same_repo_is_refused(api):
    from aftershock import api as A

    c = api(True)
    A._runs["busy-repo"] = threading.Event()
    try:
        r = c.post("/api/v1/repos/busy-repo/run/stream", json={})
        assert r.status_code in (404, 409)  # 404 when the graph is missing: the repo check comes first
        if r.status_code == 409:
            assert "already in progress" in r.json()["detail"]
    finally:
        A._runs.pop("busy-repo", None)


@pytest.mark.parametrize("file, qname, ok", [
    ("tests/test_x.py", "test_a", True),
    ("tests/test_x.py", "TestA.test_b#2", True),
    ("pkg/x_test.py", "test_a", True),
    ("tests/test_x.py", "helper", False),
    ("tests/test_x.py", "Helper.test_b", False),
    ("pkg/core.py", "test_a", False),
])
def test_test_symbols_follow_pytest_discovery(file, qname, ok):
    assert _looks_like_test(file, qname) is ok


def test_changed_and_added_tests_are_selected_but_deleted_ones_are_not():
    res = {"changes": {"symbols": [
        {"id": "tests/test_a.py::test_new", "change": "add", "line": 3},
        {"id": "tests/test_a.py::test_old", "change": "delete"},
        {"id": "tests/test_a.py::test_x", "change": "rename", "renamed_to": "tests/test_a.py::test_y"},
        {"id": "pkg/core.py::run", "change": "modify"},
    ]}}
    got = {t["id"]: t["changed"] for t in _changed_tests(res, {})}
    assert got == {"tests/test_a.py::test_new": "add", "tests/test_a.py::test_y": "rename"}


@pytest.fixture
def runnable():
    """The mini fixture indexed from scratch, with a `.venv/bin/python` that is this interpreter."""
    from aftershock.graph import get_store

    name = "pytest-run"
    root = index_copy(name)
    py = root / ".venv" / "bin" / "python"
    py.parent.mkdir(parents=True)
    py.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    py.chmod(0o755)
    yield name, root
    get_store().drop_repo(name)


@needs_graph
def test_run_job_streams_each_test_and_ranks_culprits(runnable):
    from aftershock.runtime.jobs import run_tests

    name, root = runnable
    db = root / "shop" / "db.py"
    db.write_text(db.read_text().replace("def connect(", "def connect(*_a):\n    raise OSError('down')\n\n\ndef _gone(", 1))
    events: list[tuple[str, dict]] = []
    res = run_tests(name, "all", lambda k, d: events.append((k, d)), timeout=120)
    kinds = [k for k, _ in events]
    assert kinds[0] == "start" and "test" in kinds
    rows = {d["nodeid"]: d["outcome"] for k, d in events if k == "test" and d["when"] == "call"}
    assert rows["tests/test_db.py::test_connect"] == "failed"
    assert res["failed"] >= 1 and res["passed"] >= 1 and res["passed"] + res["failed"] == len(rows)
    assert res["culprits"]["suspects"], res["culprits"]


@needs_graph
def test_a_cancelled_run_stops(runnable):
    from aftershock.runtime.jobs import run_tests
    from aftershock.runtime.pytest_run import RuntimeErrorReport

    name, _ = runnable
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(RuntimeErrorReport, match="cancelled"):
        run_tests(name, "all", lambda k, d: None, cancel=cancel, timeout=120)


@needs_graph
def test_targets_mode_needs_targets(runnable):
    from aftershock.runtime.jobs import run_tests
    from aftershock.tools import ToolError

    with pytest.raises(ToolError, match="at least one symbol"):
        run_tests(runnable[0], "targets", lambda k, d: None)
