# Aftershock

**What breaks if I change this?** Aftershock indexes a codebase into a [FalkorDB](https://falkordb.com) property graph —
files, symbols, calls, inheritance, method overrides, imports, tests, and git co-change — and answers dependency questions with graph
traversals instead of grep. Every answer carries its evidence: the hop-by-hop path, how each edge was resolved, and how
confident that resolution is.

Built for Track 01 of the WeMakeDevs × FalkorDB *Graph Hacks* hackathon, on top of the Epicenter and Tessera codebases.

```
$ aftershock path shop get_user connect
**get_user depends on connect in 2 hops (path confidence 0.81)** — call chain:

1. `get_user` (shop/api.py:4) **calls** `load_user` (shop/service.py:4) — resolved module-attr, confidence 0.90
2. `load_user` (shop/service.py:4) **calls** `connect` (shop/db.py:12) — resolved import, confidence 0.90
```

(Output from the test fixture in `tests/fixtures/mini`. CLI output is markdown so it pastes into PRs and chat.)

## What it does

| Question | Command | API | MCP tool |
|---|---|---|---|
| What breaks if I delete / rename / change the signature or body of X? | `impact` | `POST /repos/{r}/impact` | `impact` |
| What does my working tree / PR break? | `diff`, `ci` | `POST /repos/{r}/diff` | `diff_impact` |
| Which tests should I run? | `tests` | `POST /repos/{r}/tests` | `select_tests` |
| Why does A depend on B? | `path` | `POST /repos/{r}/path` | `explain_path` |
| These tests fail — which code is the likely cause? | `culprit` | `POST /repos/{r}/culprit` | `culprit` |
| Who should review this? | — | `POST /repos/{r}/owners` | `owners` |
| Architecture, cycles, hotspots, dead code | `overview` | `GET /repos/{r}/overview`, `/hotspots`, `/dead-code` | `overview` |
| Anything else, in plain English | `ask` | `POST /repos/{r}/ask`, `/ask/stream` (SSE) | — |
| Raw read-only openCypher | — | `POST /repos/{r}/cypher` | `cypher` |
| How accurate is impact on *this* repo? | `eval` | — | — |

**Impact** is a probabilistic multi-hop walk over reverse dependencies. Each edge's weight depends on the change kind
(delete > rename > signature > body), how the call was resolved (local / import / module-attr / inferred), and the edge
type. Signature changes are checked against each call site's argument count, so a caller that still passes valid
arguments is downgraded and one that cannot is flagged with the reason. Results are tiered *definite / likely /
possible* and rolled into a 0–100 risk score. The weights live in `aftershock/analysis/weights.json`; they are priors,
not measured accuracy. Overrides are followed both ways. When a base method's contract changes (signature, rename, or
delete), each override is impacted, and its arity is checked against the new signature. When an override changes,
callers bound to the base method are reached through a *dispatch* step, because at run time they may be calling the
override. A body change to a base method does not reach its overrides, since they replace that body. Separately,
*import-only dependents* lists files that import a changed file but have no
resolved call into the change. Those calls usually went through an alias or untyped receiver and never resolved. The
list is not scored.

**Diff** maps a git diff to symbol-level changes (added, deleted, renamed, signature, body) by comparing the working
tree against the indexed snapshot, then runs impact on all of them at once.

**Culprit** ranks code reached by the failing tests with Ochiai suspiciousness over static reachability. Changed code is
boosted, and ties go to the code nearest the tests.

**Ask** routes common question shapes to the right tool deterministically. With `ANTHROPIC_API_KEY` set, free-form
questions go to Claude (`claude-opus-5-5`), which calls the same tools as the MCP server in a bounded loop (8 turns) and
answers from the graph evidence. The request enables Anthropic's server-side fallbacks: if the primary model declines,
the API may retry on a fallback model. API errors fall back to the router.

## Measured accuracy

