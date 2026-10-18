"""Ask a repository a question in plain English.

Two modes, same tools:
  * With ANTHROPIC_API_KEY: Claude plans and calls the MCP tools (schemas taken from the MCP server, so the two
    surfaces can't drift), then writes an answer that cites the evidence paths it was given.
  * Without a key: a deterministic router maps the common question shapes ("what breaks if I change X", "why does
    A depend on B", "which tests cover X", ...) to one tool and renders the answer from a template. No model, no cost,
    and every sentence is traceable to a query.

`emit(kind, data)` streams steps (plan / tool / result / answer) for the UI. Every tool result carries receipts.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
from collections.abc import Callable

from . import mcp_server as M
from . import tools as T
from .config import get_settings
from .graph import GraphUnavailable

log = logging.getLogger("aftershock.agent")
Emit = Callable[[str, dict], None]
MAX_TURNS = 8

SYSTEM = """You are Aftershock, a change-impact analyst for one code repository, backed by a FalkorDB dependency graph.

Answer the user's question by calling tools, then write a short, direct answer.
- Pin down ambiguous names with `search` or `symbol` before running impact.
- Ground every claim in tool output. Cite symbols as `name` (file:line) and show the dependency chain that supports a
  claim, with how each edge was resolved when it matters (e.g. "via import", "name-unique guess, low confidence").
- Impact numbers are risk estimates over statically resolved edges, not proof. Say so once, briefly. Never invent
  callers, tests or files the tools did not return.
- Prefer one or two well-chosen tool calls over many. Stop when you can answer.
- To check or test the repo, pick from the built-in script library: `test_scripts` lists what applies, `run_checks`
  runs the read-only ones (kind check/graph). Choose the few that fit the question rather than everything.
  `kind=command` scripts (pytest, linters, type checkers, npm test, ...) run only through `run_scripts`; if you don't
  have that tool, name the ids and tell the user to run them from the Tests page."""

RUN_SCRIPTS = {
    "name": "run_scripts",
    "description": "Run scripts from the built-in library, including kind=command ones that execute tools and tests "
                   "in the repo (pytest, ruff, tsc, npm test, ...). Slow: pick only what the question needs. "
                   "Tools are never installed; a missing one comes back as skipped.",
    "input_schema": {"type": "object", "properties": {"ids": {
        "type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 10,
        "description": "Script ids from test_scripts"}}, "required": ["ids"]},
}


# ---- tool plumbing ---------------------------------------------------------------------------------------------------

_TOOLS: list[dict] | None = None


def _q(qname: str) -> str:
    """Display form of a qname: no `#2` overload counter (the file:line next to it names the exact def)."""
    return re.sub(r"#\d+(?=$|\.)", "", qname)


def tool_specs() -> list[dict]:
    """Anthropic tool definitions derived from the MCP server's tools, with `repo` bound by the caller."""
    global _TOOLS
    if _TOOLS is None:
        import anyio

        listed = anyio.run(M.server.list_tools)
        specs = []
        for t in listed:
            if t.name == "repos" or (t.annotations and t.annotations.read_only_hint is False):
                continue  # the Ask agent reads; it never runs or edits (D26)
            schema = json.loads(json.dumps(t.input_schema))
            schema.get("properties", {}).pop("repo", None)
            schema["required"] = [r for r in schema.get("required", []) if r != "repo"]
            specs.append({"name": t.name, "description": t.description or "", "input_schema": schema})
        _TOOLS = sorted(specs, key=lambda s: s["name"])  # stable order keeps the prompt cache warm
    return _TOOLS


def _with_runs(run_scripts):
    """Tool specs and dispatcher, with `run_scripts` added only when the API handed us a gated runner (D28)."""
    specs = tool_specs() + ([RUN_SCRIPTS] if run_scripts else [])

    def dispatch(repo: str, name: str, args: dict) -> dict:
        if name == "run_scripts" and run_scripts:
            ids = args.get("ids")
            if not isinstance(ids, list) or not ids or len(ids) > 10:
                raise T.ToolError("ids: a list of 1 to 10 script ids")
            return run_scripts([str(i) for i in ids])
        return call_tool(repo, name, args)

    return specs, dispatch


