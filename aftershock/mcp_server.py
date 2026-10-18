"""MCP server: a few task-shaped tools over the dependency graph, for Claude Code, Cursor and any MCP client.

Deliberately not one tool per query. An agent asks "what breaks if I change X", "which tests cover my diff",
"why does A depend on B" - each tool answers one such question with evidence paths and query receipts.

    aftershock mcp                    # stdio, for a local client
    aftershock serve                  # mounts streamable HTTP at /mcp (bearer key when AFTERSHOCK_API_KEY is set)
"""

from __future__ import annotations

from functools import wraps
from typing import Annotated, Literal

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError as MCPToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from . import tools as T
from .graph import GraphUnavailable

INSTRUCTIONS = """Aftershock answers change-impact questions about indexed repositories using a FalkorDB code graph
(Symbols, Files, CALLS / INHERITS / IMPLEMENTS / OVERRIDES / IMPORTS edges, plus git co-change and ownership).

Workflow: `repos` to see what is indexed -> `search` or `symbol` to pin down names -> `impact` (hypothetical change)
or `diff_impact` (the real working-tree change) -> `select_tests` -> `explain_path` to justify a specific link.
`culprit` ranks suspects for failing tests. `cypher` is a read-only escape hatch.

Every answer carries evidence (the edge path, how each edge was resolved, its confidence) and receipts (queries run).
Impact is a risk estimate over static edges, not a proof: say so when you relay it."""

server = MCPServer("aftershock", instructions=INSTRUCTIONS, version="0.1.0")
RO = ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False)
Repo = Annotated[str, Field(description="Indexed repository name (see `repos`)")]


MAX_ITEMS = 40


def _compact(v, depth: int = 0):
    """Agents pay per token: cap long lists (noting how many were dropped), drop per-query logs and float noise."""
    if isinstance(v, dict):
        return {k: _compact(x, depth + 1) for k, x in v.items() if k not in ("log", "model")}
    if isinstance(v, list):
        cap = MAX_ITEMS if depth <= 1 else 12
        out = [_compact(x, depth + 1) for x in v[:cap]]
        return out + [f"... {len(v) - cap} more"] if len(v) > cap else out
    if isinstance(v, float):
        return round(v, 4)
    return v


def _tool(annotations: ToolAnnotations = RO):
    """Register a sync tool; caller mistakes surface as readable tool errors, everything else stays opaque."""

    def deco(fn):
        @wraps(fn)
        def inner(*a, **kw):
            try:
                return _compact(T.run(fn, *a, **kw))
            except (T.ToolError, GraphUnavailable) as e:
                raise MCPToolError(str(e)) from e

        return server.tool(annotations=annotations)(inner)

    return deco


@_tool()
def repos() -> dict:
    """List indexed repositories with size, resolution rate and the commit they were indexed at."""
    return T.list_repos()


@_tool()
def search(repo: Repo, q: Annotated[str, Field(description="Substring of a symbol name or file path")],
           limit: int = 20) -> dict:
    """Find symbols and files by name. Ranked: exact names first, then non-test, then by PageRank."""
    return T.search(repo, q, limit)


@_tool()
def symbol(repo: Repo, ref: Annotated[str, Field(description="Name, `Class.method`, `path::qname` id, or file path")]
           ) -> dict:
    """One symbol with its direct callers and callees (each edge with resolution method and confidence).
    Returns `candidates` instead when the name is ambiguous - pick one id and call again."""
    return T.symbol(repo, ref)


@_tool()
def impact(
    repo: Repo,
    targets: Annotated[list[str], Field(description="Symbols or files that would change")],
    change: Annotated[Literal["body", "signature", "rename", "delete"],
                      Field(description="Kind of change; signature/rename/delete break callers more often")] = "body",
    depth: Annotated[int | None, Field(description="Max hops (default and cap from server config)")] = None,
) -> dict:
    """What breaks if these symbols change. Multi-hop reverse traversal of the call/inheritance graph with a
    noisy-OR break probability per symbol, tiers (definite/likely/possible), the evidence path for each, tests that
    reach the change, hidden co-change coupling, owners, and a 0-100 risk score. Includes a `markdown` summary."""
    return T.impact_of(repo, targets, change, depth, markdown=True)


@_tool()
def diff_impact(repo: Repo,
                rev: Annotated[str | None, Field(description="Git revision to compare; omit for the working tree")] = None,
                depth: int | None = None) -> dict:
    """Detect what actually changed (symbol by symbol: signature/body/rename/delete/added) in the repo's checkout
    versus the indexed graph, then run `impact` on it. `markdown` is a ready-to-post PR comment."""
    return T.diff_impact(repo, rev, depth)


@_tool()
def select_tests(repo: Repo, targets: list[str] | None = None, rev: str | None = None) -> dict:
    """Tests that statically reach a change: from `targets`, or from the working-tree diff when targets is empty."""
    return T.select_tests(repo, targets, rev)


@_tool()
def explain_path(repo: Repo, source: Annotated[str, Field(description="The dependent (e.g. a route handler)")],
                 target: Annotated[str, Field(description="The dependency (e.g. a DB helper)")],
                 depth: int = 8) -> dict:
    """Why does `source` depend on `target`? The shortest call/inherit chain with per-edge evidence, falling back to
    a file import chain, then to git co-change. Tries the reverse direction too."""
    return T.explain_path(repo, source, target, depth)


@_tool()
def culprit(repo: Repo, failing: Annotated[list[str], Field(description="Failing test names or ids")],
            changed: Annotated[list[str] | None, Field(description="Recently changed symbols, if known")] = None,
            limit: int = 15) -> dict:
    """Rank the code most likely responsible for failing tests (Ochiai over static reachability; changed code
    weighted up). Each suspect comes with the call path from a failing test."""
    return T.culprits(repo, failing, changed, limit)


@_tool()
def overview(repo: Repo) -> dict:
    """Architecture at a glance: subsystems (import communities), dependency cycles, hotspots (churn x complexity),
    load-bearing symbols (PageRank, betweenness) and dead-code candidates."""
    return T.overview(repo)


@_tool()
def owners(repo: Repo, paths: Annotated[list[str], Field(description="Repo-relative file paths")]) -> dict:
    """Who has changed these files most (from git history), and which other files tend to change with them."""
    return T.owners(repo, paths)


@_tool()
def cypher(repo: Repo, query: Annotated[str, Field(description="Read-only openCypher")],
           params: dict | None = None) -> dict:
    """Read-only Cypher escape hatch. Writes are rejected, variable-length patterns must be bounded, rows capped.
    Schema: (:File {path, lang, loc, churn, community})-[:DEFINES]->(:Symbol {id, name, qname, kind, file, line,
    signature, pagerank, fan_in, fan_out, is_test}); (:Symbol)-[:CALLS {how, confidence, lines, kind}]->(:Symbol);
    [:INHERITS], [:IMPLEMENTS], [:OVERRIDES], [:CONTAINS]; (:File)-[:IMPORTS {names, line}]->(:File); (:File)-[:USES]->(:External);
    (:File)-[:CO_CHANGES {count, strength}]-(:File); (:Person {email, name})-[:AUTHORED {commits, last}]->(:File)."""
    return T.cypher(repo, query, params)


def main(transport: str = "stdio") -> None:
    server.run(transport)  # type: ignore[arg-type]


if __name__ == "__main__":
    main()
