# Changelog

## Unreleased (2026-10-19)

### Added: test results for every visitor, installs from the page, Aftershock's own probes (D29)

The public site refused every run, so nobody but the operator ever saw a result or a culprit. Now:

- **Showcase repos.** `AFTERSHOCK_SHOWCASE_REPOS=ledger,flask` names repos any visitor may run tests and scripts on,
  set up and install tools for. Public runs are capped (`AFTERSHOCK_PUBLIC_RUN_TIMEOUT`, default 300 s) and limited to
  one at a time across the site (429 + `Retry-After`). Re-indexing, deleting or attaching libraries to a showcase
  repo is operator only, so a visitor can't swap the code that runs. Heal and `ai.unit-tests` stay operator only.
- **The web proxy marks remote visitors** with `X-Aftershock-Remote`; the API treats them as non-local. The header
  only narrows access, so a forged one costs the sender, not the server.
- **Script results are recorded** (`ScriptRun` nodes, last 20 per repo, `GET /repos/{r}/scripts/runs[/{id}]`).
  The library shows the newest batch on load, labelled with when it ran and from where (page, agent, CLI).
- **Install what's missing.** Each unavailable script says how to get it: *Set up* (no test interpreter yet),
  *Install* (a fixed pip or npm recipe; pip into the repo's interpreter, npm into Aftershock's own prefix with
  `--ignore-scripts`), or the command for the operator (system packages). *Set up test environment* creates a venv,
  installs the repo with its test extras, dependency groups and requirements files, plus pytest and coverage. Routes:
  `POST /repos/{r}/setup/stream`, `POST /repos/{r}/tools/install/stream` (SSE, behind the run gate, names outside
  the recipe list refused with 400). CLI: `aftershock setup REPO [--tools ...] [--tools-only]`.
- **Five probe scripts Aftershock writes itself** (`aftershock/catalog/probes.py`), 194 scripts in all:
  `py.import-smoke` (imports every module in its own interpreter), `py.cli-smoke` (every console script answers
  `--help`), `pytest.flaky` (forward, reversed, forward: tests whose outcome changes, with order dependence called
  out), `pytest.isolation` (each test file alone vs. the full suite), and `ai.unit-tests` (a model writes tests for
  central code no test reaches; only files that pass are kept, in `tests/aftershock_generated/`).
- **Secrets stay out of child processes.** Tests, coverage, tools and installs get an environment without
  `AFTERSHOCK_*`, `FALKORDB_*`, `COVERAGE_*` or any `*KEY*/*TOKEN*/*SECRET*/*PASSWORD*/*CREDENTIAL*` variable.
- **Deployment:** the image gets `/data/envs` (test interpreters) and `/data/showcase`; `scripts/showcase.sh`
  provisions ledger (with an uncommitted demo edit, so the Tests page has a real failing diff) and seeds real runs.

- **Results on arrival:** the Tests page shows the newest recorded run (counts, failures, top 3 culprits) instead
  of "Nothing has run yet"; Culprit opens the newest failing run unless `?manual=1`.
- **Fixed:** `testlab/repos/` fixtures were gitignored by the root `repos/` pattern (anchored to `/repos/`);
  `showcase.sh` works on a root-owned checkout; Sheet actions no longer overflow at phone width.

Tests: `tests/test_d29.py` (15): env scrubbing, requirement discovery, every library tool has a recipe (it caught
`pip` missing), install refusals, the probes against synthetic repos with a planted order dependence and a planted
cross-file dependence, runtime/showcase/proxy-header gating, showcase locks, the public 429, operator-only scripts,
recorded runs and pruning.

### Added: a built-in script library (D28)

Users no longer bring test scripts; Aftershock ships them. `aftershock/catalog/` defines 189 scripts in 9
categories across 13 ecosystems, each with what it checks, when it applies to a checkout, and how it runs:

- **93 `check` scripts** read files only (merge markers, committed secrets with masked output, invalid JSON/YAML/TOML,
  duplicate or focused tests, `eval`/`shell=True`/weak hashes, bare `except`, mutable defaults, …).
- **8 `graph` scripts** query the indexed graph (untested hubs and hotspots, import cycles, dead code, orphan tests,
  hidden coupling).
- **88 `command` scripts** run real tools when installed (pytest modes, ruff, mypy, bandit, eslint, tsc, cargo,
  go vet, shellcheck, hadolint, gitleaks, …). They execute code, so they need the run gate.

