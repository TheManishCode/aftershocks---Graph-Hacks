# Handoff

## State (2026-10-18)

Working:

- Indexing of Python, TypeScript and JavaScript.
- Go, Java and Rust are parsed and resolved, with unit tests only. No repository in those languages has been evaluated.
- Override edges and dispatch in impact, culprit and test selection (D8).
- Return-type, `with` and pytest-fixture inference for receivers (D9).
- Loop/element types, type and value aliases, and external-call accounting (D10).
- Factory-returned objects as synthetic shapes (D11).
- Callback-parameter binding, destructuring, `@property` types and library-value externals (D12).
- Impact, diff, CI gate, test selection, path, culprit, overview, cypher, Ask (router + Claude agent), MCP, eval.
- The web app: every page under `app/r/[repo]/`.
- Runtime evidence (D15, CLI-only, Python/pytest): `coverage`, `run`, `mutate`, plus coverage-aware culprit. The
  benchmark manifest is `bench/repos.toml`; envs are built by `scripts/bench_env.py` into `.aftershock/envs/`
  (click and httpx exist). The click graph holds 47,210 COVERS edges.
- The test loop (D25): test libraries (`@lib/` tests), `TestRun` nodes, `aftershock runs`, heal from the app
  (Tests page → Culprit `?run=` → Fix with AI, gated like `run`). Verified end to end on 2026-10-18 with a planted
  bug in a scratch repo and a real Claude call through the CLI backend: 2 failing (1 repo, 1 library) → 0 in one
  round; the re-runs are linked RETRY_OF. Coverage now replaces static reach for measured passing tests.
- Acting on the graph (D26): measured runs (`run_measured`), suspect `basis`/`why`, `run_detail.next`, the fixer's
  read-only graph tools (`heal.GRAPH_TOOLS`, `_ask_cli` / `_ask_api`), MCP `run_tests`/`heal` registered only by
  `mcp_server.main()` for stdio + allow_run. Tests: `tests/test_actions.py`. Verified live over MCP stdio: run (2
  failing, measured) → top suspect `discount_rate` (coverage) → heal fixed 2 → 0 with a Cause/Evidence explanation.
- `heal` (D16, CLI; from the app since D25): runs the tests a change reaches and, with `--apply` + `ANTHROPIC_API_KEY`, lets Claude
  propose a whole-file fix for the top culprit suspect, re-running for real to keep only a strictly-improving
  round. This is the Track 1 "AI reads the code, selects tests, runs them, and tries to resolve failures" ask.
- Testlab (D17, CLI-only): `aftershock testlab` runs known-answer scenarios end to end on `testlab/repos/`
  (ledger 9, inventory 3 static, QuixBugs 40 real bugs). `tests/test_testlab.py` runs ledger, inventory and one
  QuixBugs bug inside pytest. The suite format is in `testlab/README.md`; recovery point before this work:
  `~/.aftershock-backups/aftershock-20261018-testlab.tgz`.

Verification:

| Check | Result |
|---|---|
| `pytest -q` | 159 passed, with FalkorDB on :6390 (2026-10-18, after D24) |
| `ruff check aftershock tests scripts` | clean, including `aftershock/analysis/heal.py` |
| `tsc --noEmit` | clean for app code; the web Jest test files (below) are not type-checked by `tsc` (Jest uses its own transform) |
| `eslint .`, `next build` | depends on `npm install` having picked up the new devDependencies below; not yet re-run after that install |

**Web test setup (testing-library / Track 1 frontend side).** `web/jest.config.js`, `web/jest.setup.js`,
`components/markdown.test.tsx`, `components/ui/button.test.tsx`, `lib/format.test.ts`, the Jest/Testing Library
devDependencies in `package.json`, and the testing-library ESLint plugin block in `eslint.config.mjs` were added and
verified end-to-end (all passing, including an XSS-safety assertion on `<Markdown>`) in an isolated cloud harness
pinned to the same dependency versions. `npm install` has not been run in this checkout, since this session has no
network egress to the user's `web/node_modules`; run `npm install && npm test` in `web/` once to confirm on this
machine, after which `eslint .`/`next build` should also pick the plugin up cleanly.
| `scripts/smoke.mjs` on home, overview, explore, impact (aftershock + click) at 1440px and 390px | 12 loads, no errors, no overflow, no `#N` in text |
| Headless Playwright runs (path, cypher, ask, diff, culprit, impact incl. the import-only tile and a DISPATCH why-chain on httpx) | no console errors |
| Smoke run of all 8 pages on click and zustand at 1440px and 390px (after the cycles fix) | 32 loads, no errors, no overflow |
| Impact view at 1440px and 390px | no horizontal overflow |

