# Session log

## 2026-10-18 (D28): the Aether Node skin, and a bug that returns 200 and shows nothing

**Done.** Re-skinned the rebuilt UI onto the Aether Node brief (CHANGELOG D28). The chrome is
now achromatic, which leaves the severity ramp as the only hue in the product; the brief's
`surface: #E5E5E5` / `text-primary: #FFFFFF` pair is 1.1:1 and was resolved as two roles —
near-black hairline-separated panels plus one inverted focal object per viewport. Two type
faces instead of three, radii card 24 / control 20 / pill, spacing 8/16/24/80, control labels
on the declared mono label step, display reserved for the hero. `Panel tone="brand"` →
`tone="emphasis"`. Three latent `text-white`-on-light pairings fixed. `web/DESIGN.md` rewritten
(it still described the retired Seismic Instrument system verbatim) and `/design` updated to
demonstrate `tone="focal"`, which had shipped undemonstrated.

**The real find.** `components/motion.tsx` carried a comment claiming these components "can only
ever add movement, never hide content" and that the blank-page failure mode "is designed out
rather than guarded against." Checking the claim against the CSS proved it false: `Reveal`
rendered `data-reveal=""`, which matched an ungated `opacity: 0` rule, so any client where the
observer never fires — no JS, blocked bundle, hydration error, background-restored tab — saw a
page that returned 200, had every word in the DOM and in the accessibility tree, and showed
nothing. Two more faults in the same mechanism: `Enter` rendered `data-enter={... : undefined}`
so it had no start state and never animated, and `useEnter`'s 0.15 threshold is unreachable for
an element taller than ~6.7 viewports (`intersectionRatio` is visible over *total* area). Fixed
with the `html[data-anim="on"]` gate, specificity-matched resolved states, an always-present
attribute, and a zero threshold.

Found because the browser pane in this environment never composites, which makes it behave
exactly like a client whose observer never fires. The environment limitation was the reproduction.

**Also fixed.** `heal_stream` validated the run-id before the run gate, so an unauthorised caller
got a 400 about their id instead of a 403. Input validation ahead of authorisation is how a gate
starts answering questions for people who have not passed it.

**Verified (actually run).** `pytest` 174 passed. `tsc --noEmit` clean; `next lint` clean; `jest`
**35 passed / 4 suites**, including the new `app/motion-safety.test.ts`, which was mutation-checked
— remove the gate from `globals.css` and it fails. `next build` clean, 14 routes. On a freshly
started `next start` over a clean build: all 12 routes 200, each with exactly one `<main>`; the
served HTML carries no `data-anim` (so the no-JS path is unhidden); the gate compiles into the
served stylesheet as all four expected rules; the hero text is present in the no-JS HTML. A full
live sweep of every route in `api.py` was run by a Sonnet subagent against a real FastAPI app —
health 200/503, run gate default-refuse and allow paths, and confirmation that no provider route
returns a raw key.

**Not verified — do not claim otherwise.** Still nothing has been *seen*. The browser pane does not
composite in this environment, so there is no screenshot, no click-through and no confirmation of
hydrated data loading or the ambient canvas at any point. The model-backed paths (Ask's answer, the
heal loop) remain unexercised — no provider key is configured here.

**Known, still open.** The SSE disconnect behaviour of `GET /repos/{r}/events` could not be cleanly
exercised with Starlette's `TestClient`; the subagent reported it blocked, not failing, and it needs
a real HTTP client against a running `aftershock serve`. testlab is still CLI-only with no API route,
so the UI cannot reach it.

## 2026-10-18 (D27): the web UI, rebuilt

**Done.** Rebuilt the frontend from the backend outward on branch `ui-rebuild`, 5 commits
(`251d834`, `2781be5`, `098a7ef`, `367115f`, `6aa522c`, plus docs). Extended `lib/api.ts` to cover every
backend capability the old UI ignored; new Tests page (libraries visible, run gate explained, selection
preview); new `Trace` and `CodeBlock` primitives; Ask rebuilt to stream tool calls with per-step receipts,
a model picker and conversation checkpoints; `/settings/models` for bring-your-own provider keys
(Anthropic native + any OpenAI-compatible endpoint). Then every remaining screen — landing, overview,
Impact, Diff, Path, Cypher, impact-view, suspect-row, error boundaries, Culprit, Explore, graph-canvas —
moved onto the design system, and the compatibility layers were deleted: 18 legacy colour aliases, the
`LEVEL_*`/`TIER_*` maps, the `.epi-*` animations, the shadow aliases and the page-furniture shim in
`kit.tsx`. Risk colour now has exactly one definition. Rules written up in `web/DESIGN.md`; the living
style guide is the `/design` route.