Surfaces:

- **Tests page:** a searchable, filterable library with *Run all quick checks* and *Run N selected*; results
  stream in with findings linked to files. The "add library" form is gone; registered outside libraries are still
  listed and removable, and `aftershock library` still adds them.
- **Ask:** the agent gets `test_scripts` and `run_checks` (read-only) always, and `run_scripts` (anything,
  including commands) only when the request passed the run gate. A *Let AI pick* card on the Tests page opens Ask with
  a prefilled prompt.
- **API:** `GET /repos/{r}/scripts`, `POST /repos/{r}/scripts/run/stream` (SSE). **CLI:** `aftershock scripts list|run`.
  **MCP:** `test_scripts`, `run_checks`; `run_scripts` on a stdio server with `AFTERSHOCK_ALLOW_RUN=1`.
- Script runs share each repo's run slot with test runs (409 while one is running).

Fixed during testing: the registry loaded only the first catalog module imported, so importing
`aftershock.catalog.commands` before `scripts()` silently dropped the graph scripts.

### Changed: the web UI, rebuilt again in the GROUNDTRUTH design

- Every page rebuilt on one primitive set (`web/components/gt.tsx`); the previous
  `components/ds/*` layer, the ambient background and the `/design` page are removed.
- Feature parity with the previous UI on all pages (home/indexing, overview, impact,
  diff, culprit + heal, path, tests + libraries + live runs, explore, ask, cypher,
  model settings), plus error, loading and not-found pages.
- New: a lazy **File map** on the overview (import graph of the top 150 files, click
  to explore), using the previously unused `/graph` endpoint.
- Fixed: mobile nav and list rows ignored responsive `hidden`/layout because unlayered
  `gt-*` CSS set `display`.
- `scripts/demo_video.mjs` re-records a captioned walkthrough on the `ledger` demo repo
  (register a test library, re-index, impact, diff, path, run tests, culprit, Ask with a
  cheap OpenRouter model, Cypher). Key suffixes are masked in the recording.

### Earlier the same day

### Changed: the web UI, rebuilt (D27)

The frontend was rebuilt from the backend outward rather than restyled. Three problems
drove it: the test library was not reachable from the UI at all, tests could not be run
against a repo from the browser, and risk colour was defined in four places that
disagreed.

- **A design system, not a stylesheet.** `components/ds/*` is now the only source of
  presentation: `Panel`/`Bento`/`Slab`/`Grid` for layout, `Metric`/`RiskGauge`/
  `SeverityBar` for readouts, `CodeBlock` and `Trace` for machine output, and one
  severity ramp with adapters (`fromLevel`, `fromTier`, `fromScore`, `fromProbability`)
  for every risk vocabulary the API speaks. Rules and rationale: `web/DESIGN.md`; the
  living version renders at **`/design`**.
- **Colour has one meaning per hue.** Brand violet is chrome (actions, nav, links,
  focus); the thermal ramp is data. Previously `medium` risk was violet, which made a
  risk level look like a link.
- **Tests are a first-class surface.** The Tests page lists registered test libraries,
  shows the run gate and why it is closed, previews what a selection will run, and
  records every run. A failing run offers *Investigate in Culprit* and *Fix with AI*.
- **Ask streams its work.** Tool calls, their arguments and their results appear as
  trace lines as they happen, each with its own receipts, instead of a spinner followed
  by prose.
- **Bring your own model.** `/settings/models` stores provider keys server-side for
  Anthropic and any OpenAI-compatible endpoint (OpenAI, OpenRouter, Google, Groq,
  DeepSeek, xAI, Mistral, Ollama), and a model picker in chat selects per-conversation.
  Keys are never returned by a route, never logged, and never held in the browser.
- **Conversation checkpoints.** Ask records a checkpoint per exchange and can roll the
  thread back to one. Note this restores the *conversation*, not the working tree —
  Aftershock is read-only over your repo everywhere except the heal loop.
- **The heal loop states what it does before it does it.** It is the one surface that
  writes to your files, and the panel now says so — including that edits land in the
  working tree and not in a branch — before the button, not after.
- **Evidence is labelled.** Suspects say whether a ranking came from measured coverage
  or the static call graph; every graph edge shows how it was resolved and how
  confident the resolver is; lists that cap say how many they are hiding.
