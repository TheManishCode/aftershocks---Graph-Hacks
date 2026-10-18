"""MCP server: a few task-shaped tools over the dependency graph, for Claude Code, Cursor and any MCP client.

Deliberately not one tool per query. An agent asks "what breaks if I change X", "which tests cover my diff",
"why does A depend on B" - each tool answers one such question with evidence paths and query receipts.

    aftershock mcp                    # stdio, for a local client
    aftershock serve                  # mounts streamable HTTP at /mcp (bearer key when AFTERSHOCK_API_KEY is set)

Two action tools, `run_tests` and `heal`, exist only on a local stdio server started with AFTERSHOCK_ALLOW_RUN=1
(D26): they execute the repo's code and edit it, so they are never registered on the HTTP mount or offered to the
Ask agent, and the heal fixer's own tool server is started with them off.
"""

from __future__ import annotations

from functools import wraps
from typing import Annotated, Literal

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError as MCPToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from . import tools as T
from .config import get_settings
from .graph import GraphUnavailable

INSTRUCTIONS = """Aftershock answers change-impact questions about indexed repositories using a FalkorDB code graph
(Symbols, Files, CALLS / INHERITS / IMPLEMENTS / OVERRIDES / IMPORTS edges, plus git co-change and ownership).

Workflow: `repos` to see what is indexed -> `search` or `symbol` to pin down names -> `impact` (hypothetical change)
or `diff_impact` (the real working-tree change) -> `select_tests` -> `explain_path` to justify a specific link.
`culprit` ranks suspects for failing tests. `test_runs` lists recorded test runs (every run and heal is stored in the
graph) and `run_detail` opens one: its failures, their suspects with the call chain from each failing test (and a
`why` for each score), each test's history across runs, the heal re-runs linked to it, and `next`: the tool calls
that would take the investigation a step further. `cypher` is a read-only escape hatch. On a local server started
with AFTERSHOCK_ALLOW_RUN=1, `run_tests` runs the tests a change reaches and `heal` fixes a recorded failing run.

Every answer carries evidence (the edge path, how each edge was resolved, its confidence) and receipts (queries run).
Impact is a risk estimate over static edges, not a proof: say so when you relay it."""

server = MCPServer("aftershock", instructions=INSTRUCTIONS, version="0.1.0")
RO = ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False)
RUNS = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)
EDITS = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False, open_world_hint=True)
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
def search(repo: Repo, q: Annotated[str, Field(description="Substring of a symbol name or file path, or plain words")],
           limit: int = 20) -> dict:
    """Find symbols and files by name. Ranked: exact names first, then non-test, then by PageRank. Several words
    ("parse options") also match names and docstrings by stemmed word; those rows carry match="text"."""
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
def test_runs(repo: Repo, limit: Annotated[int, Field(ge=1, le=50)] = 20) -> dict:
    """Recorded test runs, newest first: mode, trigger (run or heal), passed/failed counts, and `parent` when a run
    is a heal re-run of an earlier one. Runs are recorded by `aftershock run`/`heal`, the app, and `run_tests`."""
    return T.test_runs(repo, limit)


@_tool()
def run_detail(repo: Repo, run_id: Annotated[str, Field(description="A run id from `test_runs`")]) -> dict:
    """One recorded run: failing tests with messages, the culprit ranking (Ochiai over the graph and coverage, each
    suspect with its hop-by-hop chain from a failing test), each failing test's outcome history across runs (flaky
    or chronic?), and the heal re-runs that retried it (with the edit each one tried)."""
    out = T.run_detail(repo, run_id)
    out["results"] = [r for r in out["results"] if r["outcome"] != "passed"]  # passes are counted on the run
    return out


@_tool()
def test_libraries(repo: Repo) -> dict:
    """Test libraries registered with the repo: external pytest directories indexed under `@lib/<name>/...`,
    selected and run together with the repo's own tests."""
    return T.test_libraries(repo)


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
    (:File)-[:CO_CHANGES {count, strength}]-(:File); (:Person {email, name})-[:AUTHORED {commits, last}]->(:File);
    (:Symbol test)-[:COVERS {runs}]->(:Symbol); (:TestRun {id, mode, trigger, started, passed, failed})-[:RAN {outcome,
    seconds, message}]->(:Symbol test); (:TestRun)-[:SUSPECTS {rank, score, hops}]->(:Symbol);
    (:TestRun)-[:RETRY_OF]->(:TestRun)."""
    return T.cypher(repo, query, params)


def register_actions() -> None:
    """The two tools that execute code (D26). Called only by `main` for a stdio server with AFTERSHOCK_ALLOW_RUN."""
    from .runtime import jobs
    from .runtime.pytest_run import RuntimeErrorReport

    def quiet(kind: str, data: dict) -> None:  # stdio carries the protocol; progress has nowhere to go
        pass

    def act(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except RuntimeErrorReport as e:  # no interpreter, pytest missing, ...: the client can act on it
            raise T.ToolError(str(e)) from e

    @_tool(RUNS)
    def run_tests(
        repo: Repo,
        mode: Annotated[Literal["diff", "targets", "all"],
                        Field(description="diff: tests the working-tree change reaches; targets: tests reaching "
                                          "`targets`; all: the whole suite and test libraries")] = "diff",
        targets: Annotated[list[str] | None, Field(description="Symbols, for mode=targets")] = None,
    ) -> dict:
        """Run the tests a change reaches, for real, in the repo's own interpreter (measured by per-test coverage
        when it has `coverage`). Records the run in the graph and returns its `run_id`, counts and, when tests fail,
        the culprit ranking. Open it with `run_detail`; fix it with `heal`."""
        return act(jobs.run_tests, repo, mode, quiet, targets=targets)

    @_tool(EDITS)
    def heal(repo: Repo, run_id: Annotated[str, Field(description="A recorded run with failing tests")],
             max_rounds: Annotated[int, Field(ge=1, le=5)] = 3) -> dict:
        """EDITS THE REPO. Re-run a recorded failing run; while tests fail, have Claude fix the top-ranked suspect
        (with the graph's call chain and read-only graph tools), re-run, and keep an edit only if the failing set
        strictly shrinks; anything else is reverted. Each round has the diff, the cause and evidence the fixer gave,
        and the graph lookups it made. Every re-run is recorded RETRY_OF the run before."""
        if not T.RUN_ID.match(run_id):
            raise T.ToolError(f"invalid run id {run_id!r}")
        return act(jobs.heal_run, repo, run_id, quiet, max_rounds=max_rounds)


def main(transport: str = "stdio") -> None:
    if transport == "stdio" and get_settings().allow_run:
        register_actions()
    server.run(transport)  # type: ignore[arg-type]


if __name__ == "__main__":
    main()