Fixed in passing: `title=` tooltips that disagreed with or substituted for accessible names (overview
impact link, Path swap, suspect-row counts and score, Impact change-kind hints); glyph-only readouts with
no `sr-only` equivalent; truncated lists that did not say how many they hid; error boundaries that
swallowed the Next.js digest.

**Verified (actually run).** `tsc --noEmit` clean; `next lint` clean; `jest` 30/30; **`next build`
succeeds, 14 routes** (first time this was run on the rebuild — an earlier `/_not-found` invariant was a
stale `.next` from building over a live dev server, and does not reproduce on a clean tree). SSR via curl
on a freshly built `.next`: 13 routes, 12×200 plus a correct 404, each with exactly one `<main>`, and
**zero legacy token class names in any output**.

**Not verified — do not claim otherwise.** Nothing has been *seen*. The browser pane does not composite
frames in this environment (`screenshot` times out with "the Browser pane is not displayed"), so there has
been no visual check, no click-through and no screenshot at any point in this rebuild. The model-backed
paths — Ask's streaming answer and the heal loop — are unexercised, because no provider key is configured
on this machine; only their non-model branches have been rendered.

**Known, still open.** testlab is CLI-only with no API route, so the UI cannot reach it.

### Model id corrected

`aftershock/config.py:52` and `analysis/heal.py:48` defaulted to `"claude-opus-5-5"`, which matches no
documented Claude model id — the API would have rejected every Ask and heal call. Replaced with
`claude-opus-5` (the id the provider catalogue in `aftershock/providers.py` already listed), along with
the two assertions in `tests/test_agent.py` and the mentions in `README.md` and `ARCHITECTURE.md`.


## 2026-10-18 (D26): acting on the graph

**Done.** Measured runs from the app, suspect basis/why, fixer with read-only graph tools and Cause/Evidence,
`run_detail.next`, MCP `run_tests`/`heal` (local stdio + opt-in only), UI for all of it. Fixed: heal verify runs
polluted flakiness history; "ranked on static graph" label on passing runs; "all" mode was not measured.

**Verified.** pytest 174 passed, ruff clean, tsc/eslint clean, jest 30 passed. Live MCP stdio session against the
sample repo: run_tests all → 2 failed, measured → heal fixed 2 → 0 with explanation. CLI fixer called `symbol` and
`explain_path` on a real Claude call. UI checked headless (8111 API / 3111 next dev, both stopped): badges, why,
explanation and lookups render; no console errors; no overflow at 390 px.

**Not done.** Nothing committed (awaiting the user). zz-* graphs not deleted. The sample repo
`loopdemo/shop` keeps the applied fix in its working tree.


## 2026-10-18 (test loop): test library, runs in the graph, heal from the app (D25)

**Done.** Backend: library registration/indexing/running, TestRun graph schema, run history, heal with graph
context, API + MCP read tools, CLI `library` / `runs`. UI: failure callout on Tests, recorded-run view and streamed
fix loop on Culprit, recent runs. Fixed on the way: coverage ignored libraries; static reach tied a planted bug with
its callers (coverage now replaces it for measured passing tests); the web proxy did not gate the heal route.

**Verified.** pytest 169 passed; ruff, tsc, eslint clean; jest 30 passed. Headless Chromium against a separate API
(8111, run gate on) and `next dev` (3111): run → callout → run view (top suspect `discount_rate`) → Fix with AI with a
real Claude call → round 1 fixed 2 → 0, lineage shown, no console errors, no horizontal overflow at 390 px.

**Not done.** Nothing committed (awaiting the user). zz-* graphs (incl. the new `zz-shop-loop`) not deleted.


## 2026-10-18 (gaps): heal on real bugs, held-out repos, resolution fixes, full-text search, demo

