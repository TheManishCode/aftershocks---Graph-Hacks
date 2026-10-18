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

Verification:

| Check | Result |
|---|---|
| `pytest -q` | 94 passed (needs FalkorDB on :6390; graph tests skip otherwise) |
| `ruff check aftershock tests scripts`, `tsc --noEmit`, `eslint .`, `next build` | clean |
| `scripts/smoke.mjs` on home, overview, explore, impact (aftershock + click) at 1440px and 390px | 12 loads, no errors, no overflow, no `#N` in text |
| Headless Playwright runs (path, cypher, ask, diff, culprit, impact incl. the import-only tile and a DISPATCH why-chain on httpx) | no console errors |
| Smoke run of all 8 pages on click and zustand at 1440px and 390px (after the cycles fix) | 32 loads, no errors, no overflow |
| Impact view at 1440px and 390px | no horizontal overflow |

The project has an empty `.git` (no commits); nothing has been committed. The latest recovery point is
`~/.aftershock-backups/aftershock-20261018-friendly.tgz` (before lab hiding, overloads and the UX pass). Earlier ones:
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

## Recommended next steps

1. **Find why click's possible-tier F1 slipped** (.149 → .140 across this round's resolver changes, with overload
   binding the likely cause); compare per-commit predictions before and after rather than guessing.
2. **Harness hubs in scoring.** Decide whether tests reached only through a shared fixture or harness method should
   count as "tests to run" (they should) but be scored lower as "likely to break". Validate on a held-out repo, not
   on click.
3. **Re-tune `weights.json`** per repo from `aftershock eval` output, and consider moving the tier thresholds.
4. **Expose eval** via the API/MCP as a background job (it takes about a minute at 1500 commits), with a web page for
   the table.
5. **Evaluate a Go or Java repo** to back the language claims with numbers.
6. **Make the first commit** (the `.git` is empty) and choose a license.
