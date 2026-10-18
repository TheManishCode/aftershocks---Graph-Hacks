# Decisions

Short records of choices that are not obvious from the code.

## D1. Every edge says how it was resolved

Static call resolution is partial: 29% of call sites resolve on Epicenter. Each `CALLS` edge records `how` and
`confidence`, and impact weights edges by those. An answer can then show *why* it believes a dependency, instead of
presenting a guess as fact.

## D2. Impact is probabilistic, and the tiers are priors

Noisy-OR over edge weights from `weights.json` gives a ranking, not a verdict. The tiers (definite ≥ 0.9, likely
≥ 0.5) are documented as priors.

`aftershock eval` exists so the tiers can be checked against a repo's own history. On click, httpx and zustand the
definite tier never fired. Read the tiers as a ranking.

## D3. Import-only dependents are a separate list, not folded into the probabilities

The miss diagnosis on click found many co-changed files that import the anchor but have no resolved call edge to the
change. Adding them as low-probability impact nodes would blur what a probability means. They are listed separately
as "imports a changed file, no resolved call", capped at 30, and not scored.

The eval's `+importers` variant measures exactly this product output. It raises recall on all three repos, and on
click it beats the directory baseline on F1.

## D4. The eval is honest about its own bias

- The indexed HEAD stands in for every past state.
- Co-change coupling is excluded from the scoring because it is mined from the same history.
- A trivial same-directory baseline is always reported next to the simulator, and it wins on httpx and zustand. That
  result is in the README rather than hidden.

## D5. tsconfig `paths` follow TypeScript's matching rules

- An exact pattern wins over a wildcard.
- Among wildcards, the longest prefix wins.
- `*` is substituted anywhere in the target, as in `./src/*.ts`.
- JSONC comments are stripped string-aware, so `"pkg/*"` is not read as a comment opener.

All of these were real bugs found on zustand.

## D6. One tool surface

The CLI, REST, MCP and the Ask agent all call `tools.py`, so the agent cannot do anything a user cannot, and security
checks live in one place.

## D7. The API key never reaches the browser

The web app proxies `/api/v1/*` server-side and adds the key there.

## D8. Overrides are stored; dispatch is derived at query time

- **Only `OVERRIDES` is stored.** A stored `Child.run → Base.run` edge is a fact the resolver can prove. The
  alternative was adding a `CALLS` edge from every caller of `Base.run` to every override. That would multiply
  edges, blur resolved calls into guesses, and inflate fan-in and PageRank.
- **Dispatch is computed when asked.** The `dispatch_callers` query walks `OVERRIDES*1..3` and then `CALLS` back
  to the callers. The hop is labelled `DISPATCH` with a separate weight (0.6) and keeps the base method as `via`, so
  the UI can say why it is there.
- **Directional queries keep their meaning.** `dependents` and `dependencies` stay as they are, so culprit and path
  results do not change silently. Culprit adds dispatch explicitly.
- **Body changes to a base method do not reach overrides.** An override replaces the body; it does not run it. The
  exception is a `super()` call, which already resolves as an ordinary `CALLS` edge. Contract changes (signature,
  rename, delete) do reach overrides, because a renamed or removed base method leaves the override overriding
  nothing.

## D9. Return types are inferred only when every return agrees

- **One shared type or nothing.** A function with no declared return type gets a hint only if every non-null
  `return` evaluates to the same known type. One unknown or different return voids it. A wrong receiver type
  creates a confident wrong edge, which is worse than an unresolved call.
- **What does not count:**
  - Returns inside nested callbacks belong to the callback.
  - A generator's call result is the generator, so `yield` values are kept apart and used only for fixtures.
- **Declared types win.** A declared return type always beats the hint. The hint is stored apart from `returns`, so
  the signature digest and the "signature changed" verdict still describe only the written contract.
- **Fixtures resolve by pytest's own lookup:** the test class, then the file, then each `conftest.py` up to the
  root. The definition must carry a `fixture` decorator, so an imported helper that happens to share the name is not
  used. Edges are still tagged `inferred`. Fixture binding follows pytest's rules, but the type behind it is still
  inferred.
- **Accepted cost.** Fixtures link every test to shared harness code (`CliRunner.invoke` on click). That makes test
  selection more complete but lowers precision against the co-change proxy. We report the drop instead of
  down-weighting correct edges to please the metric.

## D10. External calls are counted apart; the headline rate is unchanged

- **Two numbers.** `resolution_rate` is resolved ÷ all call sites, as before. `repo_resolution_rate` is resolved ÷
  call sites that are not provably external. "Provably" means one of: an imported library name, an unshadowed builtin
  or JS global, a method on a builtin or library type, or a literal receiver. A call we merely failed to resolve stays
  in the denominator.
