"""Model providers and the credentials for them (D27).

Aftershock's Ask agent is a tool-calling loop. Exactly two wire protocols cover every provider worth supporting:

  * `anthropic` — the native SDK, used for Claude. Keeps prompt caching, server-side fallbacks and `effort`.
  * `openai`    — the Chat Completions shape, spoken by OpenAI, OpenRouter, Groq, Together, DeepSeek, xAI, Mistral
                  and any local Ollama / LM Studio / vLLM server. One client, eight providers.

OpenRouter matters most of the three ways a user can bring a key: a single OpenRouter key reaches Claude, GPT,
Gemini, Llama and the rest, so a user who does not want to collect six keys needs only that one.

Credentials
-----------
A key is a secret the user hands the server, so it lives on the server:

  * It is read from the environment first (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...). An operator deploying
    Aftershock sets keys the same way they set every other secret, and the UI never touches them.
  * A key set through the UI is written to `<cache_dir>/providers.json` with mode 0600, owner-only. The directory
    is created 0700.
  * A stored key is never returned by any route. `status()` reports only whether one exists, where it came from,
    and its last four characters, which is enough for a person to recognise which key they pasted and useless to
    anyone who intercepts it.
  * Keys are never logged, never echoed in an error, and never sent anywhere but the provider's own base URL.

The browser never holds a key. That is the whole point of storing them here: `localStorage` is readable by any
script that gets onto the page, and a leaked `sk-ant-...` is the user's money.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .config import get_settings

Wire = Literal["anthropic", "openai"]
STORE_NAME = "providers.json"


@dataclass(frozen=True)
class Model:
    id: str
    label: str
    note: str = ""
    #: the model reasons about how hard to think; the UI shows the effort menu only for these
    reasoning: bool = False


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    wire: Wire
    env: tuple[str, ...]
    #: None for the Anthropic SDK, which knows its own endpoint
    base_url: str | None = None
    docs: str = ""
    key_hint: str = ""
    #: OpenAI renamed `max_tokens` on its own endpoint; every other OpenAI-compatible host still takes the old name
    max_tokens_field: str = "max_tokens"
    models: tuple[Model, ...] = ()
    #: a local server that needs no key (Ollama, LM Studio, vLLM)
    keyless: bool = False
    extra_headers: dict[str, str] = field(default_factory=dict)


# Model lists are the ones worth defaulting to, not an exhaustive catalogue; every provider also accepts a model id
# typed by hand, because a catalogue baked into a release is stale the week after it ships.
PROVIDERS: tuple[Provider, ...] = (
    Provider(
        id="anthropic",
        label="Anthropic",
        wire="anthropic",
        env=("ANTHROPIC_API_KEY", "AFTERSHOCK_ANTHROPIC_API_KEY"),
        docs="https://console.anthropic.com/settings/keys",
        key_hint="sk-ant-…",
        models=(
            Model("claude-opus-5", "Claude Opus 5", "deepest reasoning", reasoning=True),
            Model("claude-sonnet-5", "Claude Sonnet 5", "balanced, the default", reasoning=True),
            Model("claude-fable-5", "Claude Fable 5", reasoning=True),
            Model("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "fastest, cheapest"),
        ),
    ),
    Provider(
        id="openrouter",
        label="OpenRouter",
        wire="openai",
        env=("OPENROUTER_API_KEY",),
        base_url="https://openrouter.ai/api/v1",
        docs="https://openrouter.ai/keys",
        key_hint="sk-or-v1-…",
        extra_headers={"X-Title": "Aftershock"},
        models=(
            Model("anthropic/claude-sonnet-5", "Claude Sonnet 5", "via OpenRouter", reasoning=True),
            Model("openai/gpt-5.1", "GPT-5.1", "via OpenRouter", reasoning=True),
            Model("google/gemini-3-pro", "Gemini 3 Pro", "via OpenRouter"),
            Model("deepseek/deepseek-v3.2", "DeepSeek V3.2", "cheap"),
            Model("meta-llama/llama-4-maverick", "Llama 4 Maverick", "open weights"),
        ),
    ),
    Provider(
        id="openai",
        label="OpenAI",
        wire="openai",
        env=("OPENAI_API_KEY",),
        base_url="https://api.openai.com/v1",
        docs="https://platform.openai.com/api-keys",
        key_hint="sk-…",
        max_tokens_field="max_completion_tokens",
        models=(
            Model("gpt-5.1", "GPT-5.1", reasoning=True),
            Model("gpt-5.1-mini", "GPT-5.1 mini", "faster", reasoning=True),
            Model("gpt-4.1", "GPT-4.1"),
        ),
    ),
    Provider(
        id="google",
        label="Google Gemini",
        wire="openai",
        env=("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        docs="https://aistudio.google.com/apikey",
        key_hint="AIza…",
        models=(
            Model("gemini-3-pro", "Gemini 3 Pro"),
            Model("gemini-2.5-flash", "Gemini 2.5 Flash", "fast"),
        ),
    ),
    Provider(
        id="groq",
        label="Groq",
        wire="openai",
        env=("GROQ_API_KEY",),
        base_url="https://api.groq.com/openai/v1",
        docs="https://console.groq.com/keys",
        key_hint="gsk_…",
        models=(
            Model("llama-4-maverick-17b-128e-instruct", "Llama 4 Maverick", "very fast"),
            Model("qwen3-32b", "Qwen3 32B"),
        ),
    ),
    Provider(
        id="deepseek",
        label="DeepSeek",
        wire="openai",
        env=("DEEPSEEK_API_KEY",),
        base_url="https://api.deepseek.com/v1",
        docs="https://platform.deepseek.com/api_keys",
        models=(Model("deepseek-chat", "DeepSeek Chat"), Model("deepseek-reasoner", "DeepSeek Reasoner", reasoning=True)),
    ),
    Provider(
        id="xai",
        label="xAI Grok",
        wire="openai",
        env=("XAI_API_KEY",),
        base_url="https://api.x.ai/v1",
        docs="https://console.x.ai",
        key_hint="xai-…",
        models=(Model("grok-4", "Grok 4"),),
    ),
    Provider(
        id="mistral",
        label="Mistral",
        wire="openai",
        env=("MISTRAL_API_KEY",),
        base_url="https://api.mistral.ai/v1",
        docs="https://console.mistral.ai/api-keys",
        models=(Model("mistral-large-latest", "Mistral Large"),),
    ),
    Provider(
        id="ollama",
        label="Ollama (local)",
        wire="openai",
        env=("OLLAMA_HOST",),
        base_url="http://localhost:11434/v1",
        docs="https://ollama.com",
        keyless=True,
        models=(Model("qwen3:32b", "Qwen3 32B", "whatever you have pulled"),),
    ),
)

BY_ID = {p.id: p for p in PROVIDERS}
DEFAULT_MODEL = "anthropic:claude-sonnet-5"


# ---- credential store ------------------------------------------------------------------------------------------


def _store_path() -> Path:
    return get_settings().cache_dir / STORE_NAME


def _read_store() -> dict[str, str]:
    p = _store_path()
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str) and v}


def _write_store(keys: dict[str, str]) -> None:
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Write through a private temp file so a reader never sees a half-written store, and so the secret never
    # exists at the final path with default permissions.
    tmp = p.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(keys, fh)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, p)
    os.chmod(p, 0o600)


def key_for(provider_id: str) -> str | None:
    """The key to use, environment first so a deployment's own secrets always win over one pasted into the UI."""
    p = BY_ID.get(provider_id)
    if p is None:
        return None
    for var in p.env:
        v = (os.environ.get(var) or "").strip()
        if v and not v.startswith("#"):
            return v
    # config.py already resolves the Anthropic key through its own aliases, including a value from `.env`
    if provider_id == "anthropic" and (v := get_settings().anthropic_api_key):
        return v
    return _read_store().get(provider_id) or None


