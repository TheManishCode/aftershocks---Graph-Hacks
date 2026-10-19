# Contributing to Aftershock

Thanks for looking. Aftershock makes claims about other people's code ("this breaks", "that test covers it",
"this is the culprit"), so the bar for a change is simple: **it has to be true, and there has to be a test that
says so.**

## Getting it running

You need Python 3.12+, Docker, and Node 22 if you touch the web UI.

```bash
git clone https://github.com/TheManishCode/aftershocks---Graph-Hacks aftershock && cd aftershock
docker compose up -d falkordb             # FalkorDB on 127.0.0.1:6390, password "aftershock"
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev,agent]"
aftershock index tests/fixtures/mini      # a tiny repo whose call graph is known by hand
aftershock overview mini
```

The web UI, against a local API:

```bash
aftershock serve                          # API on 127.0.0.1:8100
cd web && npm install && npm run dev      # UI on http://localhost:3101
```

## Running the checks

These are exactly what CI runs:

```bash
ruff check aftershock tests
pytest -q                                 # graph tests skip if FalkorDB is unreachable
cd web && npm run lint && npm test && npm run build
```

Tests index fixture repos into throwaway `pytest-*` graphs and drop them afterwards, so they never touch your real
indexes.

If your change affects what Aftershock *predicts* (parsing, resolution, impact weights, test selection, culprit
ranking), also run the end-to-end suites with known answers:

```bash
aftershock testlab                        # ledger, inventory, QuixBugs; see testlab/README.md
```

A drop in any testlab score is a regression unless you can show the old expectation was wrong.

## What a change should carry

- **One concern per commit**, with a message that says *why*. The diff already says what.
- **A test that would have caught it.** Not just a test that passes: one that fails before your fix. Revert the
  fix, watch it go red, then put it back.
- **Honest numbers.** If you change anything that the benchmarks measure, re-run the affected benchmark and update
  [`docs/benchmarks.md`](docs/benchmarks.md) with the date, including when the number got worse. Don't change a
  testlab expectation to make a run pass; fix the product or explain in the PR why the expectation was wrong.
- **Docs that match the code.** A user-visible change updates the README or [`docs/how-it-works.md`](docs/how-it-works.md)
  and gets a line in [`CHANGELOG.md`](CHANGELOG.md). A design choice someone might later question goes in
  [`DECISIONS.md`](DECISIONS.md) as a new `D<n>` entry.

## Boundaries that are not negotiable

- **Running code is opt-in and local.** Anything that executes the indexed repo (tests, `command` scripts,
  installs, the fix loop) must sit behind `AFTERSHOCK_ALLOW_RUN=1` *and* the loopback check, with showcase repos
  as the only, deliberately capped, exception ([`SECURITY.md`](SECURITY.md)). Add a test that it is refused
  without them.
- **The graph is read-only from outside.** `/cypher` and the MCP `cypher` tool accept read queries only. Don't
  widen that.
- **Secrets never leave the server.** No route returns a model key, no log line prints one, and no error echoes a
  server path.
- **One tool layer.** CLI, API, MCP and the Ask agent all go through `aftershock/tools.py`. A new capability goes
  there first, so every surface gets the same answer.
- **Every answer carries its evidence.** A new analysis returns the hops, resolutions and confidences that led to
  its result, not just the result.

## Good first contributions

- **A testlab scenario.** Found a change Aftershock gets wrong? Turn it into a scenario with the expected answer
  ([`testlab/README.md`](testlab/README.md)). It's the most useful bug report there is.
- **Resolution gaps.** `python scripts/gaps.py <repo root> src` groups a repo's unresolved call sites by pattern.
  Each pattern fixed raises recall everywhere.
- **Language coverage.** Go, Java and Rust parse and resolve, but no real repository has been evaluated. Running
  `aftershock eval` on one and reporting what breaks is valuable even without a fix.

## Pull requests

1. Fork and branch from `main`.
2. Make the change, with tests.
3. Run the checks above.
4. Open the PR and fill in the template. Screenshots for UI changes; before/after numbers for anything the
   benchmarks measure.

## Reporting a bug

Open an [issue](https://github.com/TheManishCode/aftershocks---Graph-Hacks/issues/new/choose). The most useful
report includes:

- the command or page, and what you expected versus what you got;
- the output with `--json`, if it's a wrong answer;
- the commit you're on (`git rev-parse --short HEAD`), your Python version, and the repo you indexed if it's public.

Security problems go through [`SECURITY.md`](SECURITY.md), not public issues.

## Recognition

Everyone who lands a change, reports a bug that leads to a fix, or contributes a testlab scenario is added to
[`CONTRIBUTORS.md`](CONTRIBUTORS.md). Add yourself in your PR if we forget.

By contributing you agree that your work is released under the [MIT License](LICENSE) and that you'll follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