- **Why keep the old rate.** It is comparable across versions and does not depend on how good the classifier is. The
  new one tells a user how much of the code *inside the repo* the graph sees, which is what impact analysis depends
  on.
- **Shadowing wins.** A local def, import or binding with a builtin's name is not external, so a repo that defines
  its own `open` or `fetch` is not flattered.

## D11. Runtime-built objects are synthetic shapes, never graph nodes

- **What a shape is.** An object literal, or a function value plus what `Object.assign` merged into it, becomes an
  in-memory `Def` of kind `object`. Its members are the real definitions it names. Spreads and assign sources act as
  its bases. Shapes are cached per (file, scope, literal) and never emitted, so impact, culprit and the UI only ever
  see real symbols.
- **Only named definitions count.** `{ inc: () => … }` gives no member. The arrow's calls already belong to the
  enclosing function, and inventing a symbol for it would add nodes no user wrote.
- **Curried factories are a named rule, not general higher-order inference.** A function whose return is
  `x ? g(x) : g` types both `f(a)` and `f()(a)` as `g(a)`. Other `f()()` chains stay unresolved.
- **Known imprecision.** Members reassigned later (`api.subscribe = wrapper` in middleware) are not tracked, so the
  edge lands on the original member. The original is still on the runtime path, because wrappers call it.

## D12. Callback parameters bind to what the callee passes; library values stay library

- **Binding by use, not by declared type.** `create((set, get) => …)` is resolved by reading how the callee uses its
  parameter (`createState(setState, getState, api)`), not by reading `StateCreator`'s type. The use is in the repo and
  names real definitions; a declared function type would only give another type to chase, and JS has none.
- **Bounded.** At most 5 hops through parameter hand-offs, curried targets and returned arrows, and at most 3 levels of
  nested call arguments. Spread arguments stop binding, because positions are unknown after them.
- **Anything rooted in a library value is external.** A fixture or context manager that yields a library object makes
  every call chain off it external (`client.get().json()`). This could hide a repo function returned through a
  library call, which we judged rarer than the false "blind" count it removes. Shadowing still wins (D10).

## D13. Reference repositories are hidden as "lab" graphs, not deleted

- The eval clones and reference projects (click, httpx, zustand, code-graph-rag, epicenter, epitest) exist to measure
  and improve Aftershock, not to show users. They sit in the Redis set `aftershock:lab` and are left out of every
  listing (web, API, MCP, CLI) unless asked for (`repos --all`, `?lab=1`).
- Hiding instead of dropping keeps `aftershock eval` and regression diffs working without re-indexing, and graph
  deletion needs the owner's say-so. Direct URLs still resolve, so nothing is secret; it is a listing choice only.

## D14. Overloads bind to the implementation; lookup expands the family

- Python `@overload` stubs are real definitions with `#N` ids, but they never run. Calls, member tables and method
  lookups bind to the last same-scope definition that is not a stub, which is what Python executes.
- A user naming `Context.invoke` means the whole family, so lookup returns the base id plus every `#N` variant. Stubs
  are flagged in impact and never reported as untested. The `#N` counter is stripped from every label shown to users.

## D15. Runtime evidence is opt-in, CLI-only, and runs in the repo's own interpreter

- Static edges miss what dynamic code does: fixtures, registries, duck typing. Per-test coverage (coverage.py dynamic
  contexts, the technique behind pytest-testmon and Datadog Test Impact Analysis) records which tests ran which
  function. It is stored as `(test)-[:COVERS {runs}]->(symbol)` and joins impact at hop 1 with weight 1.0.
- Recording, running and mutating execute the indexed repository's code. So they exist only in the CLI, for a trusted
  local user. They are never exposed over REST or MCP, where an indexed URL clone would become remote code execution.
- The tests run in the target's interpreter (`--python`, the repo's `.venv`, or `.aftershock/envs/<repo>` from
  `scripts/bench_env.py`), never Aftershock's own. Coverage data is read back inside that interpreter, because the
  file format is not a cross-version API. Our own coveragerc replaces the repo's, so `parallel`/`omit` settings cannot
  break the read-back.
- Re-indexing a test file drops its COVERS edges along with its other outgoing edges. Stale coverage of a changed test
  is never trusted. Coverage of changed *code* is kept until re-recorded, since the test that ran it is still the best
  guess.
