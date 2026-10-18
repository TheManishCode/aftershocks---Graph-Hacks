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

A 35-second walkthrough of the web UI on httpx (overview, explore, the impact of changing `Client.send`, diff,
culprit) is in [`media/aftershock-demo.mp4`](media/aftershock-demo.mp4); `scripts/demo_video.mjs` re-records it.

## What it does

| Question | Command | API | MCP tool |
|---|---|---|---|
| What breaks if I delete / rename / change the signature or body of X? | `impact` | `POST /repos/{r}/impact` | `impact` |
| What does my working tree / PR break? | `diff`, `ci` | `POST /repos/{r}/diff` | `diff_impact` |
| Which tests should I run? | `tests` | `POST /repos/{r}/tests` | `select_tests` |
| Why does A depend on B? | `path` | `POST /repos/{r}/path` | `explain_path` |
| These tests fail — which code is the likely cause? | `culprit` | `POST /repos/{r}/culprit` | `culprit` |
| Who should review this? | — | `POST /repos/{r}/owners` | `owners` |
| Find a symbol by name or by words in its docstring | — | `GET /repos/{r}/search` | `search` |
| Architecture, cycles, hotspots, dead code | `overview` | `GET /repos/{r}/overview`, `/hotspots`, `/dead-code` | `overview` |
| Anything else, in plain English | `ask` | `POST /repos/{r}/ask`, `/ask/stream` (SSE) | — |
| Raw read-only openCypher | — | `POST /repos/{r}/cypher` | `cypher` |
| How accurate is impact on *this* repo? | `eval`, `mutate` | — | — |
| Which tests actually run this code? (records per-test coverage) | `coverage` | — | — |
| Run only the affected tests, and explain failures | `run` | — | — |
| Run the affected tests and let Claude fix what fails | `heal` | `POST /repos/{r}/runs/{id}/heal/stream` (gated) | — |
| Add an outside pytest directory to the repo's tests | `library` | `GET /repos/{r}/libraries` | `test_libraries` |
| What ran, what failed, what was suspected, what was retried? | `runs` | `GET /repos/{r}/runs`, `/runs/{id}` | `test_runs`, `run_detail` |

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

## Measured accuracy

`aftershock eval myrepo --commits 1500` replays the repo's own history. Each non-merge commit is taken in turn. Each
changed source file in it acts as the *anchor*: the symbols the commit changed there become the seeds. The simulator's
predicted files are then scored against the other source files the same commit touched. The baseline predicts every
file in the anchor's directory. Measured on 2026-10-18 at depth 3:

| Repo (cases) | Simulator, all tiers P / R / F1 | + import-only P / R / F1 | Same-dir baseline P / R / F1 |
|---|---|---|---|
| pallets/click (490) | .108 / .211 / .143 | .103 / .380 / .162 | .093 / .533 / .159 |
| encode/httpx (666) | .111 / .180 / .137 | .106 / .212 / .141 | .104 / .361 / .162 |
| pmndrs/zustand (234) | .123 / .051 / .072 | .164 / .123 / .140 | .196 / .477 / .278 |

Read these honestly:

- **Co-changed is not the same as broken.** Commits bundle unrelated edits, and many co-changed files are *callees* of
  the change, not dependents. On click (measured before override edges), 131 of the missed code files were callees and 306 had no static link at all.
- **Where it works.** The simulator is more precise than the directory baseline. With import-only added it beats the
  baseline on F1 for click.
- **Where it doesn't.** Recall is low, and on httpx and zustand the baseline wins on F1.
- **The definite tier never fired.** Treat *likely* and *possible* as "look here", not as a verdict.
- **Run it on your own repo** before trusting the tiers there.
- **Implicit-call edges raised recall, not F1 enough to win (D19).** Constructor → `__init__`, dunder, `@property`
  and module-value-read edges took call-site resolution from 56% to 66% on click and 52% to 78% on httpx. Same run,
  old code vs new, static only: click recall .167 → .211 (F1 .140 → .143; code files .151 → .180), httpx recall
  .106 → .180 (F1 .124 → .137; code files .124 → .172). Precision fell as reach widened. zustand (TypeScript) is
  unchanged: the new extraction is Python-only. The same-dir baseline still has the best F1 on all three repos.
