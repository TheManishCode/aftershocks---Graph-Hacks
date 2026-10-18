# Architecture

```
 source repo ──► ingest ──► FalkorDB graph `repo:<name>` ──► analysis ──► tools.py ──┬─► CLI (cli.py)
 (path or URL)   discover        (schema: graph.py)          impact             ├─► REST API (api.py, /api/v1)
                 parse                                        diff               ├─► MCP (mcp_server.py, stdio + /mcp)
                 resolve                                      paths / culprit    └─► Ask agent (agent.py)
                 history                                      architecture
                 pipeline                                     evaluate                web/ (Next.js) ──► /api/v1 proxy ──► API
```

## Layers

**`aftershock/ingest/`** builds the graph:

- `discover.py` lists source files, honoring `.gitignore` and skipping vendored/generated trees. It also reads
  configs such as `tsconfig.json` and `package.json`.
- `parse.py` uses tree-sitter to extract `Def`s and call sites from Python, TS/TSX and JS/JSX.
  - Call sites are calls, `new` and JSX elements.
  - Each `Def` carries arity and a body/signature digest.
  - Each `Def` also carries light type facts for receiver resolution:
    - `types`: locals, params, attributes and `with … as` bindings.
    - `ret_hint`: the type every `return` agrees on when none is declared.
  - `PARSER_VERSION` forces a re-parse when extraction changes.
- `resolve.py` turns call sites into symbol edges. Each resolution is tagged with *how* it was made (`local`,
  `import`, `module-attr`, `self`, `inferred`, `method-unique`, `name-unique`) and a confidence for that method.
  - Python imports and TS module specifiers are followed, including tsconfig `paths` with TypeScript's
    exact-before-wildcard semantics.
  - Star re-exports are followed.
  - Implicit calls (D19, Python): `Class(...)` resolves to `__init__`/`__new__`/`__post_init__`; operators and
    builtins to dunders (`dunder`); attribute reads of `@property` to the getter (`prop`); reads of module-level
    values to that value (`read`, weight `READ`, propagated only when the changed name is the one read).
  - Same-scope redefinitions get `#N` ids; calls bind to the last non-`@overload` one, and `lookup.find` expands a
    name to its whole family (D14).
  - Graphs in the Redis set `aftershock:lab` are omitted from listings (D13).
  - Receiver types are followed through annotations, assignments, declared or body-inferred returns, `with` blocks
    (via `__enter__`) and pytest fixtures, which are looked up in the test class, then the file, then each
    `conftest.py` upwards (D9). A test or fixture also gets a CALLS edge (`inferred`) to each fixture its
    parameters name, so code used only in fixture setup reaches the tests (D17).
  - Loop variables, comprehension targets, callback parameters and subscripts take the element type of a declared
    container (`list[Foo]`, `Map<K, Foo>`, Go `[]Foo`). Python type aliases and TS/JS value aliases
    (`const x = y as T`) are followed through imports.
  - Objects that factories return are synthetic *shapes* (D11). Object literals, `Object.assign` targets and curried
    factories map members to the real definitions they name. Shapes are never written to the graph.
  - Callback parameters bind to the arguments the callee calls or forwards them with, through curried factories and
    middleware (D12). Destructured names, imported module variables and `@property` return types are typed too.
  - A call that is not resolved is classified as *external* when it provably leaves the repo (library import,
    builtin, JS global, a method on a builtin/library type, a literal), and as *unresolved* otherwise (D10).
- `history.py` mines `git log` for churn, co-change coupling and owners.
- `pipeline.py` orchestrates the index:
  - It is incremental by content hash.
  - It stores `resolution_rate` and `repo_resolution_rate` (excluding external calls) on the repo node.
  - A re-indexed file replaces exactly what it owns (its symbols and their outgoing edges).
  - Untouched callers are re-linked.
  - It then computes PageRank, betweenness, communities and fan-in/out.

**`aftershock/graph.py`** is the only place Cypher lives (`QUERIES`):

- One FalkorDB graph per repo.
- Reads go through `GRAPH.RO_QUERY` with a timeout.
- Variable-length traversals are bounded by `settings.max_depth`.

**`aftershock/analysis/`** holds the questions:

- `impact.py` is a noisy-OR walk over reverse `CALLS`/`INHERITS`/`IMPLEMENTS`. It adds `OVERRIDES` for a base
  method's contract changes, and `DISPATCH`, derived at query time (D8), for callers of an overridden base method.
  - Edge weights come from `weights.json`: by change kind, by resolution method, and the transmit decay.
  - Signature changes are checked against each call site's argument count.
  - The walk is capped at `max_nodes`; when a hop overflows, its strongest nodes are kept.
  - The report adds: test selection, untested seeds, hidden co-change coupling, import-only dependents, owners and a
    risk score.
