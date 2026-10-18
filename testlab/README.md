# Testlab

End-to-end tests for Aftershock itself: small repos with known answers, run through the same path a user takes.

```
index (once per suite) → change the working tree → diff → impact → select tests
→ run the whole suite (ground truth) → run only the selected tests → rank culprits → restore
```

```bash
aftershock testlab --list                  # suites and scenario counts
aftershock testlab ledger inventory        # run suites (all when none named)
aftershock testlab quixbugs --only gcd     # scenarios whose id contains "gcd"
aftershock testlab ledger --json --keep    # machine output; keep the scratch copy and graph for inspection
PYTHONPATH=. .venv/bin/python -m pytest tests/test_testlab.py   # the CI slice (ledger, inventory, one QuixBugs bug)
```

It runs the fixtures' own tests, so like `coverage`/`run`/`mutate` it is CLI-only. Each suite is indexed into a
`testlab-<repo>` graph, hidden as a lab graph, and dropped afterwards along with its scratch copy (under the cache
dir's parent, `testlab/<repo>`). The fixture's baseline suite must pass before any scenario runs.

## Layout

| Path | What |
|---|---|
| `repos/ledger/` | Python banking ledger, 19 tests: cross-module calls, overrides + dispatch, pytest fixtures, a context manager |
| `repos/inventory/` | TypeScript order service: typed parameters, cross-directory imports (static checks only, no JS runner) |
| `repos/quixbugs/` | QuixBugs correct programs as package `quixbugs`, with the benchmark's pytest cases |
| `bugs/quixbugs/` | The 40 buggy twins, one real published bug each |
| `scenarios/<suite>.toml` | One suite per file |

## Scenario format

```toml
repo = "ledger"          # directory under repos/
run = true               # false: static checks only (no test run, no culprit)
coverage = false         # true: record per-test coverage before the scenarios

[[scenario]]
id = "withdraw-signature"
title = "A new required argument on Account.withdraw"
why = "What this exercises"
[[scenario.edit]]        # `find` must occur exactly once; or `swap = "path"` replaces the whole file
file = "ledger/accounts.py"
find = 'def withdraw(self, amount: Money, memo: str = "withdrawal") -> None:'
replace = 'def withdraw(self, amount: Money, memo: str, *, approved_by: str) -> None:'
[scenario.expect]
changes = ["signature:ledger/accounts.py::Account.withdraw"]   # kind:id the diff must detect
impacted = ["ledger/bank.py::Bank.transfer"]                   # must be in impact
not_impacted = ["ledger/report.py::split_bill"]                # must not be
selected = []            # tests that must be selected (static suites)
max_selected = 0         # upper bound, e.g. for dead code
failing = ["tests/test_accounts.py::test_overdraw_is_refused"] # EXACT set the full suite fails (checks the scenario)
culprit = "ledger/accounts.py::Account.withdraw"               # must rank ≤ culprit_top (a nested function counts)
culprit_top = 1
[scenario.gaps]          # optional: a known limit, reported as `gap` instead of failing; `gap-fixed` once it passes
selection = "why this can't be selected yet"
```

Checks, in order: `changes`, `impacted`, `not_impacted`, `selected`, `max_selected`, `truth` (the suite really fails
what the scenario says, so a wrong scenario is not mistaken for a product bug), `selection` (every failing test was
selected), `rerun` (running only the selected tests reproduces those failures), `culprit`.

A `[generate]` table makes one scenario per file in a bugs directory (see `scenarios/quixbugs.toml`).

Write expectations from the code, then run. When a check fails, fix the product or declare a gap with the reason;
never loosen an expectation to make a run pass.

## QuixBugs

Lin, Koppel, Chen, Solar-Lezama, "QuixBugs: A Multi-Lingual Program Repair Benchmark Set Based on the Quixey
Challenge" (SPLASH 2017), MIT licence (`repos/quixbugs/LICENSE`). Vendored by
`python scripts/vendor_quixbugs.py <QuixBugs checkout>`. Changes and source commit: `repos/quixbugs/VENDORED.md`.
Buggy versions can loop forever, so its conftest gives every test a 5 s limit; the full suite takes about 4 minutes.