- **Eval is static-only.** Recorded coverage describes HEAD, so letting it into replayed commits leaks the answer.
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

### Five repos, two of them held out (2026-10-18, 200 commits, depth 3)

flask and starlette were added after the weights were set and were never used to tune anything. "Top 5" is the head of
the ranked file list every impact result already carries (`files`, sorted by probability): what a reviewer reads
first. K was chosen on click and httpx; it also helped on the two held-out repos.

| Repo (cases) | All tiers F1 | Top 5 F1 (P / R) | Top 10 F1 | Same-dir baseline F1 |
|---|---|---|---|---|
| pallets/click (129) | .153 | .177 (.238 / .141) | .177 | .156 |
| encode/httpx (97) | .154 | .206 (.262 / .170) | .180 | .159 |
| pmndrs/zustand (35) | .191 | .191 (.300 / .141) | .191 | .176 |
| pallets/flask (88), held out | .096 | .118 (.141 / .102) | .125 | .144 |
| encode/starlette (127), held out | .169 | .200 (.265 / .161) | .192 | .060 |

- **The ranked head beats the directory baseline on 4 of 5 repos.** The full "possible" list beats it on 2.
- **flask is the exception.** Its own `tests/` ships a `flask.py`, so every `import flask` in the test suite was left
  unresolved as ambiguous. Fixing that (the shallowest import root wins) took flask from 1,698 to 2,530 edges and
  test-file recall from .055 to .367, but all-tier F1 fell from .127 to .096 as precision dropped (124 → 996 false
  positives): core symbols now correctly reach hundreds of tests the commit did not edit. Same pattern as click's
  `runner` fixture above.
- **Fitting the weights did not help held-out repos.** `scripts/fit_weights.py` (coordinate descent, trained on click
  and httpx) raised train F1 but not held-out F1, so `weights.json` is unchanged.

Limits of the replay itself:

- The indexed HEAD stands in for every past state.
- Seeds that no longer exist are skipped.
- Co-change coupling is mined from the same history, so it is left out of the scoring.

### Self-healing on real bugs

`scripts/heal_bench.py` plants six one-line bugs in click (each fails 1 to 57 tests of the full suite), runs
`aftershock heal --diff --apply` with a live model on each, then re-runs the **whole** suite. Run on 2026-10-18:

| Bug | Full-suite failures | Tests selected | Rank-1 culprit correct | Verdict | Full suite after | Fix is exact revert |
|---|---|---|---|---|---|---|
| `IntRange._clamp` | 2 | 8 | yes | fixed | 0 | yes |
| `_split_opt` | 50 | 431 | yes | fixed | 0 | yes |
| `join_options` | 4 | 14 | yes | fixed | 0 | yes |
| `Choice.shell_complete` | 5 | 27 | yes | fixed | 0 | yes |
| `make_str` | 57 | 353 | yes | fixed | 0 | yes |
| `_build_prompt` | 1 | 12 + 379 widened | yes | fixed | 0 | yes |

All six fixed in one round each. `_build_prompt` is the case static selection missed: its only failing test is about
ten call hops away. When the selected tests all pass, `heal` now widens to every test that reaches the change within
12 hops before calling it green (D21). Six bugs in one repo is a small sample.

### Real breakage: mutation

Co-change is a weak proxy for "broke". `aftershock mutate myrepo --n 30` uses real breakage instead. In a scratch copy,
it makes each sampled function raise at entry and runs the whole suite; the tests that newly fail are the ground truth.
It then asks each selector whether it would have picked those tests. Measured on click (2026-10-18, seed 7):

30 mutants: 18 killed by the suite, 12 survived. Over the 18 killed (630 test functions in the graph):

| Selector | Recall of failing tests | Caught the break | Tests selected (share of suite) |
|---|---|---|---|
| Static selection, parser v20 + stdlib-shadow fix | .394 | 61% | 106.5 (16.9%) |
| Static selection, implicit-call edges (D19) | .331 | 50% | 105.6 (16.8%) |
| Static selection (impact + reachability, fixture edges) | .116 | 33% | 44.2 (7.0%) |
| Static impact only (before D17) | .057 | 28% | 21.4 (3.4%) |
| Same-name file (`test_<module>.py`) | .043 | 22% | 7.5 (1.2%) |
| Recorded coverage | .997 | 100% | 154 (24%) |