- **Accessibility.** One `<main>` per route; `title=` tooltips that disagreed with (or
  substituted for) accessible names removed; glyph-only readouts given `sr-only` text;
  streaming regions marked `aria-live`.
- **Removed:** the legacy colour alias layer (18 `--color-*` variables), the
  `LEVEL_*`/`TIER_*` colour maps in `lib/format.ts`, the `.epi-*` animation aliases and
  the page-furniture shim in `components/kit.tsx`.

### Changed: the Aether Node visual language (D28)

The rebuilt UI was re-skinned onto the Aether Node design brief. Almost all of it was an
edit to the token tier in `app/globals.css`; the components that needed touching were the
handful that had assumed the chrome would always be dark.

- **The chrome has no hue.** Brand violet is gone. Actions, navigation, links, focus and
  selection are white / `#E5E5E5` / black, which leaves the severity ramp as the only
  colour in the product. `--color-brand` survives as the name for "the application
  speaking" and now resolves to white; `Panel tone="brand"` was renamed `tone="emphasis"`
  because a token called "brand" would have been lying about what it drew.
- **One inverted surface per viewport.** The brief's `surface: #E5E5E5` and
  `text-primary: #FFFFFF` cannot describe the same box (1.1:1), so they are modelled as
  two roles: near-black panels separated by `#27272A` hairlines, plus a single inverted
  focal object. `Panel tone="focal"` is that object, and it is now demonstrated on
  `/design`.
- **Two faces, not three.** Barlow Condensed is dropped. JetBrains Mono is the default
  including body prose; Inter carries the display step and page titles. Radii collapse to
  card 24 / control 20 / pill, with 16 and 12 for nesting so corners stay concentric.
  Spacing is four declared steps (8/16/24/80).
- **Control labels are a type step, not a guess.** Every button is mono 12/600/0.06em
  uppercase; the `link` variant opts out, because a link inside prose is prose. The 64px
  display step is now the hero's alone — `PageHeader` uses `heading`.
- **Fixed three latent 1.1:1 pairings** that only became visible once the chrome went
  light: `text-white` on the skip link, on the active `Segmented` segment, and on the
  logo mark, all now `text-invert-ink`.

### Fixed: entrance animations could hide a page permanently (D28)

`Enter` and `Reveal` paint their children at `opacity: 0` until an IntersectionObserver
fires. Three independent faults meant that could never resolve, and each one produced a
page that returned HTTP 200 with all of its text in the DOM and in the accessibility tree
and nothing visible on screen — a failure no status code or DOM assertion can detect.

- `Reveal` rendered `data-reveal=""` with no scripting gate, so with JavaScript off, a
  blocked bundle or a hydration error the content stayed hidden forever. Every
  `opacity: 0` resting state now sits behind `html[data-anim="on"]`, set by the inline
  script in `app/layout.tsx` *before and outside* its `try/catch` so a throwing
  `localStorage` cannot arm the animation without arming the gate.
- The resolved states are scoped to the same gate, so `[data-enter="in"]` (0,1,0) can no
  longer lose on specificity to a gated start state (0,2,1).
- `Enter` passed `data-enter={shown ? "in" : undefined}`, so the transition had no start
  state and never animated at all.
- `useEnter`'s threshold defaulted to `0.15`. `intersectionRatio` is visible area over
  *total* area, so an element taller than ~6.7 viewports could never reach it and would
  have stayed invisible. The default is now `0`; depth tuning belongs in `rootMargin`.

`web/app/motion-safety.test.ts` asserts all four invariants against the source, and was
confirmed to fail when the gate is removed.

### Fixed: `heal/stream` validated input before authorising the caller (D28)

`POST /repos/{r}/runs/{id}/heal/stream` checked the run-id shape before the run gate, so a
caller who was not allowed to run anything received a 400 telling them their id was
malformed instead of the 403 they get on `run/stream`. The gate now comes first.

### Added: acting on the graph (D26)

- **Measured runs:** Tests-page runs (selected or all) and the first heal run record per-test coverage, replacing
  COVERS only for the tests that ran; culprits for that run rank on executed code.
- **Explained suspects:** each suspect has `basis` (coverage/static) and `why` (counts, Ochiai score, hops), shown in
  the Culprit page.
