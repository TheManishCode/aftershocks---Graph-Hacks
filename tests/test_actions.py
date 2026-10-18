"""Acting on the graph (D26): a failing run measured as it runs, suspects that explain their score, suggested next
tool calls, a fixer that queries the graph and states its cause and evidence, and run/heal over MCP only on a local
stdio server that opted in. Claude is faked; pytest and the graph are real."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from types import SimpleNamespace

from aftershock import tools as T
from aftershock.analysis import heal

from .conftest import SCRATCH, needs_graph
from .test_runs import SHOP


@needs_graph
def test_a_measured_run_ranks_on_executed_code_and_keeps_other_tests_coverage():
    from aftershock.graph import get_store
    from aftershock.runtime.pytest_run import run_measured

    name = "pytest-measured"
    root = SCRATCH / name
    shutil.rmtree(root, ignore_errors=True)
    for rel, text in SHOP.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    plain, coupon = "tests/test_cart.py::test_plain", "tests/test_cart.py::test_coupon"
    try:
        T.index(str(root), name=name, history=False)
        g = T._graph(name)
        static = {s["name"]: s for s in T.culprits(name, [coupon])["suspects"]}
        assert static["discount_rate"]["basis"] == "static"
        assert static["discount_rate"]["score"] == static["apply_discount"]["score"]

        out, cov = run_measured(g, root, sys.executable, [plain])
        assert cov and cov["tests"] == 1 and not out.failed
        out, cov = run_measured(g, root, sys.executable, [coupon])
        assert cov and len(out.failed) == 1
        covered = {r["src"] for r in g.ro("covered_by", {"ids": [plain, coupon], "limit": 100})}
        assert covered == {plain, coupon}  # measuring test_coupon left test_plain's edges alone

        top = T.culprits(name, [coupon])["suspects"][0]
        assert top["name"] == "discount_rate" and top["score"] == 1.0 and top["basis"] == "coverage"
        assert "measured by coverage" in top["why"] and "1 of 1 failing" in top["why"]
    finally:
        get_store().drop_repo(name)


def test_next_steps_turn_a_failing_run_into_tool_calls():
    run = {"id": "abc12345", "measured": False, "retries": [],
           "failures": [{"test": "tests/t.py::test_coupon"}],
           "culprits": {"suspects": [{"id": "shop/pricing.py::discount_rate"}]},
           "history": {"tests/t.py::test_coupon": {"runs": 4, "failed": 2}}}
    steps = {s["tool"]: s for s in T.next_steps(run)}
    assert steps["explain_path"]["args"] == {"source": "tests/t.py::test_coupon",
                                             "target": "shop/pricing.py::discount_rate"}
    assert steps["impact"]["args"]["targets"] == ["shop/pricing.py::discount_rate"]
    assert steps["cypher"]["args"]["params"] == {"t": "tests/t.py::test_coupon"}  # passed and failed before
    assert steps["run_tests"]["needs"] and steps["heal"]["args"] == {"run_id": "abc12345"}
    assert T.next_steps({**run, "failures": []}) == []
    assert "run_tests" not in {s["tool"] for s in T.next_steps({**run, "measured": True})}


def _tools_listed(env: dict[str, str]) -> dict:
    code = ("import anyio, json\nfrom aftershock import mcp_server as M, agent\nfrom aftershock.config import "
            "get_settings\nif get_settings().allow_run: M.register_actions()\n"
            "print(json.dumps({'mcp': [t.name for t in anyio.run(M.server.list_tools)],"
            " 'agent': [t['name'] for t in agent.tool_specs()]}))")
    p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True,
                       env={**os.environ, **env})
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_run_and_heal_reach_mcp_only_when_the_operator_opts_in():
    off = _tools_listed({"AFTERSHOCK_ALLOW_RUN": "0"})
    assert not {"run_tests", "heal"} & set(off["mcp"])
    on = _tools_listed({"AFTERSHOCK_ALLOW_RUN": "1"})
    assert {"run_tests", "heal"} <= set(on["mcp"])
    assert not {"run_tests", "heal"} & set(on["agent"])  # the Ask agent reads, even then
    assert {"run_detail", "explain_path", "impact"} <= set(on["agent"])


def test_fixer_queries_the_graph_then_explains_its_fix(monkeypatch):
    import anthropic

    from aftershock import agent

    replies = [
        SimpleNamespace(stop_reason="tool_use", content=[SimpleNamespace(
            type="tool_use", id="t1", name="symbol", input={"ref": "discount_rate"})]),
        SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=(
            "Cause: discount_rate divides a percentage by 10, so SAVE10 takes 100% off.\n"
            "Evidence: apply_discount is its only caller and multiplies by (1 - rate).\n"
            "```python\ndef discount_rate(code):\n    return {'SAVE10': 10}.get(code, 0) / 100\n```"))]),
    ]
    seen: list[dict] = []

    class Client:
        def __init__(self, **kw):
            self.messages = self

        def create(self, **kw):
            seen.append(kw)
            return replies[len(seen) - 1]

    monkeypatch.setattr(anthropic, "Anthropic", Client)
    monkeypatch.setattr(agent, "tool_specs", lambda: [{"name": n, "description": "", "input_schema": {}}
                                                      for n in ("symbol", "run_tests", "heal")])
    monkeypatch.setattr(agent, "call_tool", lambda repo, name, args: {"repo": repo, "callers": ["apply_discount"]})
    used: list[dict] = []
    code, text = heal._propose_fix("sk-test", heal.FIX_MODEL, "E assert 0.0 == 18.0",
                                   {"name": "discount_rate", "file": "shop/pricing.py", "line": 1, "repo": "shop",
                                    "run_id": "abc12345", "tools": used}, "def discount_rate(code): ...\n")
    assert "/ 100" in code
    assert used == [{"name": "symbol", "input": {"ref": "discount_rate"}}]
    assert [t["name"] for t in seen[0]["tools"]] == ["symbol"]  # never offered run_tests or heal
    assert "Repository (pass as `repo`" in seen[0]["messages"][0]["content"] and "abc12345" in seen[0]["messages"][0][
        "content"]
    assert heal._explanation(text).startswith("Cause: discount_rate divides")
    assert "```" not in heal._explanation(text)


def test_cli_fixer_gets_read_only_graph_tools_and_its_lookups_are_kept(monkeypatch):
    stream = [
        {"type": "system", "subtype": "init"},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "mcp__aftershock__explain_path", "input": {"source": "a", "target": "b"}}]}},
        {"type": "result", "is_error": False, "result": "Cause: x.\nEvidence: y.\n```python\npass\n```"},
    ]
    calls = []

    def fake_run(cmd, **kw):
        calls.append((cmd, kw))
        return subprocess.CompletedProcess(cmd, 0, "\n".join(json.dumps(e) for e in stream), "")

    monkeypatch.setattr(heal.subprocess, "run", fake_run)
    used: list[dict] = []
    text, err = heal._ask_cli(heal.FIX_MODEL, "prompt", used)
    assert text.startswith("Cause: x.") and not err
    assert used == [{"name": "explain_path", "input": {"source": "a", "target": "b"}}]
    cmd, kw = calls[0]
    allowed = cmd[cmd.index("--allowedTools") + 1 : cmd.index("--no-session-persistence")]
    assert allowed and all(a.startswith("mcp__aftershock__") for a in allowed)
    assert not {"mcp__aftershock__run_tests", "mcp__aftershock__heal"} & set(allowed)
    assert cmd[cmd.index("--tools") + 1] == ""  # no built-in tools: it cannot read or edit files itself
    assert kw["env"]["AFTERSHOCK_ALLOW_RUN"] == "0"
    mcp = json.loads(cmd[cmd.index("--mcp-config") + 1])["mcpServers"]["aftershock"]
    assert mcp["env"]["AFTERSHOCK_ALLOW_RUN"] == "0"
