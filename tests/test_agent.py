"""The ask agent: deterministic routing (no model) and the Claude tool-use loop against a fake client."""

from __future__ import annotations

from types import SimpleNamespace as NS

import pytest

from aftershock import agent
from aftershock.config import get_settings

from .conftest import needs_graph


@pytest.mark.parametrize(("q", "kind", "args"), [
    ("What breaks if I change get_settings?", "impact_body", ["get_settings"]),
    ("what breaks if I delete `EnvGraph.ro`", "impact", ["delete", "EnvGraph.ro"]),
    ("rename load_user", "impact", ["rename", "load_user"]),
    ("what if I change the signature of connect", "impact_sig", ["signature", "connect"]),
    ("why does get_user depend on connect?", "path", ["get_user", "connect"]),
    ("path from Page to formatPrice", "path", ["Page", "formatPrice"]),
    ("which tests cover load_user", "tests", ["load_user"]),
    ("failing tests: test_get_user", "culprit", ["test_get_user"]),
    ("review my diff", "diff", []),
    ("who owns shop/db.py", "owners", ["shop/db.py"]),
    ("show me hotspots", "hotspots", ["hotspots"]),
    ("any unused code?", "dead", ["unused"]),
    ("are there import cycles", "overview", ["cycles"]),
    ("where is formatPrice", "symbol", ["formatPrice"]),
])
def test_route(q, kind, args):
    assert agent.route(q) == (kind, args)


def test_unroutable_question_returns_none():
    assert agent.route("hello there") is None


def test_filler_words_are_never_routed_as_symbols():
    r = agent.route("what breaks if I change the signature of the most central function")
    assert r is None or not {"the", "most"} & {a.lower() for a in r[1]}


@needs_graph
def test_router_resolves_most_central_by_pagerank(mini):
    events: list[str] = []
    res = agent.ask(mini, "What breaks if I change the signature of the most central function?", lambda k, d: events.append(k))
    assert res["route"] == "impact_sig"
    assert [s["tool"] for s in res["steps"]] == ["overview", "impact"]
    assert res["answer"].startswith("Most central function by PageRank: `")
    assert res["steps"][1]["input"]["targets"][0] != "the"


@needs_graph
def test_router_answers_from_graph(mini):
    events: list[str] = []
    res = agent.ask(mini, "why does get_user depend on connect?", lambda k, d: events.append(k))
    assert res["mode"] == "router" and res["route"] == "path"
    assert "`load_user`" in res["answer"] and "module-attr" in res["answer"]
    assert events == ["plan", "tool", "result", "answer"]
    assert res["steps"][0]["receipts"]["queries"] > 0


@needs_graph
def test_router_ambiguous_and_missing(mini):
    assert "couldn't" in agent.ask(mini, "where is nothing_like_this_xyz")["answer"]
    assert "Job.run" in agent.ask(mini, "where is run")["answer"]  # two `run`s -> candidates listed


def test_tool_specs_mirror_mcp_without_repo():
    specs = {s["name"]: s for s in agent.tool_specs()}
    assert {"impact", "explain_path", "select_tests", "diff_impact", "culprit", "cypher"} <= set(specs)
    assert "repos" not in specs
    for s in specs.values():
        assert "repo" not in s["input_schema"].get("properties", {})
        assert "repo" not in s["input_schema"].get("required", [])


# ---- Claude loop with a fake client ----------------------------------------------------------------------------------


class FakeMessages:
    def __init__(self, script):
        self.script, self.calls = list(script), []

    def create(self, **kw):
        self.calls.append({**kw, "messages": list(kw["messages"])})  # the agent keeps appending to the same list
        return self.script.pop(0)


def _resp(stop, *blocks):
    return NS(stop_reason=stop, content=list(blocks), model="claude-opus-5-5",
              usage=NS(input_tokens=10, output_tokens=5, cache_read_input_tokens=3))


def _use(id_, name, inp):
    return NS(type="tool_use", id=id_, name=name, input=inp)


def _text(t):
    return NS(type="text", text=t)


@pytest.fixture
def fake_claude(monkeypatch):
    import anthropic

    holder = {}

    def install(script):
        msgs = FakeMessages(script)
        holder["messages"] = msgs
        monkeypatch.setattr(anthropic, "Anthropic", lambda **kw: NS(beta=NS(messages=msgs)))
        return msgs

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-not-a-real-key")
    get_settings.cache_clear()
    yield install
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    get_settings.cache_clear()


@needs_graph
def test_claude_loop_runs_tools_and_reports_errors(mini, fake_claude):
    msgs = fake_claude([
        _resp("tool_use", _text("Checking."), _use("t1", "impact", {"targets": ["connect"], "change": "signature"}),
              _use("t2", "impact", {"targets": ["no_such_symbol_zz"], "change": "nuke"})),
        _resp("end_turn", _text("load_user breaks first.")),
    ])
    events: list[str] = []
    res = agent.ask(mini, "what breaks if connect gains a param?", lambda k, d: events.append(k))
    assert res["mode"] == "claude" and res["answer"] == "load_user breaks first."
    assert [s["error"] for s in res["steps"]] == [False, True]
    assert res["usage"] == {"input": 20, "output": 10, "cache_read": 6}
    first, second = msgs.calls
    assert first["model"] == "claude-opus-5-5" and first["fallbacks"] == "default"
    assert first["cache_control"] == {"type": "ephemeral"}
    results = second["messages"][-1]["content"]
    assert [r["tool_use_id"] for r in results] == ["t1", "t2"]  # all results in one user turn, in order
    assert results[1]["is_error"] and not results[0]["is_error"]
    assert events.count("tool") == 2 and events[-1] == "answer"


@needs_graph
def test_claude_refusal_and_turn_cap(mini, fake_claude):
    fake_claude([_resp("refusal")])
    assert "declined" in agent.ask(mini, "x")["answer"]
    fake_claude([_resp("tool_use", _use(f"t{i}", "search", {"q": "connect"})) for i in range(agent.MAX_TURNS)])
    res = agent.ask(mini, "loop forever")
    assert "ran out of steps" in res["answer"] and len(res["steps"]) == agent.MAX_TURNS


@needs_graph
def test_api_error_falls_back_to_router(mini, monkeypatch, fake_claude):
    import anthropic
    import httpx

    def boom(**kw):
        raise anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com"))

    msgs = fake_claude([])
    monkeypatch.setattr(msgs, "create", boom)
    res = agent.ask(mini, "why does get_user depend on connect?")
    assert res["mode"] == "router" and "load_user" in res["answer"]