- **Fixer with graph tools:** Claude queries the graph read-only (CLI: its own locked-down stdio MCP server; API: a
  bounded tool loop) and states `Cause:` / `Evidence:`; rounds record the explanation and the lookups.
- **`next` on `run_detail`:** suggested follow-up tool calls with reasons.
- **MCP `run_tests` and `heal`:** only on a local stdio server started with `AFTERSHOCK_ALLOW_RUN=1`; never on HTTP
  `/mcp`, never offered to the Ask agent.
- **Fixed:** heal verify runs counted toward a test's flakiness history.

### Added: the test loop (D25)

- **Test library:** `aftershock library <repo> add|remove|list` registers an outside pytest directory; it is indexed
  as `@lib/<name>/…` tests, selected and run with the repo's tests, and included in `coverage`.
- **Test runs in the graph:** every run is a `TestRun` node with RAN / SUSPECTS / RETRY_OF edges (last 50 kept).
  `aftershock runs <repo> [id]`, `GET /repos/{r}/runs`, `GET /repos/{r}/runs/{id}`, `GET /repos/{r}/libraries`, MCP
  `test_runs`, `run_detail`, `test_libraries`.
- **Heal from the app:** `POST /repos/{r}/runs/{id}/heal/stream` (behind the run gate). Claude's prompt now includes
  the graph chain from failing test to suspect and the source along it.
- **UI:** a failing run on the Tests page offers *Investigate in Culprit* and *Fix with AI*; the Culprit page opens a
  recorded run (`?run=`) with failures, per-test history, suspects with chains, retry lineage and the pytest tail, and
  streams the fix loop (rounds, diffs, links to each re-run). Recent runs are listed on both pages.
- **Culprit:** recorded coverage now replaces static reach for passing tests that were measured (functions only), so
  code a healthy test could reach but skipped is not cleared by it.
- **Security:** the web proxy's loopback check now also covers the heal route.


### Fixed and added (closing the judges' remaining gaps, D20–D24)

- **`heal` verified on real bugs.** `scripts/heal_bench.py` plants six one-line bugs in click and runs
  `heal --diff --apply` with a live model: 6 of 6 fixed in one round, rank-1 culprit correct each time, every fix an
  exact revert, 0 full-suite failures after (README table).
- **`heal` widens a green selection (D21).** If every selected test passes, it runs the tests reaching the change
  within 12 hops before reporting green; `widened` is in the report. Caught `_build_prompt`, whose only failing test
  is about ten hops away.
- **Culprit searches back from deep changes.** A changed symbol beyond the forward search depth is still ranked, via
  the shortest test → … → change chain (`culprit.CHANGED_DEPTH` 12).
- **Runner:** a nested function in a test (`test_a.helper`) runs as its enclosing test instead of aborting the whole
  pytest run with "not found"; explicitly named files that pytest's default pattern would not collect are skipped
  unless the repo configures `python_files`.
- **Python resolution (D20):** an absolute import of a stdlib name never maps into a same-named repo module
  (`flask/typing.py`); an ambiguous suffix resolves to the shallowest root (`src/flask` over a test app's
  `flask.py`), taking flask from 1,698 to 2,530 edges. `@pytest.mark.parametrize` rows built by one constructor type
  their parameter; `a, b = f()` with `-> tuple[A, B]` types each name; `x: A | B` resolves `x.m()` to both.
- **JS closure objects (D22, PARSER_VERSION 20):** closures gathered into an object literal are its methods; a
  member missing from a known literal no longer falls back to a same-named method elsewhere.
- **Full-text search (D23):** FalkorDB full-text index on `Symbol(name, doc)`; `search` (API, MCP, UI picker) finds
  symbols by docstring words when the name match comes up short (`match: "text"`).
- **Eval (D24):** `top5` / `top10` variants score the head of the ranked file list. Two held-out repos, flask and
  starlette, are pinned in `bench/repos.toml`. Top-5 beats the same-dir baseline on 4 of 5 repos (README).
- **Weights:** `scripts/fit_weights.py` fits `weights.json` on train repos and writes only on held-out gain. It found
  none, so the weights are unchanged.
- **Demo:** `media/aftershock-demo.mp4` (35 s, httpx), recorded by `scripts/demo_video.mjs`.

### Fixed (judges' static-recall review, D19)