The project now has one commit (`841b1ad`, "Initial commit") on `main`; everything above is still **uncommitted**
working-tree state on top of it (runtime evidence, heal, the web test setup, and this doc). Commit it before the
hackathon deadline. The latest full-tree snapshot (belt-and-suspenders alongside git) is
`~/.aftershock-backups/aftershock-20261018-runtime-after.tgz`, taken *after* the runtime layer was built. The
pre-runtime snapshot (`…-runtime.tgz`, 16:05) was overwritten by mistake. The newest snapshot taken before the
runtime work is `~/.aftershock-backups/aftershock-20261018-friendly.tgz` (before lab hiding, overloads and the UX
pass). Earlier ones:
`~/.aftershock-backups/aftershock-20261018-110911.tgz`, which predates this session's changes, and
`~/.aftershock-backups/aftershock-20261018-override.tgz`, taken before the override work, and
`~/.aftershock-backups/aftershock-20261018-returns.tgz`, taken before return-type inference, and
`~/.aftershock-backups/aftershock-20261018-loops.tgz`, taken before loop/element types, and
`~/.aftershock-backups/aftershock-20261018-factory.tgz`, taken before factory shapes, and
`~/.aftershock-backups/aftershock-20261018-callbacks.tgz`, taken before callback binding.

## Local environment

- **FalkorDB:** `aftershock-falkordb-1`, host port 6390. It uses the dev default password from `.env.example`, which matches `config.py`.
  Change it for any shared deployment.
- **Visible graphs:** `repo:aftershock` (this repo) and `repo:AERIS` (indexed from GitHub through the UI; the user's,
  do not drop).
- **Lab graphs** (hidden via the `aftershock:lab` set, D13; `aftershock repos --all` lists them):
  - `repo:epicenter` — the base folder, read-only.
  - `repo:epitest` — a scratch copy.
  - `repo:code-graph-rag`.
  - `repo:click`, `repo:httpx`, `repo:zustand` — eval clones in `../_refs/*-eval`.
- **Do not touch** these containers, which are other projects:
  - the Epicenter stack (6380, 3000–3002, 8000, 8081);
  - `codegraph-falkordb-1` (6381);
  - the cookie-shop postgres (5432).

## Known limitations (also in README → Limits)

- **Recall is low.** Unresolved calls, and co-change that runs toward callees. The
  directory baseline beats the simulator on F1 on httpx and zustand.
- **The definite tier never fires** on the eval repos.
- **Dispatch needs a shared base.** Duck-typed calls with no resolved class hierarchy are not followed.
- **Culprit is empty** when the failing tests' own calls are unresolved.
- **Members reassigned after creation** (`api.subscribe = wrapper` in middleware) are not tracked; the edge goes to the
  original member. `persist` passes a wrapped arrow as `set`, and `combine` uses spread arguments, so those `set`
  calls stay unresolved.
- **TS gaps:**
  - Self-name package imports need tsconfig `paths`.

## Run tests from the UI (D18, 2026-10-18)

`AFTERSHOCK_ALLOW_RUN=1 aftershock serve`, then a repo's *Tests* page. Verified by `tests/test_run.py` (gate off by
default, loopback Host required, body validation, 409 on a concurrent run, 421 rebinding guard, a real streamed run of
the mini fixture with a failing test and ranked culprits, cancel). The page itself was type-checked but **not opened in
a browser** in this session (`npm install` not run here, so no `next build`/dev server).

## Built-in script library (D28, 2026-10-19)

Decision: test scripts ship with Aftershock (`aftershock/catalog/`) instead of users registering them. A user picks
scripts in the UI or CLI, or asks the Ask agent, which picks and runs them.

- **Gating is per kind.** `check` (read files) and `graph` (query the index) run for any API-key holder. `command`
  runs a tool, so it needs the D18 gate. The API checks the gate *before* validating ids, so a refused caller gets
  403 for an unknown id too and learns nothing about the catalog.
- **The agent's `run_scripts` tool exists only when the request passed the gate**; otherwise it has the read-only
  `test_scripts`/`run_checks`. Its runs share the repo's run slot with the Tests page.
- **The CLI runs as the user** (like `run`), so command scripts need no gate there.
- Verified: `tests/test_catalog.py` (registry integrity, seeded findings, symlink confinement, masking, `pick`
  gating/caps, `expand` caps, API 403/404/422 and a streamed read-only run, agent tool exposure). The Tests page
  was driven in Chromium via Playwright: quick checks ran and streamed, `pytest.collect` ran from the UI with the gate
  on, and at 390 px there was no overflow and no console errors.
- **Follow-ups:**
  - Only pytest modes are recorded as runs in the graph; other script results are not persisted.
  - `pytest_run` passes the server's environment to the repo's tests, model API keys included; scrub them.
  - `media/aftershock-demo.mp4` still shows the old "add library" step. `scripts/demo_video.mjs` is updated but the
    video was not re-recorded.