- Mutation evaluation (raise at function entry in a scratch copy) gives real breakage as ground truth. That is
  stronger than co-change, but per-test coverage selects close to perfectly against it *by construction*. Reports say
  so, and the honest comparisons are static selection against a same-name baseline, plus the survived share (code no
  test notices breaking).
- Testing Library (React/DOM) is not wired in: it is a set of component-test helpers, not runnable tests, and it only
  applies to JS UIs. JS runtime evidence would need per-test V8 coverage from vitest/jest; that is planned, not built.

## D16. `heal` only keeps a round that strictly reduces the failing set; it never guesses past that

- `aftershock run` already reports failures and ranks culprits (D15). `heal` goes one step further: with `--apply`
  and an API key, it asks Claude to rewrite the top suspect's whole file, then re-runs the *same* selected tests for
  real. A round is kept only if the failing-test set after the edit is a strict subset of the failing-test set
  before it; a round that fixes nothing, or fixes one test while breaking another, is reverted immediately and the
  file is left exactly as it was found. This is checked by re-running tests, never by reading Claude's own claim that
  something is fixed.
- The edit target is always the top fault-localization suspect, not the failing test. `culprit.suspects` already
  excludes tests and modules from its candidates, so heal cannot "fix" a red test by rewriting the test itself.
- Whole-file replacement, not a diff: a diff Claude gets slightly wrong can corrupt a file in a way that is hard to
  detect from the outside; a whole file either compiles and runs or it visibly doesn't, and the pre-edit copy is kept
  in memory for an exact revert either way.
- Bounded rounds (`--max-rounds`, default 3) and a per-file size cap before sending a file to Claude. A file that
  caused a `write_rejected` or `claude_error`, or whose edit was reverted, is not retried in the same `heal` call;
  the next round moves to the next-ranked suspect instead of repeating a failed attempt.
- Dry-run by default: without `--apply` (or without `ANTHROPIC_API_KEY`), `heal` runs the selected tests and reports,
  exactly like `run`, and never calls Claude or writes anything.

## D17. Aftershock is tested end to end on scenarios with known answers, not only on unit fixtures

- Unit tests pin individual resolver rules; they cannot show that a user-visible answer is right. `testlab/` holds
  small repos where every scenario states what must follow from a change (detected change, impacted symbols, tests
  that fail, the culprit) and the runner checks the whole product path against it, including a real run of the
  fixture's suite.
- Ground truth is checked before the product is judged: a scenario's `failing` list must equal what the suite really
  fails (`truth`). A wrong scenario then reads as a scenario bug, not a product bug, and expectations cannot drift.
- Known limits are declared per check (`gaps.<check> = "why"`), reported apart, and flagged when they start passing.
  A failing check is fixed in the product or declared; expectations are never loosened to pass.
- Real bugs come from QuixBugs (published, MIT, single-bug programs with tests) rather than synthetic mutants, which
  `mutate` already covers. Buggy versions can loop, so the vendored conftest caps each test at 5 s.
- "Tests to run" is reachability, "likely to break" is probability: the first testlab run showed impact's p-pruning
  dropping a test that reached the change through dispatch. Selection now unions plain reverse reachability.
- One expectation was corrected, and it is recorded here: QuixBugs names the top-level function as the culprit, but
  two bugs sit inside a nested helper (`find_in_sorted.binsearch`, `depth_first_search.search_from`), and Aftershock
  ranked the helper first. A culprit now matches the named function or one nested in it.

## D18. The web UI can run a repo's tests, but only for the operator's own machine and only when switched on

- Users asked to run tests from the frontend. Running tests executes the repo's code, which D15 kept CLI-only. The
  API now exposes `POST /api/v1/repos/{r}/run/stream` (modes: working-tree diff, chosen symbols, whole suite, record
  coverage) as SSE with one event per test outcome, so the Tests page shows results live and ranks culprits at the
  end. It reuses `run_selected` / `record_coverage` / `culprits`; there is no second runner.
- It is off unless `AFTERSHOCK_ALLOW_RUN=1`. When on, the API also requires a loopback peer *and* a loopback Host,
  and the Next proxy requires a loopback Host and Origin (it cannot forward the client address: `x-forwarded-for`
  is client-settable). So a LAN visitor, a DNS-rebinding page, or a cross-site POST cannot start a run. A
  docker-compose deployment cannot run tests (the web→api peer is a container address): by design.