- **Constructors, dunders, `@property` reads and module values now have callers.** `Class(...)` reaches
  `Class.__init__`/`__new__`/`__post_init__`; `PARSER_VERSION` 15, graphs re-parse on next index. Call-site resolution
  on click 56% → 66%, httpx 52% → 78%. Static recall: click .167 → .211, httpx .106 → .180 (README table).
- Keyword-argument calls were reported as definite signature breaks; only the positional upper bound is checked now.
- Module-level value changes and newly added overrides now produce seeds.
- Re-indexing deleted `COVERS` edges; they are kept, and those into edited files are marked stale (weight × 0.8).
- `eval` no longer lets HEAD coverage leak into replayed commits (static only).
- Graph queries have stable `ORDER BY` and caps where results are user-scaled; the read-only Cypher guard clamps
  any `LIMIT` above `max_rows`; culprit ranking walks all failing tests together (one query per hop, not per test).

### Fixed (web UX review)

- Clicking a graph node now rings it, shows a selection bar (name, tier, hop, why), and opens and scrolls to its row.
- On touch screens the graph no longer traps page scroll (one-finger drag scrolls the page; pinch zooms).
- Root `not-found`, `error`, `global-error` and `loading` pages; repo-level loading skeleton.
- Shortcut hints show ⌘ on Apple platforms and Ctrl elsewhere; 10px text raised to 11px, low-contrast copy raised to
  `fog`; buttons, selects and switches get a 44px hit area on coarse pointers.

### Added (run tests from the UI, D18)

- **Tests page** (`/r/{repo}/tests`): run the working-tree diff's tests, the tests for chosen symbols, the whole
  suite, or record coverage; results stream in per test, grouped by file with failures first, and culprits are
  ranked when anything fails. Impact and Diff link to it ("Run") and copy the `pytest` command.
- `POST /api/v1/repos/{r}/run/stream` (SSE) and `GET /api/v1/runtime`. Off unless `AFTERSHOCK_ALLOW_RUN=1`;
  loopback clients only; not on MCP. `aftershock/runtime/jobs.py` drives it.
- `run_pytest` streams per-test results while pytest runs and can be cancelled (kills the process group).
- `web/app/r/[repo]/error.tsx` (recoverable error boundary); `ErrorNote` has a Retry button.

### Fixed (judge review)

- **DNS rebinding on the REST API**: without an API key, requests with a Host other than loopback or
  `AFTERSHOCK_ALLOWED_HOSTS` get 421.
- **Edited or added tests were not selected**; they now are (deleted ones are skipped, renamed ones run by new id).
- **testlab left partial edits on disk** when a later edit in a scenario failed to apply; `_apply` now restores them.
- Explore's starting-points tile swallowed load errors; the symbol picker used a Tailwind v3 width syntax under v4.

### Added (testlab, D17)

- **`aftershock testlab [suites] [--only X] [--list] [--json] [--keep]`**: end-to-end scenario suites with known
  answers (`testlab/`). Each scenario changes a fixture repo, then the runner drives diff → impact → select → full
  suite (ground truth) → selected-only rerun → culprit, and scores each step. Format and how to add suites:
  `testlab/README.md`.
- Suites: `ledger` (Python, 9 hand-written scenarios), `inventory` (TypeScript, 3, static), `quixbugs` (40 real
  published bugs from QuixBugs, MIT, vendored by `scripts/vendor_quixbugs.py` with its own pytest cases).
- `tests/test_testlab.py` runs ledger, inventory and one QuixBugs bug in the normal pytest run.

### Fixed (found by testlab)

- **Edits inside f-strings and escaped strings were not detected** (`f"A{n:04d}"` → `:03d` read as no change): the
  body fingerprint skipped text the parser keeps outside child nodes. `PARSER_VERSION` 14; existing graphs re-parse
  on their next index.
- **Test selection dropped tests that reach a change through long or dispatch chains**: impact prunes below
  p 0.03, which is right for "likely to break" but not for "what to run". `select_tests` now adds every test that
  statically reaches the change (p 0, `reach: true`), ranked after the probable ones. `mutate` scores the same set.
- **Tests that reach code only through pytest fixtures were not selected**: a test (or fixture) now has a CALLS edge
  to each fixture its parameters name (same class, same file, conftest.py upwards).
- **`Class.factory(...).method()` was unresolved**: a class-method call result is typed by its declared return.

### Added (runtime evidence, D15)

