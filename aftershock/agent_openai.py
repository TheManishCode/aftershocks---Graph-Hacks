"""The Ask agent over the OpenAI Chat Completions wire (D27).

This is the same loop as `agent._ask_claude` — the same tools, the same system prompt, the same `emit` events, the
same step records — spoken to any host that implements Chat Completions: OpenAI, OpenRouter, Groq, Together,
DeepSeek, xAI, Mistral, and a local Ollama / LM Studio / vLLM server.

It talks HTTP directly rather than through the `openai` SDK. The tool-calling subset of Chat Completions is small
and frozen, every one of those hosts implements exactly it, and a dependency whose only job is to build this JSON
body is a dependency that can break the build for no benefit.

Only the request shape differs from Anthropic's: tools are wrapped in `{"type": "function", "function": {...}}`,
the schema key is `parameters` rather than `input_schema`, a tool result is a `{"role": "tool"}` message keyed by
`tool_call_id`, and arguments arrive as a JSON *string* that the model sometimes gets wrong — so parsing them is
a per-call error, reported to the model as a tool error, never an exception that kills the turn.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable

import httpx

from . import tools as T
from .graph import GraphUnavailable
from .providers import Provider

log = logging.getLogger("aftershock.agent.openai")
Emit = Callable[[str, dict], None]
TIMEOUT = httpx.Timeout(120.0, connect=10.0)


class ProviderError(RuntimeError):
    """The provider refused or failed. The message is safe to show a user and never contains the key."""


def to_openai_tools(specs: list[dict]) -> list[dict]:
    """Anthropic tool specs -> Chat Completions `tools`."""
    return [{"type": "function",
             "function": {"name": s["name"], "description": s["description"], "parameters": s["input_schema"]}}
            for s in specs]


def _post(provider: Provider, key: str | None, body: dict) -> dict:
    headers = {"content-type": "application/json", **provider.extra_headers}
    if key:
        headers["authorization"] = f"Bearer {key}"
    url = f"{(provider.base_url or '').rstrip('/')}/chat/completions"
    try:
        r = httpx.post(url, json=body, headers=headers, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        # `repr(e)` on an httpx error can carry the request headers; the string form is the URL only
        raise ProviderError(f"could not reach {provider.label}: {type(e).__name__}") from None
    if r.status_code >= 400:
        raise ProviderError(f"{provider.label} returned {r.status_code}: {_detail(r)}")
    try:
        return r.json()
    except ValueError:
        raise ProviderError(f"{provider.label} returned a non-JSON body") from None


def _detail(r: httpx.Response) -> str:
    """The provider's own error text, trimmed. Never includes a request header, so never includes the key."""
    try:
        d = r.json()
    except ValueError:
        return r.text[:200].strip() or r.reason_phrase
    err = d.get("error") if isinstance(d, dict) else None
    msg = err.get("message") if isinstance(err, dict) else (err if isinstance(err, str) else None)
    return str(msg or d)[:300]


def ask(repo: str, question: str, emit: Emit, *, provider: Provider, key: str | None, model: str,
        system: str, specs: list[dict], call_tool, summarise, effort: str = "medium",
        max_turns: int = 8) -> dict:
    """Run the tool loop until the model answers. Returns the same dict shape as the Claude path."""
    messages: list[dict] = [{"role": "system", "content": system},
                            {"role": "user", "content": f"Repository: {repo}\n\nQuestion: {question}"}]
    tools = to_openai_tools(specs)
    steps: list[dict] = []
    usage = {"input": 0, "output": 0, "cache_read": 0}

    for _ in range(max_turns):
        body: dict = {"model": model, "messages": messages, "tools": tools, "tool_choice": "auto",
                      provider.max_tokens_field: 8000}
        if effort and effort != "none":
            # Ignored by hosts that do not reason; OpenRouter and OpenAI both read this key.
            body["reasoning_effort"] = effort
        data = _post(provider, key, body)

        u = data.get("usage") or {}
        usage["input"] += u.get("prompt_tokens") or 0
        usage["output"] += u.get("completion_tokens") or 0
        usage["cache_read"] += ((u.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0

        choices = data.get("choices") or []
        if not choices:
            raise ProviderError(f"{provider.label} returned no choices")
        msg = choices[0].get("message") or {}
        calls = msg.get("tool_calls") or []

        if not calls:
            text = (msg.get("content") or "").strip()
            if choices[0].get("finish_reason") == "length":
                text += "\n\n_(answer truncated)_"
            if not text:
                text = "The model returned an empty answer."
            emit("answer", {"text": text})
            return {"answer": text, "steps": steps, "mode": "claude", "model": data.get("model") or model,
                    "provider": provider.id, "usage": usage}

        # Echo the assistant turn back verbatim-enough: every tool_call id must reappear in a tool message below.
        messages.append({"role": "assistant", "content": msg.get("content") or None, "tool_calls": calls})

        for c in calls:
            fn = c.get("function") or {}
            name = fn.get("name") or ""
            raw = fn.get("arguments")
            try:
                args = json.loads(raw) if isinstance(raw, str) and raw.strip() else (raw or {})
                if not isinstance(args, dict):
                    raise ValueError("arguments were not an object")
            except ValueError as e:
                args, bad = {}, f"could not parse the arguments you sent: {e}"
            else:
                bad = None
            emit("tool", {"name": name, "input": args})
            if bad:
                content, err, summary, out = f"Error: {bad}", True, bad, None
            else:
                try:
                    out = call_tool(repo, name, dict(args))
                    content, err = json.dumps(out, default=str), False
                    summary = summarise(name, out)
                except (T.ToolError, GraphUnavailable) as e:
                    content, err, summary, out = f"Error: {e}", True, str(e), None
                except Exception as e:  # noqa: BLE001 -- an unknown-tool call from the model must not end the turn
                    log.warning("tool %s failed: %s", name, e)
                    content, err, summary, out = f"Error: {e}", True, str(e), None
            steps.append({"tool": name, "input": args, "summary": summary, "error": err,
                          "receipts": (out or {}).get("receipts")})
            emit("result", steps[-1])
            messages.append({"role": "tool", "tool_call_id": c.get("id") or "", "content": content})

    text = "I ran out of steps before reaching an answer; the tool results above are what I found."
    emit("answer", {"text": text})
    return {"answer": text, "steps": steps, "mode": "claude", "model": model, "provider": provider.id,
            "usage": usage}
