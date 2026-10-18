# Session log

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