- **`aftershock coverage <repo>`** runs the repo's pytest suite once under per-test coverage, in the repo's own
  interpreter, and stores `(test)-[:COVERS]->(symbol)` edges. Impact, test selection and culprit use them when present.
  On click (2263 tests, 7.6s) it recorded 47,210 edges. Selected tests for `wrap_text` went from 12 static to 122,
  and for `Context.invoke` from 0 to 265.
- **`aftershock run <repo> [targets | --diff]`** runs only the selected tests and lists failures with their messages.
  For failures, it ranks culprits, seeded by the change.
- **`aftershock mutate <repo> --n 30`** is mutation evaluation. In a scratch copy, it makes each sampled function raise
  at entry and runs the whole suite; the tests that newly fail are the ground truth. It scores static, coverage and
  same-name test selection, and lists survivors (functions no test notices breaking).
- **Culprit ranking** uses recorded coverage as the spectrum (classic Ochiai) alongside static reachability.
- **`bench/repos.toml` + `scripts/bench_env.py`**: pinned benchmark repos with test-only install sets, built into
  `.aftershock/envs/<name>` via uv. Ready: click, httpx (needs port 8000 free). Unsupported, with reasons:
  code-graph-rag and zustand.
- **Web:** tests found by recorded coverage carry a "ran it" badge. `COVERS` steps read "ran". The empty state points
  to `aftershock coverage`.
- `select_tests` returns a `runtime` flag per test and a note that says whether coverage was used.
- Dev dependency: `coverage>=7.6`. 15 new tests (`tests/test_runtime.py`), including end-to-end record, run, culprit
  and mutate runs on a scratch fixture.

### Added (heal, D16)

- **`aftershock heal <repo> [targets | --diff] [--apply]`** closes the loop the hackathon brief asked for: select the
  tests a change reaches, run them for real (same runtime layer as `run`), and -- with `--apply` and
  `ANTHROPIC_API_KEY` -- let Claude propose a whole-file fix for the top fault-localization suspect, then re-run the
  same tests to check. A round is kept only if the failing set strictly shrank; otherwise it is reverted immediately
  and the next suspect is tried, up to `--max-rounds` (default 3). Without `--apply`, `heal` only reports, like `run`.
- Dry-run is the default: no API key or no `--apply` means Claude is never called and no file is ever written.
- 9 new tests (`tests/test_heal.py`): real subprocess test runs against an on-disk fixture, a monkeypatched
  `tools.culprits`/model call for the orchestration loop, covering all-passed, dry-run (with and without a key), a
  kept fix, a reverted fix, and a partial fix that is kept and narrowed on the next round.

- **Reference graphs are hidden, not listed** (D13). Graphs named in the Redis set `aftershock:lab` (click, httpx,
  zustand, code-graph-rag, epicenter, epitest) no longer appear on the home page, in `/repos`, MCP or the CLI list.
  `aftershock lab <name> [--off]` toggles membership, `aftershock repos --all` and `GET /repos?lab=1` include them.
  Nothing was deleted; direct URLs still work.
- **Overloads bind to the implementation** (D14, `PARSER_VERSION` 13). `@overload` stubs keep their `#N` ids, but calls,
  members and method lookups bind to the last non-stub definition. Lookup expands a symbol to its whole overload
  family, and stubs never appear as "untested". Test selection for click `Context.invoke` went from 0 to 350 tests.
- **More resolution:** names a module re-exports from a library count as external (`export { cn } from "cn"`),
  pathlib `Path / "x"` types as `Path`, and rest-spread forwarding (`(...args) => f(...args)`) binds through forwarders.
- **Friendlier UI:** three onboarding steps on the home page; Explore shows clickable suggestions (most central
  symbols, hotspot files) instead of an empty box; `#N` overload counters are stripped from every label
  (`symName`); subsystems sharing a directory are named by their telling files (`src · middleware, vanilla +2`).
- **Ask** labels module-level code as `<module>`; the impact page accepts `?targets=` as an alias of `?t=`.
- `scripts/smoke.mjs` (headless page smoke across widths) and `scripts/gaps.py` (blind call sites by pattern).

### Fixed (2026-10-18, later)

- Dead-code "unused exports" no longer lists `.d.ts` declarations or interfaces.
- An overload refactor briefly dropped nested defs under numbered parents (`prompt#3.prompt_func`); caught by an
  edge diff and fixed before any graph shipped (click back to 2693 edges).

