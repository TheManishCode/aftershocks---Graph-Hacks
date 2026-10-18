"""HTTP surface: auth, input validation, error mapping, SSE, and the mounted MCP endpoint."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from aftershock.config import get_settings

from .conftest import needs_graph

KEY = "pytest-key-0123456789"
H = {"Authorization": f"Bearer {KEY}"}


@pytest.fixture(scope="module")
def client():
    mp = pytest.MonkeyPatch()
    mp.setenv("AFTERSHOCK_API_KEY", KEY)
    mp.setenv("AFTERSHOCK_ALLOWED_HOSTS", "testserver")
    get_settings.cache_clear()
    from aftershock.api import app

    with TestClient(app) as c:
        yield c
    mp.undo()
    get_settings.cache_clear()


def test_health_is_public(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200 and r.json()["ok"] is True
    assert r.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize("hdr", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": KEY}])
def test_auth_required(client, hdr):
    assert client.get("/api/v1/repos", headers=hdr).status_code == 401
    assert client.post("/mcp/", json={}, headers=hdr).status_code == 401


def test_cors_rejects_foreign_origin(client):
    r = client.options("/api/v1/repos", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in r.headers


@pytest.mark.parametrize("body", [
    {"path": "/etc"},
    {"url": "http://github.com/a/b"},
    {"url": "https://u:p@github.com/a/b"},
    {"url": "https://evil.example/a/b"},
    {"path": "x", "url": "https://github.com/a/b"},
    {},
])
def test_index_rejects_bad_input_synchronously(client, body):
    r = client.post("/api/v1/repos", json=body, headers=H)
    assert r.status_code in (400, 404, 422), r.text
    assert "/home" not in r.text


@needs_graph
def test_analysis_routes(client, mini):
    base = f"/api/v1/repos/{mini}"
    r = client.post(f"{base}/impact", json={"targets": ["connect"], "change": "signature"}, headers=H)
    assert r.status_code == 200 and r.json()["receipts"]["queries"] > 0
    assert client.post(f"{base}/impact", json={"targets": ["connect"], "change": "nuke"}, headers=H).status_code == 422
    assert client.post("/api/v1/repos/nope-zz/impact", json={"targets": ["x"]}, headers=H).status_code == 404
    assert client.post(f"{base}/path", json={"source": "get_user", "target": "connect"}, headers=H).json()["found"]
    assert client.get(f"{base}/symbol", params={"ref": "load_user"}, headers=H).status_code == 200
    assert client.get(f"{base}/graph", headers=H).json()["nodes"]
    assert client.post(f"{base}/cypher", json={"query": "MATCH (n) DETACH DELETE n"}, headers=H).status_code == 400
    md = client.post(f"{base}/diff.md", json={}, headers=H)
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/plain")


@needs_graph
def test_index_job_returns_a_cursor_past_earlier_events(client):
    import shutil
    import time

    from aftershock.graph import get_store

    from .conftest import MINI, SCRATCH

    name, root = "pytest-api-index", SCRATCH / "api-index"
    shutil.copytree(MINI, root, dirs_exist_ok=True)
    store = get_store()
    store.publish(name, {"type": "error", "detail": "a stale failure from an earlier job"})
    try:
        r = client.post("/api/v1/repos", json={"path": str(root), "name": name, "history": False}, headers=H)
        assert r.status_code == 202, r.text
        body = r.json()
        assert body["after"] >= 1 and body["events"].endswith(f"after={body['after']}")
        seen: list[dict] = []
        deadline = time.time() + 60
        while time.time() < deadline and not any(e["type"] in ("indexed", "error") for e in seen):
            seen += store.events(name, seen[-1]["seq"] if seen else body["after"], block_ms=1000)
        assert seen and all(e["seq"] > body["after"] for e in seen)  # the stale error is not replayed
        assert seen[-1]["type"] == "indexed", seen[-1]
    finally:
        store.drop_repo(name)
        shutil.rmtree(root, ignore_errors=True)


@needs_graph
def test_ask_stream_event_order(client, mini):
    r = client.post(f"/api/v1/repos/{mini}/ask/stream", json={"question": "which tests cover load_user"}, headers=H)
    assert r.status_code == 200
    kinds = [ln.split(": ", 1)[1] for ln in r.text.splitlines() if ln.startswith("event: ")]
    assert kinds == ["plan", "tool", "result", "answer", "end"]


def test_mcp_tools_list(client):
    r = client.post("/mcp/", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
                    headers={**H, "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"})
    assert r.status_code == 200
    tools = {t["name"]: t for t in r.json()["result"]["tools"]}
    assert {"impact", "diff_impact", "explain_path", "select_tests", "culprit", "cypher"} <= set(tools)
    assert all(t["annotations"]["readOnlyHint"] for t in tools.values())


def test_mcp_rejects_foreign_host(client):
    r = client.post("/mcp/", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
                    headers={**H, "Host": "evil.example", "Accept": "application/json, text/event-stream"})
    assert r.status_code == 421