- Never exposed over MCP or to the Ask agent: a model must not be able to trigger code execution.
- One run per repo, two in total; closing the stream cancels the run and kills pytest's whole process group.
- Same pass, from the judges' review: a keyless API now answers only loopback Hosts and `AFTERSHOCK_ALLOWED_HOSTS`
  (421 otherwise), closing DNS rebinding on the REST routes as well as `/mcp`; and test selection now includes tests
  that were themselves edited or added (testmon's baseline), which impact never lists because they reach nothing.

## D19. Implicit calls become edges; eval stays static; coverage survives re-index but is marked stale

- The judges traced low recall to missing edges: `Class(...)` never reached `Class.__init__`, and dunders, `@property`
  reads and module-level values had no callers at all. `parse.py` (PARSER_VERSION 15) now records `dunder`, `prop`
  and `read` sites; `resolve.py` sends constructor calls to `__init__` / `__new__` / `__post_init__` / `constructor`
  and resolves the rest by receiver type or module home. On click this raised call-site resolution from 56% to 66%
  and edges from 3,035 to 4,058. `read` edges carry their own weight (`READ` 0.5) and only propagate when the
  changed module value's name is the one read (`diff.py` seeds carry `names`).
- Keyword-argument calls are no longer flagged as breaking: a site that also passes keywords stores
  `-(positional+2)`, and the arity check only tests the positional upper bound for it.
- Added overrides seed the base method (callers dispatching through `Base.m` now see the new subclass), and
  module-level value changes seed their readers.
- `COVERS` edges are runtime evidence the static re-index cannot rebuild, so re-indexing keeps them. Edges into a file
  whose content changed get `stale=true` and weigh `COVERS_STALE` (0.8) times as much until `aftershock coverage`
  re-records. Only content changes mark staleness; a parser bump re-parses every file but changes no code.
- `aftershock eval` replays history, but coverage describes HEAD, so feeding it into replayed commits leaks the answer.
  Eval now runs static-only (`runtime=False`). An earlier measurement on click that let coverage in looked better
  on test files for that reason; the numbers in the README are the static ones.
- Weights stay hand-set: fitting them on the three eval repos and then reporting those repos would overfit. That
  needs a held-out repo first (HANDOFF).

## D20. An absolute import resolves to the shallowest same-named module, never to a stdlib name

- A src-layout package is importable by its suffix (`src/flask` as `flask`). Two failures came from that map. flask
  has its own `flask/typing.py` and `flask/logging.py`, so `import typing as t; t.TypeVar(...)` was sent into the
  repo; names in `sys.stdlib_module_names` are now never mapped by suffix. And flask's `tests/` ships a `flask.py`
  five directories down, so `flask` had two candidates and was dropped as ambiguous: every `import flask` in the test
  suite was unresolved. Python imports from `sys.path` roots, so the candidate with the fewest leading parts dropped
  wins; a tie at the same depth stays unresolved.
- Effect on flask: 1,698 → 2,530 edges, call sites resolved 39% → 61%.

## D21. `heal` widens a green selection before calling it green

- Static selection stops at depth 6. A bug in click's `_build_prompt` fails one test about ten call hops away, so
  the selected 12 tests passed and `heal` reported "all passed" for broken code.
- When every selected test passes, `heal` now runs the tests that reach the change within `culprit.CHANGED_DEPTH`
  (12) hops (`tools.wider_tests`). If any fail, they join the selection and the normal fix loop runs. The report
  carries `widened`. Widening costs one extra run only when the first run is green.

## D22. JS closures gathered into an object literal are that object's methods (PARSER_VERSION 20)

- zustand's `createStore` builds `const api = { setState, getState, ... }` from local closures. Each closure is now
  indexed under its key in `methods_by_name`, so `api.getState()` anywhere resolves.
- A non-empty literal now always gets an `obj:` shape (empty `{}` still gets none). When a receiver is a known
  literal that lacks the member, resolution returns nothing instead of falling back to a same-named method elsewhere.
- zustand repo-internal resolution: 75.3% → 76.0%. The rest are mostly callbacks captured by mocks.

## D23. Symbol search falls back to FalkorDB full-text over names and docstrings

- `ensure_schema` creates `db.idx.fulltext.createNodeIndex('Symbol', 'name', 'doc')`. `lookup.search` keeps the
  substring match first; when it finds nothing, or a multi-word query fills less than the limit, it queries the index
  with all words (AND), then any word (OR), and tags those rows `match: "text"`, non-test symbols first.
- Query words are reduced to `[a-z0-9]+` tokens, so user input never reaches the full-text syntax. A graph without
  the index returns no rows, not an error; re-index or `ensure_schema` adds it.

## D24. The ranked head of the file list is measured, and the weights stay hand-set

- `eval` now also scores `top5` and `top10`: the first K files of the impact result's `files` list (already sorted
  by probability). K was chosen on click and httpx; on held-out flask and starlette top-5 F1 is .118 and .200 against
  .096 and .169 for all tiers. The impact result itself is not truncated; the measurement says where to read first.