- **Callback parameters, destructuring, properties and more externals** (`PARSER_VERSION` 12).
  - A callback's parameters bind to what the callee passes them: `create((set, get) => …)` reaches the `setState` and
    `getState` that `createStoreImpl` calls `createState` with. The parser records how each function calls
    (`pcall:`) or hands on (`pfwd:`) its parameters; the resolver follows up to 5 hops, through curried factories and
    through middleware that returns an arrow taking the same parameters (`create()(devtools(immer((set) => …)))`).
  - Destructuring: `const { getState, setState: put } = store` and `[a, b] = f()` positions.
  - Imported module-level variables carry their type (`import { store } from './s'`; `store.getState()`).
  - `@property`/`cached_property` return types type attribute chains (`response.url.copy_with`).
  - More calls are classified as external rather than blind: methods on literals (`", ".join`), every Python builtin
    name, `*args`/`**kwargs`, standard pytest fixtures, values a library context manager yields
    (`with TestClient(app) as c`) and every chain off them (`client.get().json()`), and builtin-typed attributes
    (`result.output.splitlines()`).
  - Fixed: a JS test labelled like a function (`it('devtools', …)`) shadowed the imported `devtools`.
  - Blind call sites: zustand 606 → 454, click 797 → 385, httpx 559 → 310, Epicenter 1905 → 1201. Repo-bound rate:
    zustand 66.0 → 74.1%, click 63.2 → 70.1%, httpx 61.0 → 66.2%, Epicenter 44.4 → 51.4%. Edges: zustand +85, httpx
    +21, Epicenter +7, code-graph-rag +88, click unchanged. Eval F1 within ±.002 (zustand .072, httpx .116, click .149).
- **Factory-returned objects** (`PARSER_VERSION` 10, then 11).
  - An object literal evaluates to a *shape* whose members are the definitions it names: shorthand (`{ getState }`),
    `key: ref`, object methods and `...spread`. A function returning one (`return api as any`) types its callers'
    results. Inline arrow values have no definition and are not members.
  - `return useBoundStore` (a nested function) plus `Object.assign(useBoundStore, api)` gives a callable shape:
    `useBoundStore.getState()` reaches api's members, and `useBoundStore()` reaches the nested function.
  - Curried factories (`init ? impl(init) : impl`) type both `create(init)` and `create<T>()(init)`.
  - Shapes are synthetic and never written to the graph; every edge still lands on a real symbol (D11).
  - Fixed: `const f: Handler = () => …` recorded `Handler` as f's *return* type, which also blocked the body hint.
  - zustand call-site resolution 19.6% → 29.7%, repo-bound 43.5% → 66.0%. Eval F1 .068 → .073 (+ import-only
    .141 → .142). click, httpx, Epicenter and code-graph-rag edges are unchanged.
- **Element types, aliases and external-call accounting** (`PARSER_VERSION` 8, then 9).
  - Loop variables are typed by the element type of what they iterate. This covers Python `for`/comprehensions, JS
    `for…of`, Go `range`, Rust `for`, Java enhanced `for`, `enumerate`/`.items()`/`Object.entries` pairs, and the
    first parameter of `forEach`/`map`/`filter`-style callbacks. Subscripts (`xs[0]`, `d[k]`) take the element or
    value type, and `list[Foo]`, `dict[K, Foo]`, `Foo[]`, `Array<Foo>`, `Map<K, Foo>` and Go `[]Foo`/`map[K]Foo` are
    unwrapped. Literals type their locals (`[]` → list, `""` → str).
  - Python module-level type aliases (`Env = Annotated[Graph, …]`, `X = Y | None`, 3.12 `type X = …`) are followed,
    including through imports. `import a.b.c` also binds `a`.
  - Value aliases: `export const devtools = devtoolsImpl as unknown as Devtools` (also `satisfies`, parens, `!`, a
    plain identifier) resolves calls to the aliased definition.
  - **External calls are counted apart.** A call that provably leaves the repo is classified as external rather than
    unresolved. That includes a library import, a builtin, a method on a builtin or library type, a literal, or a JS
    global. The repo node carries `external_sites` and `repo_resolution_rate` (resolved ÷ call sites that are not
    external). `index` and the overview page show both rates (D10).
  - Call-site resolution: click 49.0% → 49.8%, Epicenter 30.5% → 31.2%, zustand 14.3% → 19.6%. httpx is
    unchanged; code-graph-rag (46.3%) has no before figure. Repo-bound rate: click 63%, httpx 61%, zustand 44%, Epicenter 44%, code-graph-rag
    56%.
  - Eval F1, all tiers: zustand .040 → .068 (+ import-only .124 → .141), click .148 → .149, httpx unchanged (.117).