- **Static selection is weak at catching real breakage on click.** Before D17 it caught 5 of 18 breaks, barely
  above the naming baseline, because click tests go through a CLI runner. Fixture edges and reachability-based
  selection doubled its recall (.057 → .116, 6 of 18 caught), and it is still far from coverage. Implicit-call edges (D19)
  then took it to .331 (9 of 18 caught) at 16.8% of the suite. Static selection alone is not enough for "which tests
  to run". That is the reason to record coverage, and on click it costs 7.6 seconds.
- 8 of the 12 survivors are in `examples/`, which has no tests. The other 4 are in `src/click`:
  `types._guess_type`, `StringParamType.__repr__`, `BashComplete._check_version` and `_AtomicFile.name`.

Read these honestly:

- **Coverage wins by construction.** A function that raises at entry fails exactly the tests that run it, which is
  what coverage records. The informative comparisons are static selection against the same-name baseline
  (`test_<module>.py`), and the survivors.
- **Survivors are untested code.** Breaking these functions entirely failed no test.
- Benchmark repos and their test environments are pinned in `bench/repos.toml`
  (`python scripts/bench_env.py click --index`).

### End to end: the testlab

`aftershock testlab` runs scenarios with known answers through the whole product. Each scenario changes a fixture
repo, then the runner checks:

- the detected change and its impact;
- the selected tests, against a full-suite run as ground truth;
- that a run of only the selected tests reproduces the failures;
- the culprit ranking.

Format and how to add scenarios: [`testlab/README.md`](testlab/README.md). Measured on 2026-10-18:

| Suite | Scenarios | Checks | Recall of failing tests | Suite selected | Culprit #1 |
|---|---|---|---|---|---|
| ledger (Python, hand-written) | 9/9 | 47/47 | 1.0 | 38% | 7/7 |
| inventory (TypeScript, static only) | 3/3 | 9/9 | – | – | – |
| QuixBugs (40 real published bugs) | 40/40 | 160/160 | 1.0 | 2.5% | 40/40 |

Read these honestly:

- **The first run found four product bugs.** It scored 6/9 on ledger, with recall .70. The bugs:
  - an edit inside an f-string went undetected;
  - impact's probability cut-off dropped a test that reached the change only through dispatch;
  - tests that reach code only through pytest fixtures were not selected;
  - `Money.of(...).format()` was unresolved.

  All four are fixed in the product, and no expectation was loosened. One expectation was corrected: two QuixBugs bugs
  live in a nested helper, which Aftershock ranked first (D17).
- **QuixBugs is easy for selection.** Each program has its own test file and few callers. The suite shows that real
  bugs are detected, selected and blamed end to end. It is not evidence of recall on a large codebase; the click
  mutation numbers above are.
- **Ledger was written for this.** Its scenarios target known hard cases: dispatch, fixtures, context managers and
  renames. Treat it as a regression suite, not a benchmark.

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
- `coverage`, `run`, `mutate` and `heal` execute the indexed repository's code and install nothing on their own.
  `heal --apply` additionally writes to the repository's own files (reverted automatically if a round doesn't help).
  `heal` and `mutate` are absent from the API; all four are absent from MCP. `run` and `coverage` are reachable
  from the web Tests page only when the API is started with `AFTERSHOCK_ALLOW_RUN=1`, and then only from loopback
  clients (D18). Run them only on code you trust, never on a repo cloned from a URL someone else gave you.
- Without an API key, the API answers only loopback Hosts and `AFTERSHOCK_ALLOWED_HOSTS` (DNS-rebinding guard).

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

## Development

```bash
docker compose up -d falkordb
pytest -q                                # graph tests skip if FalkorDB is unreachable
ruff check aftershock tests
cd web && npm install && npm test        # React Testing Library component tests
```

Tests index `tests/fixtures/mini`, a small Python + TSX repo whose call graph is known by hand, into throwaway
`pytest-*` graphs that are dropped afterwards.

## License

MIT — see [LICENSE](LICENSE).
