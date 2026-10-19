# How it works

What each instrument computes, what it trusts, and where it stops. For how the code is laid out, see [`ARCHITECTURE.md`](../ARCHITECTURE.md); for why, [`DECISIONS.md`](../DECISIONS.md) (the `D<n>` references below).

[← README](../README.md) · [Benchmarks](benchmarks.md)

## The instruments


`coverage`, `run`, `mutate` and `heal` execute the repository's own tests (`heal` also writes to its files, behind
`--apply`). From the API, `run` and `heal` work only when the server is started with
`AFTERSHOCK_ALLOW_RUN=1` and the request comes from the same machine (D18, D25). MCP executes code only through
`run_tests` and `heal`, which exist only on a stdio server started with `AFTERSHOCK_ALLOW_RUN=1` (D26).

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

**Culprit** ranks code reached by the failing tests with Ochiai suspiciousness over static reachability. When coverage
is recorded, it also uses the functions each test actually ran. Changed code is boosted, and ties go to the code
nearest the tests.

**Runtime evidence** (optional, Python/pytest) closes the biggest static blind spot. `aftershock coverage myrepo` runs
the suite once, in the repo's own interpreter, under per-test coverage, the technique behind pytest-testmon and Datadog
Test Impact Analysis. Every test that executed a function gets a `COVERS` edge to it. Impact and test selection then
include those tests, marked "ran it", even when fixtures, registries or duck typing hide the call from static
analysis. On click, `wrap_text` goes from 12 statically selected tests to 122, and `Context.invoke` from 0 to 265.
`aftershock run myrepo --diff` runs only the selected tests and, if any fail, ranks culprits for them.

**Tests page.** Start the API with `AFTERSHOCK_ALLOW_RUN=1 aftershock serve` and open a repo's *Tests* page to do the
same from the browser: pick the working-tree diff, some symbols, the whole suite, or "record coverage", and watch each
test's result arrive live, then the ranked culprits. It needs the repo's interpreter (`<repo>/.venv` or a bench env)
and works only from the machine running the API.

**Script library (D28).** Aftershock ships its test scripts; nobody writes or registers them. Each of the 194
scripts says what it checks and when it applies (a Dockerfile check only shows up for a repo with a Dockerfile).
`check` scripts read files, `graph` scripts query the index, and `command` scripts run an installed tool (pytest
modes, ruff, mypy, eslint, tsc, cargo, shellcheck, gitleaks, …). Pick scripts on the *Tests* page, or ask in plain
English ("check this repo for leaked secrets and broken config") and the Ask agent picks and runs them.

```bash
aftershock scripts list myrepo --category security
aftershock scripts run myrepo                      # every applicable read-only script
aftershock scripts run myrepo pytest.collect py.ruff
```

`check` and `graph` scripts run anywhere the API key reaches. `command` scripts execute code, so the API and MCP run
them only behind `AFTERSHOCK_ALLOW_RUN=1` from loopback, as for tests. The CLI runs as you, like `run`. Only the
pytest modes are recorded as test runs in the graph; every batch of script results is kept too (the last 20 per
repo), and the library shows the newest one when the page opens.

**Installs and probes (D29).** A script whose tool is missing offers *Install* (a fixed pip/npm recipe) or *Set up*
(create the repo's test interpreter and install its test requirements), or shows the command when the tool needs the
system package manager. `aftershock setup myrepo [--tools ruff mypy]` does the same from a terminal. Five scripts are
Aftershock's own: `py.import-smoke`, `py.cli-smoke`, `pytest.flaky` (forward, reversed, forward),
`pytest.isolation` (each test file alone vs. the suite), and `ai.unit-tests` (model-written tests for untested central
code, kept only if they pass; operator only).

**Showcase repos (D29).** On a public server, `AFTERSHOCK_SHOWCASE_REPOS=ledger,flask` lets any visitor run tests,
scripts, setup and installs on those repos only: one public run at a time, `AFTERSHOCK_PUBLIC_RUN_TIMEOUT` seconds at
most, and nobody but the operator may re-index, delete or extend them. `scripts/showcase.sh` provisions them on a
compose deployment. Heal stays on the operator's machine.

**The test loop (D25).** Every run is recorded in the graph. When tests fail, *Investigate in Culprit* opens the
run: each failure with its history, the ranked suspects with the call chain from the failing test to each, and the
pytest output. *Fix with AI* re-runs the tests, sends Claude the failure plus that chain and the source along it, applies
the fix, re-runs, and keeps the edit only if fewer tests fail; every re-run is a new recorded run linked to the one
it retries. Tests from outside the repo join with `aftershock library myrepo add contracts ../contract-tests`.

**Acting on the graph (D26).** Runs from the app record coverage as they go, so suspects are ranked on what the
failing tests actually executed; each suspect says why (`measured by coverage: 1 of 1 failing, 0 of 1 passing …`).
The fixer looks things up in the graph itself (callers, paths, impact) and answers *Cause* and *Evidence* before its
diff; the UI shows both and the lookups. `run_detail` suggests the next tool calls. An MCP client such as Claude Code
can drive the whole loop when it launches the server itself with run access:

```json
{"mcpServers": {"aftershock": {"command": "aftershock", "args": ["mcp"], "env": {"AFTERSHOCK_ALLOW_RUN": "1"}}}}
```

**`aftershock heal myrepo --diff --apply`** is `run` plus a fix attempt: for a failure, it asks Claude to rewrite the top culprit's whole file, then re-runs the same tests for real to check. A round is kept only if it strictly reduces the number of failing tests; otherwise it is reverted and the next suspect is tried, up to `--max-rounds` (default 3). Without `--apply` (or without `ANTHROPIC_API_KEY`), it only reports, like `run` — this is the "AI reads the code, selects tests, runs them, and tries to resolve failures" ask from the track brief, built on the same coverage-aware test selection and Ochiai culprit ranking as the rest of Aftershock, rather than as a separate bolt-on.

**Ask** routes common question shapes to the right tool deterministically. With `ANTHROPIC_API_KEY` set, free-form
questions go to Claude (`claude-opus-5`), which calls the same tools as the MCP server in a bounded loop (8 turns) and
answers from the graph evidence. The request enables Anthropic's server-side fallbacks: if the primary model declines,
the API may retry on a fallback model. API errors fall back to the router.


## Languages

Python, TypeScript/TSX, and JavaScript/JSX via tree-sitter, all tested on real repositories. Go, Java, and Rust are
also parsed and resolved, but only unit tests cover them; no Go, Java, or Rust repository has been evaluated. Calls,
`new`, and JSX element usage become `CALLS` edges. Classes get `INHERITS`/`IMPLEMENTS`, and a method that redefines an
inherited one (including a Rust trait impl) gets `OVERRIDES`. Files get `IMPORTS`. Indexing is incremental by content hash: only changed files
are re-parsed, and edges from untouched callers are re-linked.


## Limits

Static analysis by default; recorded per-test coverage (Python only) adds what the suite actually executes. Statically,
reflection, monkey-patching, and string-built calls are not seen. Dynamic dispatch is followed
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
- `heal` is Python/pytest-only (same reason as runtime evidence: no JS per-test runtime layer yet).
- In TypeScript:
  - A package importing itself by its `package.json` name resolves only when tsconfig `paths` maps it.

See `ARCHITECTURE.md` for how the pieces fit, `DECISIONS.md` for why, and `HANDOFF.md` for current state.