- **`aftershock eval`** (`analysis/evaluate.py`) replays non-merge commits and scores impact predictions against the
  files each commit actually co-changed.
  - Scores are broken down by tier, change kind and test vs code files.
  - Reported alongside: the import-only variant and a same-directory baseline.
- **Import-only dependents** in impact results (`import_only`): files that import a changed file but have no resolved
  call to the change.
  - Shown in the markdown report (collapsed) and as a tile in the web impact view.
  - New query `importers_of`.
- **Return-type, `with` and fixture inference** for receiver types.
  - The parser records `ret_hint`: the type every `return` in a function agrees on when it declares none. `return
    self` and `return cls()` count as `Self`. A `return` inside a nested callback is not counted, and generators are
    marked `yield:`. It also records `with X() as x` bindings.
  - The resolver uses these hints for `f().m()` and `x = f(); x.m()`. `with` bindings resolve through `__enter__`.
    An untyped parameter of a test function is typed by the pytest fixture of that name (test class, file, then
    `conftest.py` upwards). Iterator and Generator return annotations are unwrapped.
  - Go result tuples such as `(*S, error)` now type the first result.
  - Call-site resolution: click 41% → 49%, httpx 47% → 50%, Epicenter 29% → 31%. zustand and code-graph-rag are
    unchanged.
  - Eval F1: httpx .113 → .117. click .157 → .148, because correct links to about 350 fixture-driven tests are
    scored against co-change (README → *Measured accuracy*).
  - `PARSER_VERSION` 6 forces a re-parse.
- **Override and dispatch edges.**
  - The resolver emits `OVERRIDES` from a method to the inherited method it redefines. It walks base classes
    transitively and Go/Rust impl types, and skips constructors and name-mangled privates. It covers Python, TS/JS,
    Java and Rust.
  - Impact follows overrides both ways:
    - A contract change (signature/rename/delete) to a base method reaches its overrides, using a new
      `weights.json` `override` block. A signature change also gets an arity verdict.
    - A change to an override reaches callers of the base method through a `DISPATCH` step that records `via`.
  - Culprit reachability and test selection follow dispatch too.
  - Dead-code no longer reports overriders.
  - The UI and agent explain the hops ("calls X, which can dispatch to Y").
  - Eval F1 rose from .153 to .157 on click and from .102 to .113 on httpx.
  - Nothing needs a forced re-parse: outgoing-edge digests relink the affected files.
- Tests for overrides and dispatch (fixture `run_job`, arity verdicts, culprit reach, Python/TS/Java/Rust resolver
  cases), return hints and fixture/`with` resolution, including what must not resolve (84 tests).
- Tests for the node-cap fix, tsconfig `paths` semantics, cast/parenthesized arrow exports, star re-exports and
  import-only dependents (76 tests).

### Fixed

- **Overview crashed on any repo with an import cycle** (`e.map is not a function`). The API returns cycles as
  `{files, size, example}`, but the page still treated each one as a list of files. It now draws the example loop and
  the cycle's size. Found by the headless smoke run on click.
- **Impact truncation:** when a hop overflowed `max_nodes`, the whole hop was dropped. Now its strongest nodes fill
  the remaining budget.
- **tsconfig `paths`:**
  - An exact pattern (`"pkg"`) swallowed `pkg/sub` imports.
  - `*` in the middle of a target (`./src/*.ts`) was not substituted.
- **JSONC stripping:** it treated `/*` inside strings such as `"pkg/*"` as a comment opener and dropped the rest of
  tsconfig.
- **Star re-exports:** symbol lookup did not follow Python `from x import *` or TS `export * from`. It now does, with a
  cycle guard.
- **TS functions:** `export const f = (() => …) as T`, `satisfies` and `!` wrappers are now recognized as functions.
  `PARSER_VERSION` 5 forces a re-parse.

### Removed

- The README claim that method overrides are invisible to impact.
- Unused web UI primitives: `badge`, `card`, `scroll-area`, `separator`, `skeleton`, `tabs`. Nothing imported them.