## Results for visitors, installs, probes (D29, 2026-10-19)

Problem: the public site ran nothing (gate off by design), so no visitor ever saw a test result or a culprit, and the
server had no test interpreters. Decisions:

- **Showcase repos are the only public execution.** `run_refusal(request, repo)` allows a run when the operator gate
  passes (ALLOW_RUN + loopback, no `X-Aftershock-Remote`) or `repo` is in `AFTERSHOCK_SHOWCASE_REPOS`. Public runs:
  one at a time globally (`_public_runs`), timeout capped. `_showcase_lock` blocks index/drop/libraries for
  non-local callers. Heal, provider key changes and `local_only` scripts use the operator gate only.
- **The Next proxy** (same host under compose, Vercel otherwise) sets
  `X-Aftershock-Remote` for every non-local visitor; the API can only lose access from it.
- **Installs come from `runtime/setup.py` RECIPES only**, never a caller-typed name. npm uses `--ignore-scripts`.
- **`child_env()`** is the one environment for every child process (tests, coverage, tools, installs).
- Verified: ruff; `pytest` 200 passed (15 new in `tests/test_d29.py`); web `tsc`, eslint, jest 35 passed. The
  whole showcase flow (index, demo edit, setup, `run --diff` with 7 failures and `Account.withdraw` ranked first,
  probes, `--tools ruff`) was run locally on a scratch copy of ledger.
- **Not done:** `ai.unit-tests` was not run against a real model in this session (its pieces are tested; the model
  call is not). The UI changes were type-checked and linted but not opened locally, because the other thread owns
  `web/`'s dev server; they are checked on the deployed site.

## Recommended next steps

1. **Commit everything and push.** One commit (`841b1ad`) exists; the runtime layer, `heal`, the web test setup and
   doc updates are all still uncommitted working-tree state. Review `git status`/`git diff`, commit, and push before
   the deadline -- this blocks submission.
2. **Precision is now the lever, not edges (D20–D24).** The ranked top 5 beats the same-dir baseline on 4 of 5
   repos; the full possible tier floods with tests reached through fixtures (flask: 996 false positives). Try
   scoring harness-reached tests lower (item 8), validated on flask/starlette, not click. Weight fitting
   (`scripts/fit_weights.py`) gave no held-out gain. click coverage was re-recorded at v20 (no stale flags).
   Temporary lab graphs `zz-click-old`, `zz-httpx-old`, `zz-zustand-old`, `zz-click-heal` can be deleted.
3. **`heal` on real bugs is done** (`scripts/heal_bench.py`, 6 of 6 on click). Next: plant bugs in httpx or starlette
   and in multi-line changes, where a whole-file rewrite is more likely to drift.
4. **AI-written tests for survivors.** `mutate` lists functions no test notices breaking. Have Claude write a pytest
   for each, kept only if it passes on the original and fails on the mutant, giving an objective acceptance test so no
   unverified AI test gets in. (`heal`'s propose-only-fix-for-`run`-failures half of this item is now built; this is
   the other half: writing new tests for code nothing tests yet.)
5. **JS runtime evidence:** per-test V8 coverage from vitest (`coverage.provider = "v8"`, one run per test file at
   minimum) into the same COVERS edges, so zustand and Epicenter's web code get it. `heal` itself is Python/pytest-only
   for the same reason (no JS runtime evidence layer to build on yet); the `web/` Jest tests added this session verify
   components but are not wired into `heal`'s fix loop.
6. **httpx mutation numbers** need port 8000 free (its conftest hard-codes uvicorn's default; the Epicenter stack holds
   it here). Run `aftershock coverage httpx && aftershock mutate httpx --n 30` where it is free.
7. **Find why click's possible-tier F1 slipped** (.149 → .140 across this round's resolver changes, with overload
   binding the likely cause); compare per-commit predictions before and after rather than guessing.
8. **Harness hubs in scoring.** Tests reached only through a fixture or harness now count as "tests to run" (D17:
   fixture edges plus reachability in `select_tests`). Still open: whether they should score lower as "likely to
   break". Validate on a held-out repo, not on click.
9. **Restart the :8100 API and rebuild the :3101 UI** (other session's processes): the running API predates full-text
   search and the running UI build predates the Tests page (`/r/*/tests` is 404 there).
10. **Expose eval** via the API/MCP as a background job (it takes about a minute at 1500 commits), with a web page for
    the table.
11. **Evaluate a Go or Java repo** to back the language claims with numbers.
12. **Grow the testlab.** Add a JS suite once a JS runner is wired (inventory is static-only), and a scenario set on a
    real repo (click) with declared gaps for what static analysis cannot see.
