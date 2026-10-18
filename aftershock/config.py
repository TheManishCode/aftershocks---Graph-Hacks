"""Runtime settings. Every field reads `AFTERSHOCK_<NAME>` (or the bare name for shared ones like FALKORDB_URL).

Blank values and values starting with `#` count as unset, so a half-filled `.env` copied from `.env.example`
never turns a placeholder into a real secret.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _value(v):
    if isinstance(v, str):
        v = v.strip()
        if not v or v.startswith("#"):
            return None
    return v


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AFTERSHOCK_", env_file=".env", extra="ignore")

    falkordb_url: str = Field(
        "redis://:aftershock@localhost:6390", validation_alias=AliasChoices("FALKORDB_URL", "AFTERSHOCK_FALKORDB_URL")
    )
    query_timeout_ms: int = 15_000
    write_timeout_ms: int = 60_000  # must not exceed the server's TIMEOUT_MAX (docker-compose sets 60000)
    socket_timeout_s: float = 70.0
    max_depth: int = 6  # hard cap on any variable-length traversal
    max_rows: int = 5_000

    api_key: str | None = None  # when set, every mutating route and /mcp require `Authorization: Bearer <key>`
    web_origin: str = "http://localhost:3101"
    allowed_hosts: str = ""  # extra Host headers /mcp accepts besides localhost, e.g. "aftershock.example.com,api:8100"
    repo_roots: str = ""  # os.pathsep-separated directories local indexing may read; empty = cwd only
    clone_dir: Path = Path(".aftershock/clones")
    clone_max_mb: int = 500
    clone_timeout_s: int = 300
    allowed_clone_hosts: str = "github.com,gitlab.com,bitbucket.org,codeberg.org"
    cache_dir: Path = Path(".aftershock/cache")
    env_dir: Path = Path(".aftershock/envs")  # per-repo test interpreters (scripts/bench_env.py)
    history_commits: int = 2_000  # git log depth mined for churn / co-change / owners
    allow_run: bool = False  # D18: let the API run a repo's tests (loopback clients only); never exposed over MCP
    # D29: comma-separated repos anyone with web access may run, set up and install tools for. The operator indexes
    # them on the server; the API refuses to re-index, delete or attach libraries to them, so a visitor can't swap
    # the code that runs. Public runs are capped (one at a time, `public_run_timeout`), and heal stays local.
    showcase_repos: str = ""
    public_run_timeout: int = 300

    anthropic_api_key: str | None = Field(
        None, validation_alias=AliasChoices("ANTHROPIC_API_KEY", "AFTERSHOCK_ANTHROPIC_API_KEY")
    )
    model: str = "claude-opus-5"

    @field_validator("*", mode="before")
    @classmethod
    def _blank_is_unset(cls, v, info):
        v = _value(v)
        if v is None:  # fall back to the declared default rather than failing an int/str field on ""
            return cls.model_fields[info.field_name].get_default(call_default_factory=True)
        return v

    def roots(self) -> list[Path]:
        import os

        parts = [p for p in (self.repo_roots or "").split(os.pathsep) if p.strip()]
        return [Path(p).expanduser().resolve() for p in parts] or [Path.cwd().resolve()]

    def allowed_host_list(self) -> list[str]:
        return [h.strip() for h in self.allowed_hosts.split(",") if h.strip()]

    def showcase(self) -> set[str]:
        return {r.strip() for r in self.showcase_repos.split(",") if r.strip()}

    def clone_hosts(self) -> set[str]:
        return {h.strip().lower() for h in self.allowed_clone_hosts.split(",") if h.strip()}


@lru_cache
def get_settings() -> Settings:
    return Settings()