def call_tool(repo: str, name: str, args: dict) -> dict:
    fn = getattr(M, name, None)
    if fn is None or name not in {s["name"] for s in tool_specs()}:
        raise T.ToolError(f"unknown tool {name}")
    return fn(repo=repo, **args)


# ---- Claude mode -----------------------------------------------------------------------------------------------------


def _ask_claude(repo: str, question: str, emit: Emit, *, api_key: str | None = None, model: str | None = None,
                effort: str = "medium", run_scripts=None) -> dict:
    import anthropic

    specs, dispatch = _with_runs(run_scripts)

    s = get_settings()
    client = anthropic.Anthropic(api_key=api_key or s.anthropic_api_key)
    model = model or s.model
    messages: list[dict] = [{"role": "user", "content": f"Repository: {repo}\n\nQuestion: {question}"}]
    steps, usage = [], {"input": 0, "output": 0, "cache_read": 0}
    for _ in range(MAX_TURNS):
        resp = client.beta.messages.create(
            model=model, max_tokens=16000, system=SYSTEM, tools=specs, messages=messages,
            cache_control={"type": "ephemeral"}, output_config={"effort": effort},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
        usage["input"] += resp.usage.input_tokens
        usage["output"] += resp.usage.output_tokens
        usage["cache_read"] += getattr(resp.usage, "cache_read_input_tokens", 0) or 0
        if resp.stop_reason == "refusal":
            return {"answer": "The model declined to answer this question.", "steps": steps, "mode": "claude",
                    "usage": usage}
        messages.append({"role": "assistant", "content": resp.content})
        uses = [b for b in resp.content if b.type == "tool_use"]
        if resp.stop_reason != "tool_use" or not uses:
            text = "".join(b.text for b in resp.content if b.type == "text").strip()
            if resp.stop_reason == "max_tokens":
                text += "\n\n_(answer truncated)_"
            emit("answer", {"text": text})
            return {"answer": text, "steps": steps, "mode": "claude", "model": resp.model, "usage": usage}
        results = []
        for b in uses:
            emit("tool", {"name": b.name, "input": b.input})
            try:
                out = dispatch(repo, b.name, dict(b.input))
                content, err = json.dumps(out, default=str), False
                summary = _summary(b.name, out)
            except (T.ToolError, GraphUnavailable, M.MCPToolError) as e:
                content, err, summary, out = f"Error: {e}", True, str(e), None
            steps.append({"tool": b.name, "input": b.input, "summary": summary, "error": err,
                          "receipts": (out or {}).get("receipts")})
            emit("result", steps[-1])
            results.append({"type": "tool_result", "tool_use_id": b.id, "content": content, "is_error": err})
        messages.append({"role": "user", "content": results})
    text = "I ran out of steps before reaching an answer; the tool results above are what I found."
    emit("answer", {"text": text})
    return {"answer": text, "steps": steps, "mode": "claude", "usage": usage}


def _summary(name: str, out: dict) -> str:
    if name in ("impact", "diff_impact"):
        imp = out.get("impact", out) or {}
        if imp.get("risk"):
            c = imp["counts"]
            return f"risk {imp['risk']['score']} ({imp['risk']['level']}): {c['impacted']} symbols, {c['tests']} tests"
        return imp.get("error") or "no changes"
    if name == "explain_path":
        return out.get("summary") or out.get("error", "")
    if name in ("run_checks", "run_scripts"):
        parts = [f"{out[k]} {k}" for k in ("passed", "warned", "failed", "error", "skipped") if out.get(k)]
        return ", ".join(parts) or "nothing ran"
    if name == "test_scripts":
        return f"{out.get('count', 0)} scripts"
    for k in ("symbols", "tests", "suspects", "candidates", "rows", "callers", "hotspots", "owners"):
        if isinstance(out.get(k), list):
            return f"{len(out[k])} {k}"
    return "ok"


# ---- deterministic mode ----------------------------------------------------------------------------------------------

Q = r"[`'\"]?([\w./:<>-]+(?:\.[\w<>]+)*)[`'\"]?"
ROUTES: list[tuple[re.Pattern, str]] = [
    (re.compile(rf"\bwhy (?:does|is|do)\s+{Q}\s+(?:depend|call|use|import|need|reach)\w*\s+(?:on\s+)?{Q}", re.IGNORECASE), "path"),
    (re.compile(rf"\b(?:path|chain|route|link)\s+(?:from|between)\s+{Q}\s+(?:to|and)\s+{Q}", re.IGNORECASE), "path"),
    (re.compile(rf"\bhow (?:does|is)\s+{Q}\s+(?:connected|related|linked)\s+to\s+{Q}", re.IGNORECASE), "path"),
    (re.compile(rf"\b(?:failing|failed|broken|fails?)\b.*?\btests?\b\s*:?\s*{Q}", re.IGNORECASE), "culprit"),
    (re.compile(rf"\btests?\b\s+{Q}\s+(?:is\s+)?fail", re.IGNORECASE), "culprit"),
    (re.compile(r"\b(?:my|the|current|this)\s+(?:diff|changes?|branch|pr|pull request|working tree)\b", re.IGNORECASE), "diff"),
    (re.compile(rf"\b(?:which|what)\s+tests?\b.*?\b(?:cover|run|exercise|reach|for|touch)\w*\s+{Q}", re.IGNORECASE), "tests"),
    (re.compile(rf"\b(delete|remove|rename|drop)\w*\s+{Q}", re.IGNORECASE), "impact"),
    (re.compile(rf"\b(?:change|modify|edit|touch|refactor)\w*\s+(?:the\s+)?(signature|params?|parameters|arguments)\s+of\s+{Q}", re.IGNORECASE), "impact_sig"),
    (re.compile(rf"\b(?:breaks?|impact|affect|blast radius|depends? on|rel(?:y|ies) on|calls?|uses?)\w*\b.*?\b(?:if|of|when|on)\s+(?:i\s+)?(?:change|modify|touch|edit)?\w*\s*{Q}", re.IGNORECASE), "impact_body"),
    (re.compile(rf"\bwho (?:owns|maintains|knows|wrote|reviews?)\s+{Q}", re.IGNORECASE), "owners"),
    (re.compile(r"\b(hotspots?|riskiest|most complex|churn)\b", re.IGNORECASE), "hotspots"),
    (re.compile(r"\b(dead code|unused|never called|unreferenced)\b", re.IGNORECASE), "dead"),
    (re.compile(r"\b(cycles?|circular|architecture|overview|subsystems?|structure|modules?)\b", re.IGNORECASE), "overview"),
    (re.compile(rf"\b(?:where is|find|show|what is|what does)\s+{Q}", re.IGNORECASE), "symbol"),
]
LOCAL = {"hotspots": T.hotspots, "dead_code": T.dead_code}  # API-only views the router can still use
CHANGE_WORD = {"delete": "delete", "remove": "delete", "drop": "delete", "rename": "rename"}


def route(question: str) -> tuple[str, list[str]] | None:
    q = question.strip().rstrip("?.! ")
    for rx, kind in ROUTES:
        m = rx.search(q)
        # a capture that is a filler word ("of the most ...") is not a symbol: try the next shape
        if m and not any(g and g.lower() in _STOP for g in m.groups()):
            return kind, [g for g in m.groups() if g]
    return None


# "the most central function" names no symbol; PageRank does. Resolved before routing so every shape can use it.
SUPERLATIVE = re.compile(r"\b(?:the\s+)?(?:most\s+(?:central|important|load[- ]bearing|depended[- ]on)|load[- ]bearing)\s+"
                         r"(function|method|class|symbol)s?\b", re.IGNORECASE)
KINDS = {"function": {"function", "method"}, "method": {"method"}, "class": {"class", "interface"}}


def _resolve_superlative(question: str, step) -> tuple[str, str | None]:
    m = SUPERLATIVE.search(question)
    if not m:
        return question, None
    want = KINDS.get(m.group(1).lower())
    top = next((c for c in step("overview")["central"] if not want or c["kind"] in want), None)
    if top is None:
        return question, None
    return question[:m.start()] + f"`{top['id']}`" + question[m.end():], \
        f"Most central {m.group(1).lower()} by PageRank: `{_q(top['qname'])}` ({top['file']}:{top['line']}).\n\n"


def _ask_router(repo: str, question: str, emit: Emit) -> dict:
    steps: list[dict] = []

    def step(name: str, **kw) -> dict:
        emit("tool", {"name": name, "input": kw})
        out = T.run(LOCAL[name], repo, **kw) if name in LOCAL else call_tool(repo, name, kw)
        steps.append({"tool": name, "input": kw, "summary": _summary(name, out), "error": False,
                      "receipts": out.get("receipts")})
        emit("result", steps[-1])
        return out

    lead = None
    with contextlib.suppress(T.ToolError, M.MCPToolError):  # unresolved: route the question as asked
        question, lead = _resolve_superlative(question, step)
    r = route(question)
    if r is None:
        words = [w for w in re.findall(r"[A-Za-z_][\w.]{2,}", question) if w.lower() not in _STOP]
        r = ("symbol", [max(words, key=len)]) if words else ("overview", [])
    kind, args = r

    try:
        if kind == "path":
            text = _render_path(step("explain_path", source=args[0], target=args[1]), args)
        elif kind == "culprit":
            text = _render_culprit(step("culprit", failing=[args[-1]]))
        elif kind == "diff":
            out = step("diff_impact")
            text = out.get("markdown") or "No changes against the indexed graph."
        elif kind == "tests":
            text = _render_tests(step("select_tests", targets=[args[-1]]), args[-1])
        elif kind == "impact":
            out = step("impact", targets=[args[1]], change=CHANGE_WORD.get(args[0].lower(), "delete"))
            text = out.get("markdown") or _problems(out)
        elif kind in ("impact_sig", "impact_body"):
            out = step("impact", targets=[args[-1]], change="signature" if kind == "impact_sig" else "body")
            text = out.get("markdown") or _problems(out)
        elif kind == "owners":
            text = _render_owners(step("owners", paths=[args[-1]]), args[-1])
        elif kind == "hotspots":
            text = _render_hotspots(step("hotspots", limit=10))
        elif kind == "dead":
            out = step("dead_code", limit=25)
            text = "**Dead-code candidates** (no static references):\n" + "\n".join(
                f"- `{_q(c['qname'])}` ({c['file']}:{c['line']}) — {c['category']}" for c in out["candidates"]) \
                + f"\n\n_{out['note']}_"
        elif kind == "overview":
            text = _render_overview(step("overview"))
        else:
            text = _render_symbol(step("symbol", ref=args[-1]))
    except (T.ToolError, M.MCPToolError) as e:
        text = f"I couldn't answer that: {e}"
    text = (lead or "") + text
    emit("answer", {"text": text})
    return {"answer": text, "steps": steps, "mode": "router", "route": kind,
            "hint": None if get_settings().anthropic_api_key else
            "Set ANTHROPIC_API_KEY for free-form questions; without it common question shapes are routed directly."}


_STOP = {"what", "which", "where", "does", "the", "this", "that", "with", "from", "into", "when", "will", "would",
         "should", "could", "and", "for", "how", "why", "are", "can", "about", "code", "function", "class", "file",
         "change", "changes", "break", "breaks", "tell", "show", "most"}


def _problems(out: dict) -> str:
    probs = out.get("problems") or []
    if probs and probs[0].get("candidates"):
        return "That name is ambiguous. Did you mean:\n" + "\n".join(
            f"- `{c['id']}` ({c['kind']})" for c in probs[0]["candidates"][:10])
    return out.get("error") or "No match."


def _node(n: dict) -> str:
    where = f" ({n['file']}:{n['line']})" if n.get("file") and n.get("line") else ""
    return f"`{n.get('name') or n.get('id')}`{where}"


def _chain(steps: list[dict]) -> str:
    out = []
    for i, st in enumerate(steps):
        verb = {"CALLS": "calls", "INHERITS": "inherits from", "IMPLEMENTS": "implements", "OVERRIDES": "overrides",
                "DISPATCH": "can dispatch to"}.get(st.get("type"), "→")
        ev = f" — resolved {st['how']}, confidence {float(st.get('confidence') or 0):.2f}" if st.get("how") else ""
        out.append(f"{i + 1}. {_node(st['from'])} **{verb}** {_node(st['to'])}{ev}")
    return "\n".join(out)


def _render_path(out: dict, args: list[str]) -> str:
    if out.get("error"):
        lines = [f"I couldn't pin down both names ({out['error']})."]
        for end in ("from", "to"):
            e = out.get(end) or {}
            if e.get("candidates"):
                lines.append(f"`{e['ref']}` could be: " + ", ".join(f"`{c['id']}`" for c in e["candidates"][:6]))
            elif e.get("error"):
                lines.append(f"`{e['ref']}`: {e['error']}")
        return "\n\n".join(lines) + "\n\nAsk again with a qualified name (`Class.method` or `path::name`)."
    if out.get("steps"):
        head = "call chain" if out["direction"] == "forward" else "reverse call chain (the dependency runs the other way)"
        return f"**{out['summary']}** — {head}:\n\n{_chain(out['steps'])}"
    if out.get("files"):
        return f"**{out['summary']}**:\n\n" + " → ".join(f"`{f}`" for f in out["files"])
    co = out.get("cochange") or []
    tail = ("\n\nBut git history couples them: " + ", ".join(
        f"`{c['path']}` (changed together {int(c['count'])}×)" for c in co)) if co else ""
    return f"No dependency path between `{args[0]}` and `{args[1]}`: {out.get('summary', '')}.{tail}"


def _render_culprit(out: dict) -> str:
    if out.get("error"):
        return _problems(out)
    rows = out.get("suspects") or []
    if not rows:
        return "The failing tests reach no non-test code in the graph."
    return "**Most suspicious code** (" + out["method"] + "):\n" + "\n".join(
        f"{i + 1}. `{r['name']}` ({r['file']}:{r['line']}) — score {r['score']}, reached by {r['failed']} failing / "
        f"{r['passed']} passing tests" for i, r in enumerate(rows[:10]))


def _render_tests(out: dict, target: str) -> str:
    if not out.get("files"):
        return f"No test statically reaches `{target}`. " + (out.get("note") or "")
    return (f"**{len(out['tests'])} tests in {len(out['files'])} files** reach `{target}`:\n```\n"
            + "\n".join(out["files"][:40]) + f"\n```\n_{out['note']}_")


def _render_owners(out: dict, path: str) -> str:
    if not out["owners"]:
        return f"No git authorship recorded for `{path}` (needs a git checkout and an exact repo-relative path)."
    s = "\n".join(f"- {o['name'] or o['email']} — {int(o['commits'])} commits" for o in out["owners"][:6])
    co = "\n".join(f"- `{c['path']}` (co-changed {c['count']}×)" for c in out["cochange"][:6])
    return f"**Owners of `{path}`:**\n{s}" + (f"\n\n**Usually changes together with:**\n{co}" if co else "")


def _render_hotspots(out: dict) -> str:
    return "**Hotspots** (churn × complexity):\n" + "\n".join(
        f"{i + 1}. `{h['path']}` — {h['commits']} commits, complexity {h['complexity']}"
        for i, h in enumerate(out["hotspots"][:10]))


def _render_overview(out: dict) -> str:
    c = out["counts"]
    subs = "\n".join(f"- **{s['name']}** — {s['size']} files" for s in out["subsystems"][:10])
    cyc = "\n".join(" → ".join(f"`{p}`" for p in x["example"]) for x in out["cycles"][:5]) or "none"
    central = "\n".join(f"- `{_q(x['qname'])}` ({x['file']})" for x in out["central"][:8])
    return (f"**{c['files']} files, {c['symbols']} symbols, {c['calls']} call edges, {c['imports']} imports.**\n\n"
            f"**Subsystems**\n{subs}\n\n**Import cycles:** {cyc}\n\n**Load-bearing code** (PageRank)\n{central}")


def _render_symbol(out: dict) -> str:
    if out.get("candidates"):
        return "Several matches:\n" + "\n".join(f"- `{c['id']}` ({c['kind']})" for c in out["candidates"][:10])
    if "symbol" not in out:
        f = out.get("file", {})
        return f"`{f.get('path')}` — {len(out.get('symbols', []))} symbols, imported by {len(out.get('importers', []))} files."
    s = out["symbol"]

    def names(rows: list[dict]) -> str:  # module-level code is named by its file; repeats collapse to "×n"
        seen: dict[str, int] = {}
        for c in rows:
            k = c.get("file", "?") if c["name"] == "<module>" else c["name"]
            seen[k] = seen.get(k, 0) + 1
        return ", ".join(f"`{k}`" + (f" ×{n}" if n > 1 else "") for k, n in list(seen.items())[:12])

    callers = names(out["callers"]) or "none found"
    callees = names(out["callees"]) or "none"
    return (f"`{_q(s['qname'])}` — {s['kind']} at {s['file']}:{s['line']}\n```\n{s.get('signature', '')}\n```\n"
            f"**Called by** ({len(out['callers'])}): {callers}\n\n**Calls** ({len(out['callees'])}): {callees}")


# ---- entry -----------------------------------------------------------------------------------------------------------


def ask(repo: str, question: str, emit: Emit | None = None, *, model: str | None = None,
        effort: str = "medium", run_scripts=None) -> dict:
    """Answer `question` about `repo`.

    `model` is a provider-qualified id (`"openrouter:anthropic/claude-sonnet-5"`); when it names a provider with
    no key, or is omitted, the server's own default is used. Any model failure degrades to the deterministic
    router rather than failing the request — an answer from one tool beats an error page.

    `run_scripts(ids)`, when given, lets the model run `command` scripts too. Only the API passes it, and only for
    a request that passed the run gate (`run_refusal`); the router never runs anything.
    """
    from . import providers

    emit = emit or (lambda kind, data: None)
    picked = providers.resolve(model) or providers.resolve(providers.default_model())
    if picked is None:
        emit("plan", {"mode": "router", "reason": "no model configured"})
        return _ask_router(repo, question, emit)

    provider, name = picked
    full = f"{provider.id}:{name}"
    emit("plan", {"mode": "claude", "model": name, "provider": provider.id, "provider_label": provider.label,
                  "model_id": full, "effort": effort})
    try:
        key = providers.key_for(provider.id)
        if provider.wire == "anthropic":
            return _ask_claude(repo, question, emit, api_key=key, model=name, effort=effort,
                               run_scripts=run_scripts)
        from . import agent_openai

        specs, dispatch = _with_runs(run_scripts)
        return agent_openai.ask(repo, question, emit, provider=provider, key=key, model=name, system=SYSTEM,
                                specs=specs, call_tool=dispatch, summarise=_summary, effort=effort,
                                max_turns=MAX_TURNS)
    except Exception as e:  # noqa: BLE001 -- outage, bad key, unknown model: degrade to the router, don't fail
        log.warning("model mode failed (%s), falling back to router: %s", full, e)
        emit("plan", {"mode": "router", "reason": _why(e)})
    return _ask_router(repo, question, emit)


def _why(e: Exception) -> str:
    """A short, safe reason for the fallback banner. Never carries a key or a stack trace."""
    from .agent_openai import ProviderError

    if isinstance(e, ImportError):
        return "the provider's client library is not installed"
    if isinstance(e, ProviderError):
        return str(e)[:200]
    return f"model unavailable ({type(e).__name__})"