**Done.** D20–D24 (CHANGELOG). heal bench on click: 6 of 6 fixed, rank-1 correct, exact reverts, full suite green
after each. Held-out flask and starlette added; weight fitting gave no held-out gain (weights unchanged). Top-5 head of
the ranked file list beats same-dir F1 on 4 of 5 repos; flask still loses. Demo video in `media/`.

**Measured.** Eval at 200 commits, depth 3 (README table). click mutation (n 30, seed 7): static recall .331 → .394,
caught 50% → 61%. Resolution: zustand 75.3% → 76.0%; flask edges 1,698 → 2,530 after the shallowest-root fix, but
flask all-tier F1 .127 → .096 (more test files reached, which the commit did not edit).

**Found on the way.** flask's `tests/test_apps/.../flask.py` made `flask` ambiguous, so the test suite had no edges
into the package. The UI server on :3101 (other session's) is a build that predates the Tests page: `/r/*/tests`
returns 404 there; the API on :8100 predates full-text search. Neither was restarted.

**Verified.** `pytest -q` 159 passed; `ruff check aftershock tests scripts` clean. click-eval checkout clean after
bench and mutate.

**Not committed.** Scratch `zz-click-old`, `zz-httpx-old`, `zz-zustand-old`, `zz-click-heal` graphs remain (delete on
request).

## 2026-10-18 (judge fixes): implicit-call edges, coverage survival, UX review fixes

**Done.** Everything in the judges' engineering and UX lists except weight fitting, deeper FalkorDB use, `heal` on a
real repo and a demo video (D19, CHANGELOG). Fair static before/after eval: old code (backup
`~/.aftershock-backups/aftershock-20261018-judgefix.tgz`) indexed as `zz-*-old` graphs and evaluated in the same run.

**Measured.** click recall .167 → .211, F1 .140 → .143; httpx recall .106 → .180, F1 .124 → .137; zustand unchanged.
Same-dir baseline still wins F1 on all three. click mutation (n 30, seed 7): static selection recall .116 → .331,
caught 33% → 50%, at 16.8% of the suite.

**Found on the way.** A first measurement looked worse (click F1 .123): re-index had started keeping 47k `COVERS`
edges, the eval was using them, and a parser bump marked all of them stale. Eval is now static; staleness is set only
on content change. Ablation confirmed constructor and implicit edges help code-file F1 (.151 off vs .180 on).

**Verified.** `pytest` 147 passed; `ruff check aftershock tests` clean (10 pre-existing findings in vendored
`testlab/bugs/quixbugs`). Web: non-test `tsc` clean, `next build` ok; headless Chromium over CDP on a scratch build:
node click rings the node, fills the selection bar, opens and scrolls to the row; at 390px with coarse pointer the
pane is not draggable, a swipe over the graph scrolls the page, no horizontal overflow, no button under 44px hit
area, no console errors. Web test tooling is missing dev deps (jest types, `jest-environment-jsdom`,
`eslint-plugin-testing-library`); not installed.

**Not committed.**

## 2026-10-18 (heal): Claude-driven fix loop on top of the runtime layer

**Goal.** The original ask was: AI reads the code, selects tests, runs them, lists issues, and tries to resolve them.
A separate line of work in this session (above) built the select/run/rank half for real (`coverage`, `run`, `mutate`,
coverage-aware culprit) and front-end component tests (React Testing Library). This closes the remaining piece: the
"tries to resolve them" half.

**Done.**

- `aftershock/analysis/heal.py` + `aftershock heal <repo> [--diff] [--apply] [--max-rounds N]` (D16). Built directly
  on the runtime layer (`runtime.pytest_run.run_selected`) and `tools.culprits`, not a separate test-running path:
  select -> run for real -> rank the top suspect -> ask Claude to rewrite its whole file -> re-run the same tests ->
  keep only if the failing set strictly shrank, else revert and try the next suspect. Bounded rounds, dry-run by
  default.
- 9 tests (`tests/test_heal.py`): real subprocess pytest runs against an on-disk fixture with two independent bugs
  (`calc.py`), a stub graph, and a monkeypatched `tools.culprits`/model call for the orchestration loop. Covers:
  all-passed (never touches Claude), dry-run with and without an API key (never touches Claude, never writes), a kept
  fix, a reverted fix that doesn't help, and a partial fix that is kept and the loop narrows in on the second bug on
  the next round.
- Built and verified in an isolated cloud Python harness against the real `aftershock` package (synced from this
  checkout) before touching this checkout, to avoid half-working code landing on the only working copy. Nine distinct
  bugs were found and fixed during that process (masking of a combined test-runner result, a tail-selection bug, a
  progress-detection bug that let a different-but-same-size failure set count as "no progress", a file-revisit bug
  that blocked fixing two bugs in the same file, a stale `failing_refs` computed once before the loop instead of each
  round, `python` instead of `sys.executable`, a missing dataclass default, an unused import, and (resolved for free
  by reusing the runtime layer's own `run_pytest`, which already sets it) a `__pycache__` staleness issue from
  rewriting and re-running a file within the same second).
- `DECISIONS.md` D16, `CHANGELOG.md`, `ARCHITECTURE.md`, `HANDOFF.md`, `README.md` updated; `LICENSE` (MIT, matching
  `pyproject.toml`) added and the README license line fixed.

**Verified.** `ruff check` clean (including on this checkout, confirmed directly). `pytest tests/test_heal.py` and
the full non-graph suite (72 passed, 45 skipped) green in the isolated harness built from this checkout's real code;
`ruff` re-confirmed directly on this checkout after the files were written here. This checkout's own `.venv/bin/python`
is a symlink outside the folder this session can reach (to a uv-managed interpreter), so `pytest` itself could not be
re-run directly on this machine from here — run `pytest tests/test_heal.py -v` yourself to get the same 9/9 on this
exact checkout.

**Not done.** `heal --apply` has not been run for real against a full indexed benchmark repo with a live model and a
live FalkorDB graph (D15's scratch-fixture-only testing strategy applies here too) — see HANDOFF's next steps. JS/web
test failures are not covered by `heal` (same reason runtime evidence is Python-only: no per-test JS coverage layer
exists yet to build culprit ranking on).

## 2026-10-18 (evening): runtime evidence (coverage, run, mutate) and benchmarks

**Goal.** The user asked to use Testing Library to "run tests with AI", list and fix failures, and find more tests
to benchmark with. Testing Library is a set of JS component-test helpers, not a test corpus, so the build went to
what makes test-driven answers real for any Python repo instead.

**Done.**

- `aftershock coverage | run | mutate` (D15), with COVERS edges in impact, test selection and culprit.
- `bench/repos.toml` and `scripts/bench_env.py`; envs built for click and httpx.
- A web "ran it" badge. 15 new tests.

**Measured.** On click, coverage recording took 7.6s for 47,210 edges. Mutation n=30, seed 7: 18 killed, 12 survived.

| Selector | Recall | Caught |
|---|---|---|
| static | .057 | 28% |
| same-name | .043 | 22% |
| coverage | .997 | 100% (by construction) |

**Verified.** pytest 109 passed; ruff clean; tsc clean for app code. eslint and next build are blocked by an
uninstalled Jest setup that appeared in `web/` at 16:06 from outside this work (HANDOFF); I did not touch it.

**Not done.** httpx mutation: its tests need port 8000, which the Epicenter stack holds. The web server was not
rebuilt.

**Mistakes.** `tar` overwrote the pre-runtime snapshot `aftershock-20261018-runtime.tgz`. The post-change archive is
now `…-runtime-after.tgz`, and the newest pre-change snapshot is `…-friendly.tgz`.

## 2026-10-18 (late): reference graphs hidden, overloads, friendlier UI

**Goal.** The user asked why the reference repos were listed on the home page, and to resolve the open gaps, raise the
score and make the product easier to use.

**Done.**

- Reference graphs moved to a hidden "lab" set (D13); nothing deleted. Home now lists only `aftershock` and `AERIS`.
- Overload stubs: calls bind to the implementation, lookup expands the family, stubs never "untested" (D14). Test
  selection for click `Context.invoke`: 0 → 350 tests in 21 files.
- Resolution: library re-exports external, `Path /`, rest-spread forwarders. Blind call sites: aftershock 938 → 731,
  epicenter 1201 → 1086, zustand 454 → 432.
- UI: onboarding steps, Explore suggestions, `#N` stripped from labels, clearer subsystem names, dead code ignores
  `.d.ts`/interfaces.
- Full re-index of all 8 graphs at `PARSER_VERSION` 13.

**Measured.** Eval at 1500 commits, possible-tier F1: click .149 → .140 (+importers .172 → .167), httpx .116 and
zustand .072 unchanged. The same-dir baseline still wins on httpx and zustand.

**Verified.** pytest 94 passed; ruff clean; tsc, eslint, next build clean; smoke 12 loads at 1440/390px with no
errors, no overflow, no `#N` text.

**Mistakes.**

- I claimed Epicenter's `cn` was a missing module; it is a re-export of the `cn` package. Removed from HANDOFF.
- A smoke run reported a broken impact deep link; the script used `?targets=` instead of `?t=`. Both now work.
- Keying overloads with `split("#")[0]` dropped nested defs under numbered parents (click 2693 → 2676 edges). An
  edge diff caught it; fixed with `_unnumbered`.
- A stray `zustand-eval` clone was left in the project; moved to the scratchpad.

**Next.** See HANDOFF → Recommended next steps. Nothing committed.

## 2026-10-18: accuracy measurement and resolver fixes

**Goal.** Go beyond priors: measure how well impact predicts real change, then fix what the measurement exposed.

**Done.**

- **Measurement.** Built `aftershock eval`, a history replay with tiers, breakdowns, a same-directory baseline and the
  import-only variant. Ran it at 1500 commits on click, httpx and zustand. Results are in README → *Measured accuracy*.
- **Click miss diagnosis.** Of the missed code files:

  | Why the file was missed | Files |
  |---|---|
  | No static link at all | 306 |
  | Callee of the change | 131 |
  | Imports the anchor | 162 |
  | Imported by the anchor | 132 |
  | Deeper or weaker dependent | 10 |

  This led to D3: import-only dependents as a separate, unscored list in the API, report and web UI.
- **Bugs fixed** (details in CHANGELOG): impact hop truncation, tsconfig `paths` semantics, JSONC stripping inside
  strings, star re-exports, and cast/parenthesized arrow functions (`PARSER_VERSION` 5). Re-indexed epicenter and
  epitest.
- **Cleanup.** Removed six unused web UI primitives.
- **Docs.** Wrote ARCHITECTURE, DECISIONS, CHANGELOG and HANDOFF, and updated the README.

**Verified.**

- pytest: 76 passed. ruff, tsc, eslint and the Next build are clean.
- Headless Playwright: flow runs plus the impact tile at desktop and phone widths, with no console errors.

**Not done.** No git commits (not requested). Eval is not exposed over the API or MCP. Override edges and return-type
inference are still open. See HANDOFF → *Recommended next steps*.

## 2026-10-18: override edges

**Goal.** Make class hierarchies count. Changing a base method should reach its overrides. Changing an override
should reach code that calls it through the base.

**Done.**

- The resolver emits `OVERRIDES`.
- Graph queries `dispatch_callers`, `dispatch_targets` and `overriders` were added.
- Impact handles override and dispatch steps, including override arity verdicts.
- Culprit and test selection follow dispatch.
- Dead code excludes overriders.
- UI, agent and MCP wording was updated.
- Design rationale is in D8.
- Re-indexed click, httpx, zustand, epicenter and code-graph-rag. Override counts: click 78, httpx 68,
  code-graph-rag 137, and none on zustand or epicenter.
- Re-ran the eval at 1500 commits. Simulator F1 rose from .153 to .157 on click and from .102 to .113 on httpx.
  zustand was unchanged.
- Recovery point: `~/.aftershock-backups/aftershock-20261018-override.tgz`.

**Mistake.** A stray command re-indexed the Epicenter folder under the name `epitest`, overwriting that scratch
graph. It was restored from its scratchpad root, and only 2 files differed. The Epicenter folder was only read, and
its git status is clean.

**Verified.**

- pytest: 82 passed. ruff, tsc, eslint and the Next build are clean.
- Headless Playwright on the httpx impact page renders the "can dispatch to" why-chain. There were no console errors
  and no horizontal overflow at 390px.

**Not done.** No git commits (not requested). Return-type inference and exposing eval are still open.

## 2026-10-18: return-type, `with` and fixture inference

**Goal.** Resolve calls on locals whose type comes from a function's result.

**Measured first.** A scratch diagnostic classifies every unresolved receiver call. Undeclared returns were not the
biggest gap in Python repos. Untyped pytest fixture parameters were (`runner.invoke` about 330× on click; `client`,
`env_test` and `blank` on Epicenter), followed by `with X() as x` (httpx `client.get`). All three were built.

**Done.**

- Parser: `Def.ret_hint` and `with` bindings (`PARSER_VERSION` 6).
- Resolver:
  - Hints are used in `_result_type`.
  - `with` resolves through `__enter__`.
  - Fixtures use pytest lookup order.
  - Iterator and Generator annotations are unwrapped.
  - Go `(*S, error)` results type the first result.
- D9 records why only agreeing returns count.
- Receiver calls resolved: click 1408 → 1817, httpx 1506 → 1620, Epicenter 532 → 660.
- Call-site rate: click 41 → 49%, httpx 47 → 50%, Epicenter 29 → 31%.
- Hand check: 18 random new `inferred` edges across click, httpx and Epicenter were all correct.
- Eval: httpx F1 .113 → .117. click .157 → .148, entirely in test files: the fixture links are correct but
  co-change does not reward them. This is reported, not tuned away.
- Recovery point: `~/.aftershock-backups/aftershock-20261018-returns.tgz`.

**Verified.** pytest: 84 passed. ruff is clean. The web app was not touched in this step.

**Not done.** Loop and element types, and how harness hubs are scored. See HANDOFF.

## 2026-10-18 — Closing resolution gaps: element types, aliases, external calls

**Goal.** Close the remaining resolution gaps, and separate calls we cannot see from calls that simply leave the repo.

**Done.**

- Parser (`PARSER_VERSION` 8, then 9):
  - Loop, comprehension and callback element types; subscripts; literal types.
  - Python type aliases, including 3.12 `type`.
  - TS/JS value aliases (`const x = y as T`).
- Resolver:
  - Container element unwrapping across Python, TS, Go and Rust.
  - Aliases followed through imports; `import a.b.c` binds `a`.
  - `is_external` classification.
- Pipeline and UI: `external_sites` and `repo_resolution_rate`, shown by `index` and on the overview. D10 records why.
- Call-site rate: click 49.0 → 49.8%, Epicenter 30.5 → 31.2%, zustand 14.3 → 19.6%; httpx unchanged.
  Repo-bound: 63 / 61 / 44 / 44%; code-graph-rag 56%.
- Eval F1, all tiers: zustand .040 → .068, click .148 → .149, httpx .117 unchanged.
- Fixed an overview crash on repos with import cycles. A backend shape change was never carried into the page.
- Recovery point: `~/.aftershock-backups/aftershock-20261018-loops.tgz`.

**Verified.**

- pytest: 88 passed. ruff is clean.
- Web: `tsc`, `next lint` and `next build` are clean.
- Headless smoke of 8 pages × 2 repos × 2 widths: no errors, no overflow.

**Not done.**

- Factory-returned objects (zustand's `create()` APIs, about 420 sites).
- Harness-hub scoring.

See HANDOFF.

## 2026-10-18 — Factory-returned objects

**Goal.** Resolve calls on objects that factories build at runtime. This was zustand's largest blind spot.

**Done.**

- Parser (`PARSER_VERSION` 10, then 11):
  - `obj:` shapes for JS object literals.
  - `fn:` for a returned nested function.
  - `Object.assign` sources.
  - Weak casts (`as any`) looked through.
  - Curried ternaries (`curry:`).
  - Fixed arrow-const annotations being taken as return types.
- Resolver: synthetic shape Defs, never emitted (D11); callable variables; `f()(x)` on curried factories.
- zustand: 19.6 → 29.7% of call sites, 43.5 → 66.0% repo-bound. 945 edges, up from 713.
- The other repos' edge sets are unchanged (same edge counts).
- Hand check: 22 randomly sampled new zustand edges all point at the right definition. Where middleware wraps a member,
  the edge goes to the original, which D11 records.
- Eval F1: zustand .068 → .073. The new links are mostly test → store API, which co-change rewards little.
- Recovery point: `~/.aftershock-backups/aftershock-20261018-factory.tgz`.

**Verified.** pytest: 89 passed. ruff is clean. The web app was not changed.

**Not done.** Callback parameters typed by the callee's declared function type, and harness-hub scoring.

## 2026-10-18 — Callback parameters and closing resolution gaps

**Goal.** Resolve the gaps a per-receiver diagnostic showed, and stop counting library calls as blind spots.

**Done.**

- Parser `PARSER_VERSION` 12: parameter use facts (`pcall:`, `pfwd:`, `cb:`, `retparams`), destructuring, literal
  receivers.
- Resolver: callback binding through curried factories and middleware; imported variable types; `@property` types;
  externals for literals, Python builtins, `*args`/`**kwargs`, pytest fixtures, library context managers and chains
  off library values. Fixed JS test labels shadowing imports. D12 records the rules.
- Blind call sites: zustand 606 → 454, click 797 → 385, httpx 559 → 310, Epicenter 1905 → 1201.
- Re-indexed all six graphs. Edge diffs against the pre-round code: zustand +127/−5 and httpx +22 (without/with
  tsconfig the counts differ from the index totals). The 5 removals were the test-label bug. Hand check of 8 zustand
  and 5 httpx new edges: all correct.
- Eval F1 within ±.002 (zustand .073 → .072, httpx .117 → .116, click .149).
- Recovery point: `~/.aftershock-backups/aftershock-20261018-callbacks.tgz`.

**Verified.** pytest: 91 passed. ruff is clean. Epicenter's git tree is clean. The web app was not changed.

**Not done.** Flagging unresolvable imports; harness-hub scoring.

## 2026-10-18 — Testlab: end-to-end scenario suites

**Goal.** Build a complete end-to-end test library for Aftershock, using existing published tests where possible.

**Done.**

- `aftershock/testlab.py` + `aftershock testlab`: known-answer scenarios through diff → impact → select → full-suite
  run → selected rerun → culprit, with declared gaps (D17). The format is in `testlab/README.md`.
- Suites:
  - ledger: new Python fixture, 9 scenarios.
  - inventory: TypeScript, 3 scenarios, static only.
  - QuixBugs: 40 real bugs, vendored with their tests by `scripts/vendor_quixbugs.py`.
- Product fixes the first run exposed:
  - f-string and escaped-string edits went undetected (`PARSER_VERSION` 14);
  - selection pruned reachable tests below p 0.03;
  - there were no test → fixture edges;
  - the `Class.factory().method()` chain was unresolved.
- `mutate` now scores the product's real selection (impact plus reachability).
- Click re-indexed and coverage re-recorded (47,210 COVERS edges).
- Recovery point: `~/.aftershock-backups/aftershock-20261018-testlab.tgz`.

**Results (measured).**

- ledger: 9/9, recall 1.0, culprit #1 7/7. Before the fixes: 6/9, recall .70.
- inventory: 3/3.
- QuixBugs: 40/40, recall 1.0, culprit #1 40/40, 254 s.
- Click mutation, static selection: recall .057 → .116, at 7.0% of the suite.

**Verified.** pytest: 125 passed, including `tests/test_testlab.py` against the live graph. ruff is clean. The web app
was not changed.

**Not done.**

- A JS runtime suite.
- A click scenario set.
- Nothing is committed.

## 2026-10-18 -- run tests from the UI (D18) + judge review

- Built: gated SSE run route (`runtime/jobs.py`, `api.py`), streaming/cancellable `run_pytest`, proxy loopback checks,
  web Tests page, Run links from Impact/Diff, `SuspectRow` shared with Culprit, `error.tsx`, `ErrorNote` retry.
- Judge fixes: REST DNS-rebinding guard, edited/added tests selected, testlab `_apply` all-or-nothing, Explore error
  shown, Tailwind v4 width syntax in the symbol picker.
- Verified: `pytest -q` 140 passed (FalkorDB up); `ruff` clean; `tsc` clean for app code (90 errors, all in Jest test
  files without installed types). Not verified: the page in a real browser, `eslint`, `next build`.
- Backup: `~/.aftershock-backups/aftershock-20261018-webrun.tgz`. Nothing committed.
- Open (from judges): `__init__`/dunder/property callers, kwargs arity false positives, module-level and added-override
  seeds, COVERS dropped on re-index, uncapped edge queries, Cypher LIMIT guard, demo video, F1 vs same-dir baseline.