`aftershock eval myrepo --commits 1500` replays the repo's own history. Each non-merge commit is taken in turn. Each
changed source file in it acts as the *anchor*: the symbols the commit changed there become the seeds. The simulator's
predicted files are then scored against the other source files the same commit touched. The baseline predicts every
file in the anchor's directory. Measured on 2026-10-18 at depth 3:

| Repo (cases) | Simulator, all tiers P / R / F1 | + import-only P / R / F1 | Same-dir baseline P / R / F1 |
|---|---|---|---|
| pallets/click (490) | .121 / .167 / .140 | .109 / .358 / .167 | .093 / .533 / .159 |
| encode/httpx (666) | .149 / .095 / .116 | .127 / .144 / .135 | .104 / .361 / .162 |
| pmndrs/zustand (234) | .123 / .051 / .072 | .164 / .123 / .140 | .196 / .477 / .278 |

Read these honestly:

- **Co-changed is not the same as broken.** Commits bundle unrelated edits, and many co-changed files are *callees* of
  the change, not dependents. On click (measured before override edges), 131 of the missed code files were callees and 306 had no static link at all.
- **Where it works.** The simulator is more precise than the directory baseline. With import-only added it beats the
  baseline on F1 for click.
- **Where it doesn't.** Recall is low, and on httpx and zustand the baseline wins on F1.
- **The definite tier never fired.** Treat *likely* and *possible* as "look here", not as a verdict.
- **Run it on your own repo** before trusting the tiers there.
- **Overrides helped a little.** Adding override and dispatch edges moved simulator F1 from .153 to .157 on click and
  from .102 to .113 on httpx. zustand has no class hierarchies, so it was unchanged.
- **More correct edges can score worse.** Return-type, `with` and pytest-fixture inference raised call-site resolution
  from 41% to 49% on click and from 47% to 50% on httpx, and a hand check of sampled new edges found none wrong. httpx
  F1 rose from .113 to .117. click F1 fell from .157 to .148, all of it in test files (test precision dropped from .210
  to .160). Most click tests go through one `runner` fixture, so a core change now correctly reaches about 350 tests.
  The commit rarely edits them, and the co-change proxy counts them as misses.
- **Callback binding left F1 flat.** Binding `set`/`get`-style callback parameters and `@property` types added 85
  zustand and 21 httpx edges, all correct in a hand check, and moved F1 by at most .002 either way. They are mostly
  test → store-API links, which the same commit rarely edits.
- **Overload binding fixed test selection but cost click F1.** Binding calls to the implementation behind
  `@overload` stubs took test selection for `Context.invoke` from 0 to 350 tests, and click F1 moved from .149 to
  .140 (re-run after the final fix). The cause is not yet isolated; see HANDOFF. httpx and zustand were unchanged.

Limits of the replay itself:

- The indexed HEAD stands in for every past state.
- Seeds that no longer exist are skipped.
- Co-change coupling is mined from the same history, so it is left out of the scoring.

## Languages

Python, TypeScript/TSX, and JavaScript/JSX via tree-sitter, all tested on real repositories. Go, Java, and Rust are
also parsed and resolved, but only unit tests cover them; no Go, Java, or Rust repository has been evaluated. Calls,
`new`, and JSX element usage become `CALLS` edges. Classes get `INHERITS`/`IMPLEMENTS`, and a method that redefines an
inherited one (including a Rust trait impl) gets `OVERRIDES`. Files get `IMPORTS`. Indexing is incremental by content hash: only changed files
are re-parsed, and edges from untouched callers are re-linked.

## Quick start

```bash
docker compose up -d falkordb           # graph on :6390, browser on :3012
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev,agent]"

aftershock index ~/code/myrepo           # or an https GitHub/GitLab/Bitbucket/Codeberg URL
aftershock impact myrepo parse_config --change signature
aftershock diff myrepo                   # what the uncommitted changes break
aftershock ask myrepo "which tests cover parse_config"
aftershock serve                         # API on 127.0.0.1:8100
```

Reference or eval graphs can be hidden from listings without deleting them: `aftershock lab myrepo`
(`--off` to show it again; `aftershock repos --all` lists everything).