- `diff.py` classifies a git diff into symbol changes by digest, then runs impact.
- `paths.py` finds the most confident dependency chain between two symbols.
- `culprit.py` ranks suspects with Ochiai over static test reachability.
- `architecture.py` covers overview, cycles, hotspots and dead code.
- `evaluate.py` replays history to score impact (see README, *Measured accuracy*).
- `report.py` renders markdown for the CLI, PR comments and "copy as markdown".

**`aftershock/runtime/`** is runtime evidence (D15). It executes the repo's code, so it is CLI-only except for the
gated run route (D18):

- `pytest_run.py` drives pytest in the target interpreter with our plugin (`_aftershock_pytest.py`).
  - The plugin switches the coverage.py context to each test's node id and writes one JSON line per outcome.
  - `record_coverage` folds the covered lines onto function and method spans (`_aftershock_covread.py` runs in the
    target env, innermost span wins, the `def` line excluded) and replaces all `COVERS` edges.
  - `run_selected` runs the tests impact selected.
- `impact.py` adds tests that cover a seed at hop 1, as `COVERS` edges marked `runtime`. Static test selection is
  unchanged when nothing is recorded.
- Re-indexing keeps `COVERS` edges; those into files whose content changed get `stale=true` and weigh
  `COVERS_STALE` × as much until coverage is re-recorded. `eval` ignores `COVERS` (it would leak HEAD into history).
- `mutate.py` copies the repo to a temp dir. For each sampled function it raises at entry and runs the full suite;
  the newly failing tests are the ground truth. It scores static, coverage and same-name selection on recall,
  caught share and tests selected.
- `jobs.py` (D18) is the API's test run: select by mode, run with per-test events (`run_pytest` tails the plugin's
  JSON lines while pytest runs; cancel kills the process group), rank culprits. `api.py` serves it as SSE at
  `/repos/{r}/run/stream`, refused unless `AFTERSHOCK_ALLOW_RUN` and a loopback peer and Host.
- The CLI commands are `aftershock coverage | run | mutate`. Benchmark repos and their test envs live in
  `bench/repos.toml`, built by `scripts/bench_env.py`.

**`aftershock/analysis/heal.py`** (D16) is the fix loop, built on the runtime layer above and `culprit.py`, not a
fourth parallel way of running tests:

- Reuses `runtime.pytest_run.run_selected` to run the already-selected tests for real, and `tools.culprits` (so
  `--changed` refs get the same `lookup.find` resolution `run` gives them) to rank suspects on failure.
- `--apply` sends the top suspect's whole file plus the failing output to Claude (`claude-opus-5-5`, same model Ask
  uses), writes the proposed file back, and re-runs the same tests to check. A round is kept only if the failing set
  strictly shrank; otherwise the file is restored from the copy read before the edit and the next suspect is tried.
- CLI command: `aftershock heal`. Dry-run (no `--apply` or no `ANTHROPIC_API_KEY`) never calls Claude or writes.

**`aftershock/testlab.py`** + **`testlab/`** (D17) test the product end to end. Each scenario edits a fixture repo
(or swaps in a buggy twin) and is scored step by step: diff, impact, `select_tests`, a full-suite run as ground
truth, a selected-only rerun, and `culprits`. It is CLI-only (`aftershock testlab`) and uses throwaway
`testlab-<repo>` lab graphs. Format: `testlab/README.md`.

**`aftershock/tools.py`** is the single tool surface:

- `select_tests` returns impact's probable tests plus every test that statically reaches a seed (reverse reachability
  through dependents and dispatch, `reach: true`). Probability ranks; reachability decides what runs.

- The CLI, API, MCP server and Ask agent all call these functions.
- Path allow-listing (`AFTERSHOCK_REPO_ROOTS`) and clone-host checks live here.

**`aftershock/agent.py`** runs Ask:

- A deterministic router handles common question shapes.
- With `ANTHROPIC_API_KEY` set, Claude runs a bounded tool loop (8 turns) over the same tools.
- Server-side refusal fallbacks are enabled.

**`web/`** is Next.js 15 (standalone output), React 19 and Tailwind v4:

- The browser never sees the API key. `app/api/v1/[...path]` proxies to `AFTERSHOCK_API_URL` and adds
  `AFTERSHOCK_API_KEY` server-side.
- Optional basic auth (`AFTERSHOCK_WEB_PASSWORD`) is enforced in middleware.
- Pages live under `app/r/[repo]/`: overview, impact, diff, path, tests, culprit, explore, cypher
  and ask. The proxy refuses `runtime` / `repos/*/run` unless Host and Origin are loopback (D18).

## Data model

See the schema docstring at the top of `aftershock/graph.py`.

## Deployment

`docker-compose.yml` runs FalkorDB, the API and the web app:

| Service | Host port | Notes |
|---|---|---|
| FalkorDB | 6390 | browser on 3012 |
| API | 8100 | |
| Web | 3101 | |

- Everything binds to loopback by default.
- The ports avoid the Epicenter stack (6380/8000/3001).
- The GitHub Action (`action.yml`) runs `aftershock ci` against a throwaway FalkorDB container.