def set_key(provider_id: str, key: str) -> None:
    if provider_id not in BY_ID:
        raise ValueError(f"unknown provider {provider_id!r}")
    key = key.strip()
    if not key:
        raise ValueError("the key is empty")
    _write_store({**_read_store(), provider_id: key})


def clear_key(provider_id: str) -> None:
    keys = _read_store()
    if keys.pop(provider_id, None) is not None:
        _write_store(keys)


def _source(provider_id: str) -> str:
    p = BY_ID[provider_id]
    if any((os.environ.get(v) or "").strip() for v in p.env):
        return "env"
    if provider_id == "anthropic" and get_settings().anthropic_api_key and provider_id not in _read_store():
        return "env"
    return "stored" if provider_id in _read_store() else ""


def status() -> list[dict]:
    """Every provider, whether it is usable, and just enough of the key for a person to recognise it."""
    out = []
    for p in PROVIDERS:
        key = key_for(p.id)
        configured = bool(key) or p.keyless
        out.append({
            "id": p.id,
            "label": p.label,
            "wire": p.wire,
            "docs": p.docs,
            "key_hint": p.key_hint,
            "keyless": p.keyless,
            "configured": configured,
            # "env" keys are the operator's and cannot be cleared from the UI; stored ones can
            "source": _source(p.id) if key else ("local" if p.keyless else ""),
            "last4": key[-4:] if key and len(key) >= 4 else "",
            "env_vars": list(p.env),
            "models": [{"id": f"{p.id}:{m.id}", "model": m.id, "label": m.label, "note": m.note,
                        "reasoning": m.reasoning} for m in p.models],
        })
    return out


def available_models() -> list[dict]:
    """Models the server can actually run right now, flattened for the in-chat picker."""
    return [m for p in status() if p["configured"] for m in p["models"]]


# ---- model ids -------------------------------------------------------------------------------------------------


def resolve(model_id: str | None) -> tuple[Provider, str] | None:
    """`"openrouter:anthropic/claude-sonnet-5"` -> (OpenRouter, "anthropic/claude-sonnet-5").

    A bare id with no provider prefix is read as Anthropic, which is what every model id in this codebase was
    before providers existed. Returns None when the provider is unknown or has no key, so the caller can fall
    back rather than fail.
    """
    if not model_id:
        return None
    pid, _, model = model_id.partition(":")
    if not model:
        pid, model = "anthropic", pid
    p = BY_ID.get(pid)
    if p is None or not model:
        return None
    if not (key_for(p.id) or p.keyless):
        return None
    return p, model


def default_model() -> str | None:
    """What to use when the caller names no model: the configured Anthropic model, else the first usable model.

    A keyless provider is never chosen automatically. `ollama` is "configured" in the sense that it needs no
    credential, but a local server that nobody started would turn every unqualified Ask into a connection error;
    picking it has to be deliberate.
    """
    if key_for("anthropic"):
        return f"anthropic:{get_settings().model}"
    for p in PROVIDERS:
        if not p.keyless and key_for(p.id) and p.models:
            return f"{p.id}:{p.models[0].id}"
    return None