Every command accepts `--json`. Exit codes: `2` bad input, `3` risk gate failed, `4` graph unavailable.

Full stack (graph + API + web UI): `cp .env.example .env`, set `AFTERSHOCK_API_KEY`, then `docker compose up -d`.

## Pull-request checks

`aftershock ci` indexes the PR's merge-base (in a throwaway git worktree; skipped when that commit is already
indexed), analyzes `HEAD` against it, writes a markdown report, and exits `3` if the risk reaches `--fail-on`.

The bundled GitHub Action (`action.yml`) runs that with a throwaway FalkorDB container. It posts the report as a PR
comment, updating the same comment on each push, and adds it to the job summary. See `examples/github-workflow.yml`.
Check out with `fetch-depth: 0`.

## MCP

```bash
aftershock mcp                           # stdio, for Claude Code / Claude Desktop / Cursor
```

The API also serves streamable HTTP at `/mcp` (same bearer key). All tools are read-only and annotated as such.

```json
{ "mcpServers": { "aftershock": { "command": "aftershock", "args": ["mcp"] } } }
```

## Security

- `AFTERSHOCK_API_KEY` guards every `/api/v1` route except `/health`, and `/mcp`. Compared in constant time.
- The API only indexes paths under `AFTERSHOCK_REPO_ROOTS` and only clones `https` URLs from
  `AFTERSHOCK_ALLOWED_CLONE_HOSTS`, without credentials in the URL. Errors do not echo server paths.
- `/cypher` accepts read-only queries only (write clauses, procedures that mutate, and unbounded variable-length
  paths are rejected) and runs them with `GRAPH.RO_QUERY` under the configured query timeout.
- `/mcp` has DNS-rebinding protection; add public hostnames via `AFTERSHOCK_ALLOWED_HOSTS`.
- The CLI is for a trusted local user and may index any local path.

## Limits

Static analysis only. Reflection, monkey-patching, and string-built calls are not seen. Dynamic dispatch is followed
only through overrides of a method in the same resolved class hierarchy; duck-typed calls with no shared base are not.
Receiver types come from annotations and assignments. They also come from return types, declared or read from the
body when every `return` agrees, `with X() as x`, pytest fixtures, loop variables and subscripts of typed containers,
type aliases, and objects that factories return (`return { getState, setState }`, `Object.assign(fn, api)`, curried
`create<T>()(init)`), destructuring (`const { getState } = store`), `@property` return types, and callback parameters
bound to what the callee passes them (`create((set, get) => …)`, through middleware that hands them on). They do not
come from members reassigned after creation, spread arguments, or untyped parameters the repo never calls.

`index` and `overview` report two rates; read impact results with them in mind. The first is resolved ÷ all call
sites. The second excludes calls that provably go to a library, builtin or JS global (D10):

| Repo | All call sites | Repo-bound calls |
|---|---|---|
| click | 49.8% | 70.1% |
| httpx | 50.4% | 66.3% |
| code-graph-rag | 46.3% | 59.9% |
| Epicenter | 31.3% | 52.7% |
| zustand | 33.3% | 75.3% |

Most of zustand's remaining gap is members that middleware adds at runtime (`api.persist.*`), wrapped `set` functions
that `persist` passes in, spread arguments in `combine`, and test mocks.

Other known gaps:

- Culprit ranks nothing when the failing tests' own calls are unresolved.
- The deterministic Ask router only recognizes common question shapes.
- In TypeScript:
  - A package importing itself by its `package.json` name resolves only when tsconfig `paths` maps it.

See `ARCHITECTURE.md` for how the pieces fit, `DECISIONS.md` for why, and `HANDOFF.md` for current state.

## Development

```bash
docker compose up -d falkordb
pytest -q                                # graph tests skip if FalkorDB is unreachable
ruff check aftershock tests
```

Tests index `tests/fixtures/mini`, a small Python + TSX repo whose call graph is known by hand, into throwaway
`pytest-*` graphs that are dropped afterwards.

## License

Not chosen yet. Neither base project ships a license file; add one before publishing.
