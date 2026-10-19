# Benchmarks

Every number Aftershock publishes, how it was measured, and how to read it. All runs are reproducible from this repo: benchmark repos and their test environments are pinned in `bench/repos.toml`.

[← README](../README.md) · [How it works](how-it-works.md)

## Commit replay

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

## Five repos, two of them held out (2026-10-18, 200 commits, depth 3)

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

## Self-healing on real bugs

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

## Real breakage: mutation

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

## End to end: the testlab

`aftershock testlab` runs scenarios with known answers through the whole product. Each scenario changes a fixture
repo, then the runner checks:

- the detected change and its impact;
- the selected tests, against a full-suite run as ground truth;
- that a run of only the selected tests reproduces the failures;
- the culprit ranking.

Format and how to add scenarios: [`testlab/README.md`](../testlab/README.md). Measured on 2026-10-18:

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