- `scripts/fit_weights.py` fits `weights.json` by coordinate descent on train repos and writes only if held-out F1
  improves. Trained on click+httpx, it did not improve flask+starlette, so the weights are unchanged.

## D25. Test runs are graph facts; a test library joins the graph; heal runs from the app with the graph as context

- **Test library.** `aftershock library <repo> add <name> <dir>` registers a pytest directory outside the repo (a
  shared contract or regression suite). Its files are indexed as `@lib/<name>/<path>`, always as tests, so selection,
  impact and culprit treat them like the repo's own; they run from their own directory under `--rootdir` = the repo,
  and outcome rows are mapped back to `@lib/` ids by the file path the plugin reports. Library code is never a
  culprit suspect. A directory inside or containing the repo is refused.
- **TestRun nodes.** Every run (CLI `run`, the Tests page, each heal re-run) is written as
  `(:TestRun)-[:RAN {outcome}]->(test)`, `-[:SUSPECTS {rank, score}]->(symbol)` and `-[:RETRY_OF]->(TestRun)`. The full
  culprit report, chains included, is kept as JSON on the run. Only the last 50 runs are kept. A failure is queryable
  after the terminal is gone (`aftershock runs`, `GET /runs/{id}`, MCP `test_runs` / `run_detail`), and a test's
  history across runs separates "failing since recorded" from "flaky".
- **Heal from the app.** `POST /repos/{r}/runs/{id}/heal/stream` re-runs a recorded run's tests and, if they still
  fail, gives Claude the failure output plus `graph_context`: the hop-by-hop chain from a failing test to the suspect
  and the source of up to 4 symbols along it (the Agentless / AutoCodeRover idea of localization before repair,
  with the code graph as the localizer). Keep-only-strict-improvement is unchanged. It sits behind the same gate as
  `run` (`AFTERSHOCK_ALLOW_RUN` and loopback, also enforced in the web proxy); it does not stop when the browser
  leaves, so a half-applied edit is never abandoned mid-verify. MCP gets the read-only run tools only; nothing that
  executes code is exposed over MCP.
- **Coverage replaces static reach for measured tests.** A passing test with recorded coverage counts against a
  function only if it ran it; static reach over-approximates (an early return, an untaken branch) and so tied a
  planted bug with its callers. Classes and other unmeasured kinds, and stale coverage, keep static reach. Coverage
  recording includes the registered libraries (appended to the same data file).

## D26. Acting on the graph: measured runs, explained suspects, a fixer with graph tools, run/heal over MCP

- **Every run from the app is measured.** When the repo's python has `coverage`, the Tests page (selected or all) and
  the first run of a heal record per-test coverage as they run. Only the tests that ran have their COVERS edges
  replaced (`drop_coverage_of`), so a narrow run never erases another test's evidence, and the culprit ranking for that
  run uses what executed, not what the static graph says could execute. Heal re-runs are not measured (they run edited
  code) and are left out of a test's flakiness history for the same reason.
- **Suspects explain themselves.** Each culprit row carries `basis` (`coverage` or `static`) and `why`: how many
  failing and passing tests touched it, the Ochiai arithmetic, and the hop count to the failing test. The UI shows both.
- **The fixer is an agent over the graph.** Claude gets read-only graph tools (`symbol`, `explain_path`, `impact`,
  `run_detail`, …; at most 6 lookups on the API backend) instead of only a pasted chain, and must start with
  `Cause:` / `Evidence:` before the code. The CLI backend runs its own stdio Aftershock MCP server with
  `AFTERSHOCK_ALLOW_RUN=0`, `--tools ""` and an allow-list of graph tools, so it cannot read files, edit, or run
  anything itself. Each round keeps the explanation and the lookups it made; strict-improvement is unchanged.
- **Next steps are tool calls.** `run_detail` returns `next`: suggested calls with a reason each (`explain_path` from
  the failing test to the top suspect, `impact` of it, a flakiness query, `run_tests` if the run was unmeasured, `heal`
  if not yet retried). An MCP client picks tools from the graph's state rather than guessing.
- **Run and heal over MCP, opt-in and local only.** `run_tests` and `heal` are registered only by a stdio server
  started with `AFTERSHOCK_ALLOW_RUN=1` (the client launched it on this machine). They never exist on the HTTP `/mcp`
  endpoint, and the Ask agent drops any tool not marked read-only, so a question can never run or edit code. This
  replaces D25's "MCP never executes code".
