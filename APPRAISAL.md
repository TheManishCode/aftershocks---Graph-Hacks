# Aftershock: Final Appraisal

## 1. Verdict

Aftershock is a strong and unusually honest entry, rated about 7.3/10 by the judge. The loop is fully implemented and wired through CLI, API, web and MCP. It runs index, test selection, test run, TestRun graph facts, an Ochiai culprit with call chains, a graph-tool-equipped fixer, and a strict-improvement re-run. No other product the judge found combines all of these. Its main weakness is where the track brief weighs most. Tool selection and graph reasoning are partly scripted, and the evidence behind the repair claims is thin. The worst engineering defect is in heal's edit loop. It writes AI code into the live checkout with no try/finally. A timeout or crash during the verify run leaves an unverified edit on disk. That contradicts the `api.py` docstring promise that an edit is "always either kept after a re-run or reverted". The security design is layered and sound by default, and the weak spots appear once `AFTERSHOCK_ALLOW_RUN=1` is set. The test suite is real, 174 passed in 31.58s with no skips and FalkorDB up, but it is thinnest around heal. The UI performance score is a static source reading only, because no production build or Lighthouse data existed.

| Dimension | Score | Basis |
|---|---|---|
| Overall (judge) | 7.3 | Best-in-track on integration and honesty. Weakest on measured repair quality, history-driven reasoning and edit-loop safety. |
| Code quality and correctness | 6.5 | Sound architecture. Weak spots are the heal verify path, index write ordering, and coverage and ranking edge cases. |
| Security | 6 | Layered design. Main risk is what runs once run/heal is enabled. |
| Testing | 6.5 | 174 passed, 31.58s. Heal failure and restore paths are largely untested. |
| UX / performance | 5 | Static audit only. No LCP, INP, CLS, TTFB or bundle numbers were measured. |

The run that produced the test result took two invocations. The first used system Python 3.14.7 and failed at conftest import (`ModuleNotFoundError: pydantic`), executing zero tests. The second used the project `.venv/bin/python` with identical arguments.

## 2. Ranking vs competitors (from the judge)

The judge gave no numeric rank. The judge's overall position is best-in-track on end-to-end integration and honesty. If the judging rewards visible multi-hop, explainable reasoning, it scores very well. If it asks how the team knows the fixes are good and the tool choices are smart, today's answer is one repo, six easy bugs, and a hardcoded suggester.

The judge ran nothing that writes and re-measured none of the project's numbers. All figures come from the project's own README and HANDOFF.

| Competitor | Aftershock wins | Aftershock loses |
|---|---|---|
| Launchable / CloudBees Smart Tests | Explainability (a path per test), no training period | Scale, history-driven ranking, CI maturity |
| pytest-testmon | Graph layer: static-reach fallback, dispatch, multi-hop explanations | Testmon is a mature MIT plugin. Aftershock's COVERS is the same idea and it does not say how it differs. |
| Gitar (CI auto-fix, sold by Sonar) | Localization with explicit evidence, strict-improvement guard | CI-native operation: PR bot, multi-CI, pushing commits, re-run until green |
| AutoCodeRover / Agentless / SWE-agent | Same localize-then-repair architecture (D25) | Those are evaluated on SWE-bench and Aftershock is not. Sonar's 79.2% SWE-bench Verified is a vendor press release. |
| Meta SapFix/Sapienz | Not compared on scale | SapFix cross-checks patches with static analysis. Aftershock's gate is only "selected tests pass". |
| Greptile / CodeRabbit | `aftershock ci` runs tests; neither competitor does | No LLM review layer |
| GitNexus, FalkorDB Code-Graph, codebase-graph, code-graph-rag | Running tests, recording runs as graph facts, closing the loop | Language breadth, precomputed clusters and trace packaging |
| Diffblue Cover | Not a competitor on the loop | It is the model for HANDOFF item 4 (AI tests for mutation survivors) |
| CodeQL / Joern / SCIP | No quantitative claim possible | More precise analyses. Aftershock's call-site resolution is 50% on all call sites and about 60-70% on repo-bound calls (README:342-348), which bounds recall. |

The CloudBees Smart Tests rename rests on a single 2026 source that is unverified on an official page.

**Where it wins:**
- Per-test coverage is folded into COVERS edges, so culprit ranking uses what the failing tests executed (`culprit.py:141-175`, `pytest_run.py:185-213`).
- Every suspect carries a hop-by-hop path and a `why` string showing the Ochiai arithmetic (`culprit.py:185-199`).
- Runs are graph facts: TestRun, RAN, SUSPECTS and RETRY_OF edges (`runs.py:1-12, 57-95`).
- `run_detail.next` returns concrete tool calls with reasons (`tools.py:446-473`).
- MCP action tools `run_tests` and `heal` register only on stdio with `AFTERSHOCK_ALLOW_RUN=1` (`mcp_server.py:240-243`).
- The fixer's tool server runs with running switched off (`heal.py:132-134`), and the CLI backend passes `--tools ""` (`heal.py:143`).
- The README publishes where it loses. The same-directory baseline wins F1 on httpx and zustand, the definite tier never fired, and coverage wins mutation "by construction".
- The keep-only-strict-improvement rule with revert is the right acceptance gate (`heal.py:416-423`).

## 3. Biggest flaws and root causes

Duplicates across dimensions are merged. Severities are the verified ones.

**3.1 Heal leaves an unverified edit on disk when anything raises after the write (high).**
- Root cause: `heal.py:404` calls `write_text(new_text)` and the only revert is `heal.py:418`, with no try/finally. `run()` can raise `RuntimeErrorReport` on timeout, or on pytest exit 3/4 (`pytest_run.py:132-142`). The recorder can also raise `GraphUnavailable`.
- Nothing upstream restores the file. `jobs.heal_run` (`jobs.py:122`) has no handler, `api.py` `work()` only emits an error, and `cli.py:664` only prints.
- A realistic trigger is a Claude edit that makes an imported module a SyntaxError. pytest then exits 4 with node-id arguments, which raises and leaves the broken file.
- A truncated fenced block (3.5) hits the same path.
- Cancel is not reachable for heal. The `api.py` lambda ignores `cancel`, and `stop_on_leave=False` is deliberate. Timeout, exit 3/4 and a daemon-thread kill remain.
- `api.py` docstring (~line 436-442) promises the edit is always kept or reverted, which this path falsifies.
- Citations vary slightly across reviewers. The code reviewer noted `api.py` lines are about 10 lower than originally cited.

**3.2 Heal verifies only the originally selected tests (medium).**
- Root cause: `heal.py:405` re-runs `test_ids`, and `heal.py:410-415` returns "fixed" once that set is green.
- The D21 widen step (`heal.py:327-338`) runs only when the first run was already green.
- A fix that turns the selected tests green while breaking an unselected test is accepted.
- This is mitigated because the selection is a reverse-reachability superset (`tools.py` ~228-234). The README attributes "full suite after: 0" to `heal_bench.py` and does not overclaim.
- Related gap: the verify step has no "rows must exist" guard. The plugin writes rows only in `pytest_runtest_logreport` (`_aftershock_pytest.py:36-45`).
- With whole-file arguments, a collection error exits 2 with zero rows. `after_failing` is then empty and the round is falsely kept as fixed.
- Whole-file arguments occur only on the more-than-2000-node collapse (`pytest_run.py:346`) or a file-only id, so the path is narrow.
- The initial run has a "nothing ran is not green" guard (`heal.py:322-326`). The verify step does not.

**3.3 Heal's revert is not byte-exact (medium).**
- Root cause: `heal.py:373` reads with `read_text(encoding='utf-8', errors='replace')`, and `heal.py:404` and `418` write with `write_text`.
- CRLF files come back LF. Invalid bytes become U+FFFD, even on a reverted round.
- Reproduced in `/tmp`: `b'x=1\r\ny=2\r\n'` returns `b'x=1\ny=2\n'`.
- This contradicts D16 ("left exactly as it was found", `DECISIONS.md:158-170`).
- A kept edit is also normalised.
- `tests/test_heal.py:98-114` uses an LF/ASCII fixture and asserts only the outcome.

**3.4 Repair evidence is thin and possibly flattering (medium).**
- The benchmark is six one-line planted bugs in one public repo (click, pinned commit), all reported "exact revert" (`heal_bench.py:17-29`, README:177-191).
- There is no ablation of no graph versus chain only versus chain plus tools. The D26 tool-using fixer has no measurement of whether its graph lookups changed outcomes.
- Contamination from the model recalling click's original code is a fair concern.
- The README discloses "Six bugs in one repo is a small sample", so this is a rigor gap and not a misrepresentation.

**3.5 Code-fence extraction truncates files (medium).**
- Root cause: `heal.py:122-124` `_extract_code_block` ends at the first closing triple backtick. `heal.py` itself contains triple-backtick strings.
- The truncated text is written unchecked at line 404.
- A truncated file that is still valid Python usually fails more tests and is reverted. A SyntaxError case lands in 3.1.

**3.6 Culprit ranking weaknesses (low to medium).**
- One-line functions get no COVERS edge, because `pytest_run.py:265-268` builds ranges only when `end_line > line` (medium). In `culprit.py:168-175` measured tests are removed from the static passing set. A one-line helper on a failing path ends with `passed == 0`, and its score reduces to sqrt(f/F) (`culprit.py:181`). It can tie at the top and beat a real culprit. The claims about lambdas and multi-line signature continuation are unverified.
- The failing side uses forward static reach even for measured tests, while the passing side counts only executed code (`culprit.py:135-143, 172`). Changed symbols use `CHANGED_DEPTH` 12 against `REVERSE_DEPTH` 5 (`culprit.py:146-159`). The depth difference is deliberate and commented (`culprit.py:29-31`) and the x1.5 boost is documented. This is a methodology bias with unmeasured magnitude.
- Ochiai is per function (`culprit.py:171, 181`) with a magic `CHANGED_BOOST=1.5` (`culprit.py:28`). Candidates are cut to 60 before test and module filtering (`culprit.py:151-158`). No git blame, churn, co-change or PageRank signal is used.

**3.7 Test selection ignores recorded history (low).**
- `select_tests` appends every test that reaches the seeds at any depth with `p=0.0` (`tools.py` ~228-234; the cited 21-30 is wrong). It does not read TestRun history.
- Ordering does exist, since reach-only tests rank after probable ones. Over-selection is deliberate (D21: a missed test gave a false green).
- The README's 996 flask false positives are impact-eval precision, not test-selection output.
- "Test library" is only an external pytest directory (D25), with no catalog, tags or suites.

**3.8 MCP tool selection is not a measured capability (low).**
- `next_steps` (`tools.py:446-473`) is a fixed if-chain, though it branches on run state. It is advisory only.
- In Claude mode the model picks tools from MCP-derived specs (`agent.py:84-92`). Only the keyless router is scripted, and its docstring says so (`agent.py:3-9`).
- No tool-selection evaluation exists. `tests/test_agent.py` has 10 tests and none of this kind.
- Nothing stores or reuses which graph-query sequences worked.

**3.9 Index write ordering leaves permanent holes after a crash (medium).**
- Root cause: `pipeline.py:307-313` upserts File `sha` and `out_digest` before symbols (325), CONTAINS (326), `drop_outgoing` (329) and the edge batches (347-355).
- Incremental detection at 289-296 trusts those fields. A mid-write failure leaves those files skipped on the next run until `--full`.
- It needs a mid-write failure such as a FalkorDB timeout, restart or signal.

**3.10 Parser-skipped files crash diff-mode (medium).**
- `diff.py:139` does `next(d for d in facts.defs if d.qname == MODULE)` with no default.
- `parse.py:186-189, 195-198` return empty defs for files over 1 MB, minified files and files that are too deep.
- `discover.list_sources` (`discover.py:44-53`) does not filter by size.
- The path is `aftershock/analysis/diff.py`. The crash triggers only when such a file is edited or newly added after indexing, so it is narrower than "every run".

**3.11 Concurrency gaps between index, run, heal and drop (medium).**
- `api.py:248` drop checks only `_indexing`, and index (217-222) checks only `_indexing`. `_job_stream` (~461-466) checks only `_runs`. `_indexing` is read unlocked at 185 and 203.
- Overlap can cause partial or orphaned graph writes. It does not cause loss of source.

**3.12 Smaller correctness items (low).**
- `record_coverage` drops all COVERS edges even for a narrow pytest argument run (`pytest_run.py:210`), where `run_measured` already uses the scoped `drop_coverage_of` (`pytest_run.py:330`).
- A TS-only change yields a green run of 0 tests with exit_code 0. `run_selected` drops non-Python ids (`pytest_run.py:341-346`), `jobs.run_tests` has no nothing-ran guard, and the web page shows a pass chip (`tests/page.tsx:731`).
- `_run` retries writes (`graph.py:406-413`) while the RAN and SUSPECTS links use CREATE (`graph.py:290-295`), so edges can duplicate.
- Indexing silently truncates to the first 50,000 files alphabetically (`discover.py:53`).
- `_ask_api` checks the tool cap once per response (`heal.py:187`), so parallel tool_use blocks overshoot it. A capped response then yields empty text, which becomes `claude_error`.
- `heal.py:356` sends only the last 3000 chars of the log, and `pytest_run.py:139` reads the whole log into memory. The per-failure message from the plugin is unused.
- Heal's region mode and graph context use stale line spans from the last index (`heal.py:241-244, 282-283`). Region replacement applies only to files over 20,000 chars, and a misplaced region rarely survives strict-improvement.
- Runs over 5000 results re-verify a truncated set. Failed tests are ordered first (`graph.py:308`) and recorded failures are unioned in (`jobs.py:107`), so failing tests are not lost.
- Dead or duplicate code and doc drift:
  - `pytest_run._head` (224-226) duplicates `runs._commit` (`runs.py:56-60`).
  - `runs.record` retries the `idx_testrun` DDL on every call (`runs.py:98-104`).
  - D15 says re-index drops COVERS, but D19 and `pipeline.py:330-334` mark it stale.
- Heal's CLI backend runs the MCP server from a temp cwd, so cwd-relative `.env` settings are lost (`heal.py:146-148`, `config.py:25`). `sys.executable` is already used, so that part of the fix is a no-op.

**3.13 Credibility and scope limits.**
- HANDOFF.md:67-71 says everything is uncommitted on top of one commit. `git log` shows a single "Initial commit" (841b1ad) and `git status --short` lists 86 changed paths.
- HANDOFF says web `eslint` and `next build` were not re-run, and the Tests page was not opened in a browser (HANDOFF.md:34-35, :104).
- The loop is Python/pytest only. Heal is Python-only (README:357), JS has no runtime evidence, and no Go, Java or Rust repo has been evaluated (README:263-265). The README discloses all of this.
- Impact accuracy is modest and honestly reported:
  - All-tier F1 is .096 to .191.
  - Top-5 beats the directory baseline on 4 of 5 repos.
  - K was chosen on click and httpx.
  - Held-out flask loses to the baseline.
  - The co-change proxy penalises correct test edges (README:134-137).
- Model IDs and a dated beta header are hardcoded. `heal.py:48` has `FIX_MODEL` hardcoded. `agent.py:~91` sets `betas=['server-side-fallback-2026-07-01']`. Ask takes its model from settings. The model used is not stored on the TestRun, so benchmark reproducibility is weaker.

## 4. Engineering gaps

- No crash-safe edit loop. There is no worktree, temp copy or startup recovery, and no diff preview before the write (3.1, 3.3).
- No regression gate beyond the selected set, and no flake check on formerly failing tests (3.2).
- No history-aware ranking. TestRun data is recorded but never read by selection or ordering (3.7).
- Fault localization is function-level only. Line coverage is aggregated away in `_map_coverage` (`pytest_run.py:146-171`) (3.6).
- No SWE-bench-style or ablation evidence for repair quality (3.4).
- No tool-selection evaluation and no stored MCP call sequences (3.8).
- No per-repo lock covering index, run, heal and drop (3.11).
- The Docker stack cannot demonstrate the loop by design. D18 and `api.py:4-11` require a loopback peer and Host, and DECISIONS.md:203-204 says compose cannot run tests. This is a deliberate security choice, but it leaves the central demo path gated.
- The loop has no streamed visual of the subgraph (failing test to suspect chain) beside the fix, and no per-test "why selected" view.

## 5. Security

The audit was read-only, and every finding comes from reading code. Run and heal are off by default. When enabled they require a loopback peer and Host. They are absent from the HTTP MCP mount and from the Ask agent, and `tests/test_actions.py:79` covers this. The fixer gets no built-in tools and only read-only graph tools. The Cypher boundary is `GRAPH.RO_QUERY`. Repo registration is confined by `allowed_path`, clones are restricted to an https host allowlist, and the web proxy validates path segments.

**Confirmed or checked controls:**
- The `tools.diff_impact` rev validation blocks git option injection.
- FastAPI 0.143.2 rejects `text/plain` bodies with 422, so a cross-site POST cannot reach the run endpoints.
- The web password compare is already constant-time (`middleware.ts:12-16`). The password is read at runtime from `process.env.AFTERSHOCK_WEB_PASSWORD`, not inlined at build time.
- The Ask agent cannot reach `run_tests` or `heal` today. They register only through `register_actions` on stdio with `allow_run` (`mcp_server.py:240-243`).
- A model-supplied `repo` argument raises TypeError. On the API path `agent.tool_specs` pops `repo` from the schema (`agent.py:60-66`), `ask()` falls back to the router, and `heal.py:196` catches it.

**Findings, ordered by verified severity:**
- **Medium. Proxy Host/Origin gate covers only run, heal, `/runtime` and provider writes** (`web/app/api/v1/[...path]/route.ts:39-56`).
  - Everything else is forwarded with the API key injected: Cypher, Ask, index, clone and graph reads including commit author emails.
  - A DNS-rebinding page that rebinds its name to `127.0.0.1:3101` becomes same-origin with the proxy. Run and heal stay blocked because the Host is not loopback.
  - It requires rebinding to work, no `AFTERSHOCK_WEB_PASSWORD`, and the stack running.
  - The CSRF half is refuted (JSON content type needed, no CORS headers).
  - Data and quota leakage only. It is not a code-execution path.
- **Medium. Test subprocess inherits the full environment** (`pytest_run.py:102`).
  - Only `AFTERSHOCK_*` and `COVERAGE_*` are stripped, so `ANTHROPIC_API_KEY` (`config.py:49-50`) and `FALKORDB_URL` are readable by repo tests and conftest.
  - The judge rated it medium. The security reviewer rated it low, because running a repo's tests is arbitrary code execution by design (D18, README:319-325) and the code can read `~/.ssh` and `~/.claude` regardless of env.
  - It is opt-in, loopback-only and absent from MCP.
  - `mutate.py:104` already uses a minimal env, so the run path is the weaker one.
  - The claim that this combines into remote code execution with the proxy findings was not upheld.
- **Low. Proxy gate fails open on no-Origin requests, and the web password is optional and unthrottled.**
  - A non-browser client can set any Host anyway, so the Host check was never meant to stop that case.
  - Remote exposure needs the web server reachable from outside, no password, `ALLOW_RUN=1`, and a tunnel that rewrites Host.
  - Compose says to set `WEB_BIND=0.0.0.0` only with a password (`docker-compose.yml:53`).
  - There is no rate limit, and an unset password means no auth (`middleware.ts:18`).
- **Low. Heal writes with no realpath or symlink containment** (`heal.py:367-418`).
  - `suspect['file']` is not resolved against the repo root, and graph text enters the prompt.
  - The premise is weak, since heal already ran the repo's tests first.
  - On the CLI path the stdio MCP server exposes `repo`, and `GRAPH_TOOLS` includes cypher (`heal.py:55`). A prompt-injected fixer could read another indexed repo's graph into the fix text. That needs an untrusted repo, `heal --apply`, and a second sensitive repo indexed.
- **Low. A cwd `.env` can enable `ALLOW_RUN` for the stdio MCP server** (`config.py:25`, `mcp_server.py:240-243`). The operator must already have configured the stdio server, the client must launch it in a repo that ships a `.env`, and `.env` is normally gitignored.
- **Low. git runs against untrusted local `.git` directories without hardening** (`ingest/history.py:43-55`, `analysis/diff.py:79`, `ingest/discover.py:31`, `analysis/evaluate.py:73`).
  - A crafted `.git/config` such as `core.fsmonitor` is a real class of problem.
  - Aftershock-cloned repos get a locally generated config, and `tools.py:131-139` already sets hooksPath.
  - Exposure is limited to a local directory under `AFTERSHOCK_REPO_ROOTS` that arrived with its `.git` already crafted.
- **Low. Cypher LIMIT could be swallowed by a trailing `//` comment** (`graph.py:455-457`). It was not executed. `graph.py:460` applies a Python slice `ro(...)[:cap]` and the query has a 15s timeout, so the response is always capped. Writes remain impossible.
- **Low. The loopback check includes the strings `localhost` and `testclient`** (`api.py:60, 70-74`), and `cli.py:480-484` runs uvicorn with `proxy_headers=True`.
  - A client cannot inject a loopback `X-Forwarded-For` through a standard proxy that appends or overwrites the header.
  - This is hygiene only.
- **Low. Ask agent filter is an annotation denylist** (`agent.py:60`). It is a latent regression risk only, because every tool is registered through `_tool()` which defaults to RO (`mcp_server.py:65-76`).
- **Low. Defaults.**
  - The default FalkorDB password `aftershock` is documented in `.env.example` and compose binds loopback.
  - Pytest test ids are passed without a `--` separator (`pytest_run.py:107-117`).
  - Library directories are not re-checked with `allowed_path` at use.
  - No real secrets were found.

## 6. Testing

Real result: 174 passed in 31.58s, exit 0, no skips, with FalkorDB on 6390 up. Tests run a real subprocess pytest, a hand-computed mini fixture pins graph outputs, testlab holds known-answer scenarios, and fixture graphs are isolated under `pytest-*` names.

**Gaps:**
- **High. No test for restore when the verify run raises.** Nothing makes `run()` raise between write and revert (timeout, exit 3/4).
- **High (verification status: unverified). Heal outcome branches and D16/D21 rules.** The reported gap is that these have little coverage:
  - `write_rejected` (`heal.py:370, 377`).
  - `claude_error` / unchanged (`heal.py:399`).
  - "no further suspects" (`heal.py:362`).
  - The strict-subset rule (`heal.py:416`).
  - Widen with `apply=True` (`tests/test_heal.py:132-143` exercises widen only with `apply=False`).
  - Only one revert case exists (`tests/test_heal.py:98-114`).
  - The reviewer's check for this finding was marked unverified.
- **Medium. Heal revert byte-exactness is untested.** The fixture is LF and ASCII.
- **Medium. The loopback gate is tested only through an allowlisted peer.** `tests/test_run.py:41-46` sends only a bad Host. No test supplies a non-loopback client address. The claim that the `testclient` allowance widens the production surface is not reachable.
- **Medium. Runner timeout, kill, drain and exit-code paths are untested.**
  - Timeout, exit 3/4 mapping, collection error, xfail, setup error and the no-coverage fallback have no tests.
  - Cancel is covered by `tests/test_run.py:133-141`, and it exercises the SIGTERM branch of `_kill`.
  - The orphan/SIGKILL branch is untested.
- **Medium. Whole modules have no direct tests:**
  - `ingest/history.mine`.
  - `analysis/evaluate.py` (Score, cases, evaluate).
  - `architecture` tarjan and cycles.
  - `graph.list_repos`, `lab_repos` and `set_lab` (D13).
  - Full-text lookup and `fit_weights`.
  - Every pipeline test indexes with `with_history=False`.
- **Medium. Web proxy gate has no tests and jest is not in CI.** `route.ts:15-43` is untested. `.github/workflows/ci.yml:44-46` runs only `npm ci`, lint and build. `package.json` defines `test: jest`. `web/` is being rebuilt, so this is a snapshot.
- **Low. The 409 test is dead.** `tests/test_run.py:63-74` never indexes `busy-repo`, so `T._graph(repo)` raises NotFound first and the `if r.status_code == 409` assertion never runs. The 429/`MAX_RUNS` and HTTP-level disconnect wiring are untested. SSE success is tested (`test_runs.py:218-233`).
- **Low. Culprit scoring has no hand-computed exact Ochiai.**
  - Nothing touches `CHANGED_BOOST`, depth 12 or `unexplained`, and the stale factor is checked only as a flag.
  - Scores are not only bounded. Exact `== 1.0` is asserted (`test_runtime.py:125`, `test_actions.py:48`, `test_runs.py:294`).
  - Cited line numbers in the original finding were wrong.
- **Low. Fixer backend failure paths are untested.** These are CLI OSError, timeout, non-zero exit and empty result (`heal.py:150-169`), plus `anthropic.APIError` (`heal.py:184-185`) and a negative `call_tool` test (`agent.py:70-74`). The read-only tool restriction is tested (`test_actions.py:125, 148-153`).
- **Low. A conditional assertion in testlab.** `tests/test_testlab.py:58` wraps assertions in `if res["runtime"]:`. It skips only when no interpreter is found. The circular-recall claim is not upheld, since `test_runtime.py:130-143` takes ground truth from really running each mutant.
- **Low. Fixture isolation.**
  - Graph names are fixed `pytest-*`, so concurrent runs against one FalkorDB would collide.
  - `needs_graph` skips silently when the graph is down.
  - CI provides a FalkorDB service (`ci.yml:15-23`) and no xdist is configured, so this is hypothetical today.
- **Low. Flaky-classification gap.** A mixed pass/fail RETRY_OF classification (`tools.py:460`) has no direct test. KEEP trimming is tested (`test_runs.py:159-166`).

## 7. UX and performance requirements for the UI rebuild

Nothing was measured. There was no Lighthouse, CrUX or trace, and `web/.next` is a dev build. Each item below is a requirement the rebuild must meet, not a measured defect. Cited web line numbers were stale in several findings, so re-verify against the rebuilt code.

**Budgets and measurement**
- Define budgets up front for route JS, LCP, INP and API p95 per endpoint, and wire them to CI.
- CI should run `next build` with `@next/bundle-analyzer`, Lighthouse CI against a seeded large repo, and an API latency check.
- `/stats` gives per-query-name p50/p95 (`graph.py:356-361`), not per-endpoint latency, so per-endpoint p95 needs new instrumentation.
- Add a large-graph fixture to exercise canvas and list limits.

**Data fetching**
- Fetch first-paint data (repos, overview header) in server components or a route-level prefetch.
- Replace the effect-only `useQuery` (`web/lib/hooks.ts`) with one shared cache (SWR, TanStack Query, or React `use()`) with key-based dedupe and stale-while-revalidate.
- Call `/repos` once from a shared provider. It is currently fetched in `top-bar.tsx:52`, `app/page.tsx:156` and elsewhere. Overview is fetched under the same key by `r/[repo]/page.tsx:93` and `explore/page.tsx:240`.
- Render sections progressively with Suspense instead of gating the page on one spinner.
- The queries on a page fire in parallel, so the "waterfall" is overstated. The duplicates are real but cheap on a loopback API.

**Backend latency the UI waits on**
- Overview runs about 9-10 serial graph queries, with unbounded `import_edges` and Tarjan in Python, and has no cache (`architecture.py:167-182`, `graph.py:156`, `tools.py:301`).
  - Cache per (repo, indexed_at/commit), invalidated on reindex.
  - Communities and PageRank are already precomputed at index time, so only cycles are computed per request.
  - Split the endpoint so the UI can paint progressively.
- Symbol search is a full scan, `toLower CONTAINS ... LIMIT 400` plus a Python sort (`graph.py:163-167`, `lookup.py:37-43`).
  - Add a prefix or trie index and a smaller palette limit.
  - Add a minimum query length and an AbortController. A full-text index already exists for text search.
  - It is one request per keystroke after the 150ms debounce, not two.
  - `search_files` is LIMIT 50 and the response is sliced to 12 in the palette.
- File and symbol detail run 6 and 3 serial queries (`tools.py:351-360, 323-348`). Run them concurrently or as separate parallel UI calls.
- `_graph()` calls `GRAPH.LIST` per request (`tools.py:42-48`), and `list_repos` runs one query per repo serially (`tools.py:71-80`). Cache with a short TTL.

**Graph canvas** (`graph-canvas.tsx`, `layout.ts`)
- Run ELK in a Web Worker. `layout.ts:25-26` uses the bundled build on the main thread, and `elk.bundled.js` is 1,609,707 bytes. ELK is already lazy-loaded.
- Pass previous positions. `graph-canvas.tsx:92` calls `layout(..., {}, direction)`, so `keepPlaced` is dead.
- Stop rebuilding `data` for every node on selection (`graph-canvas.tsx:103-109`), which defeats `memo(Card)`.
- Enforce a hard node and edge cap everywhere. Only the subsystems graph (`page.tsx:25-45`) is truly uncapped. The impact graph is bounded by 60 chains times `max_depth`.
- Replace the infinite `epi-glow` drop-shadow filter animation (`globals.css:588-596`). It applies only to emphasis nodes.

**Streaming UX**
- Stream the final Ask turn. `agent.py:88` uses non-streaming `beta.messages.create` and emits the answer once (`agent.py:105, 122, 245`). Tool steps already stream live.
- In `ask/page.tsx`, scroll only when pinned to the bottom, and use `behavior:auto` while streaming. The current smooth scroll fires on every turns change.
- Pause the 20s health poll when the tab is hidden (`top-bar.tsx:30`).

**Lists and bundles**
- Virtualize lists that can exceed about 100 rows. These are the Cypher table (`cypher/page.tsx:147-155`, capped server-side at 5000 rows by `max_rows`) and `NeighborList` (up to 400 rows). The tests list renders all rows. Impact lists are already paginated. The tests fold is O(N) per 250ms flush, and the 250ms batching should stay.
- Load `GraphCanvas` through `next/dynamic`. It is statically imported at `r/[repo]/page.tsx:7`, `explore/page.tsx:8` and `impact-view.tsx:8`.
- Import the xyflow CSS once. It is imported in both `globals.css:4` and `graph-canvas.tsx:3`.
- `react-markdown` is loaded only by the Ask route, so it is not a cross-page cost.
- Trim Instrument Serif (including italic) if unused. `layout.ts` now declares four families, and the serif is not on the LCP heading.
- Remove dead CSS: the data-reveal and `rv-w` rules (`globals.css:629-670`) and the unused `.bg-noise` and `.noise-overlay` classes.
- Avoid `backdrop-blur-xl` on the sticky header (`top-bar.tsx:168, 205`) and the `blur-3xl` blob (`page.tsx:164`).

**Caching and transport**
- The proxy `PASS_RES` forwards only content-type, cache-control, x-accel-buffering and retry-after, and `api.ts` uses `no-store`.
- Validator passthrough needs backend work first, because FastAPI emits no ETag and nothing in `api.py` generates one.
- Add GZip at the API if it is ever exposed directly.

**Product UX the code review surfaced**
- Add a diff preview before heal writes to the working tree, plus a visual of the failing-test-to-suspect subgraph beside the fix.
- Add a per-test "why selected" view.
- Provide a one-command local demo path, since Docker cannot run the loop.
- Surface the "nothing ran" case instead of showing a green pass chip.

## 8. Prioritised fix plan

### P0: correctness and submission risk

1. **Make heal crash-safe and byte-exact** (`aftershock/analysis/heal.py:373, 404-423`, `api.py:~436-452`).
   - Snapshot `original = path.read_bytes()`. Write `new_text` through `.encode()`, preserving the newline style, and revert with `write_bytes(original)`. Refuse files that are not valid UTF-8.
   - Wrap write then verify in try/except BaseException with restore in `finally`, unless the round was explicitly accepted.
   - Detect and restore a leftover snapshot at heal start. Better: do each round in `git worktree add` or a temp copy.
   - Add tests that monkeypatch the verify run to raise (timeout and exit 4) and assert the bytes are restored. Add CRLF and invalid-UTF-8 fixtures asserting `read_bytes()` before equals after.
   - Fix the `api.py` docstring if any path remains.
2. **Validate the verify step and the fixer output** (`heal.py:122-124, 404-415`, `_aftershock_pytest.py`, `pytest_run.py:141-142`).
   - Require every requested id to have a row and exit code in (0, 1). Otherwise revert and fail the round.
   - Add `pytest_collectreport` rows with outcome `error` and count them as failing.
   - Compile or tree-sitter-parse `new_text` before writing it.
   - Ask for the replacement in a delimiter that cannot occur, or take the last closing fence.
3. **Add a regression gate** (`heal.py:405`, `tools.wider_tests` at `tools.py:46`). After the selected tests pass, run the wider set or the full suite and revert if any previously passing test fails. Re-run each formerly failing test twice to catch flakes. This matches SapFix practice of checking candidates before landing them.
4. **Commit, tag and push.** HANDOFF.md:67-71 says the work is uncommitted, and 86 paths changed. Run web lint and `next build`, open the Tests and Culprit pages in a browser, and fix what breaks.
5. **Fix the diff crash on skipped files** (`analysis/diff.py:139`). Use `next((d for ...), None)`, skip or report the path when `facts.error` is set, and apply the same size and minified guard as indexing.

### P1: integrity, security hardening and evidence

6. **Write the index marker last** (`ingest/pipeline.py:307-355`). Write `sha` and `out_digest` after symbols and edges succeed, or use an `indexing=true` flag treated as changed. Add a test that raises inside `link_calls` and re-runs.
7. **Allow-list the test subprocess environment** (`runtime/pytest_run.py:102`).
   - Use an allow-list as `mutate.py:104` does, and strip `ANTHROPIC_*`, `FALKORDB_*`, `*_API_KEY`, `TOKEN` and `SECRET`.
   - Preferably run under bubblewrap, firejail or a container with no network and a bounded filesystem.
   - Add a per-repo trust flag, and warn or refuse for cloned repos.
8. **Close the proxy gap** (`web/app/api/v1/[...path]/route.ts:39-56`).
   - Apply Host and Origin checks, plus a per-process token header, to all non-GET routes and sensitive GETs. Add a Host allowlist returning 421.
   - Fail closed: require the web password or API key when `ALLOW_RUN=1`, and reject run/heal with no Origin or `Sec-Fetch-Site: same-origin`.
   - Refuse a non-loopback web bind without a password.
   - Add route tests for Host `evil.com`, loopback Host with foreign Origin, malformed Origin and `..` segments. Add `npm test` to the CI web job (`.github/workflows/ci.yml:44-46`).
9. **Fix one-line function coverage and culprit evidence symmetry** (`pytest_run.py:265-268`, `culprit.py:135-181`).
   - Include single-line spans, from `line` to `end_line`, in `_map_coverage`.
   - Fall back to the static passing count for unmeasurable symbols, and mark them `unmeasured`.
   - Use the same evidence type per test on both sides. Apply the deep chain only for display, or document the asymmetry.
   - Add a hand-computed exact-Ochiai test pinning the stale factor, `CHANGED_BOOST` and the depth boundary.
10. **Add one per-repo busy lock** (`api.py:185-222, 248, 445-481`) shared by index, run, heal and drop, returning 409 when busy. Fix the dead 409 test by indexing `busy-repo`, and add a 429 test.
11. **Run an ablation for repair quality** (`scripts/heal_bench.py`).
    - Compare no graph, chain only, and chain plus tools, on QuixBugs (already in testlab) and on mutation-generated multi-line bugs (HANDOFF item 3).
    - Use repos newer than the model's training data. Report fix rate, rounds and cost.
    - Pin the model in published runs, and consider a small SWE-bench Verified subset for comparability.
12. **Move model IDs and betas to settings and record the model on each TestRun and heal round** (`heal.py:48`, `agent.py:~91`, `runs.py`).
13. **Pass cancel into heal and add Ask cancellation and limits** (`api.py:451-452, 626-657`, `jobs.heal_run`, `agent.py`). Add a cooperative cancel check between agent turns and tool calls, and a semaphore for concurrent asks.
14. **Cypher guard hygiene** (`graph.py:455-457`). Strip comments or add a newline before the appended LIMIT. The Python slice already caps the response.

### P2: depth, breadth and polish

15. **Line-level SBFL and signal fusion** (`culprit.py`, `pytest_run.py:146-171`). Keep line coverage and run Ochiai or DStar for the top function candidates. Fuse with git recency, churn and co-change by rank fusion, and validate on held-out repos with the `scripts/fit_weights.py` pattern.
16. **History-aware test selection** (`tools.py` ~228-234, `runs.py`). Rank by recent failure rate, duration and co-failure from TestRun data. Down-weight harness-reached tests (HANDOFF item 8), add suite metadata (tags or markers) to libraries, and use testmon's approach to dedupe measured edges.
17. **Tool-selection evaluation** (`tools.py:446-473`, `mcp_server.py`). Log MCP call sequences in the graph and add a task, expected-chain, observed-chain eval. Then replace the if-chain with a ranked suggester that uses run history, and compare the two.
18. **Language breadth.** Add vitest per-file V8 coverage via c8 into the same COVERS edges (HANDOFF item 5). Run one real Go or Java repo end to end before claiming those languages, and use JaCoCo per-test coverage for Java.
19. **Impact accuracy.** Use mutation-based ground truth as the primary metric and co-change as secondary. Evaluate on more held-out repos, and try SCIP indexers (scip-python, scip-typescript) as a precise edge source to lift the 50-70% resolution rates.
20. **Git and heal hardening.**
    - Run git with `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.ext.allow=never -c diff.external= --no-optional-locks`, `GIT_CONFIG_NOSYSTEM=1`, a minimal env, `--no-ext-diff` and `--no-textconv`.
    - In heal, `resolve()` the target and assert it is under the repo root and not a symlink. Drop `cypher` from the fixer allowlist and pin `repo` server-side for the CLI path.
    - Read `.env` from a fixed location, not cwd (`config.py:25`).
21. **Smaller correctness and doc fixes.**
    - Scope `drop_coverage` to the recorded tests and write new edges before deleting old ones (`pytest_run.py:210`).
    - Return an explicit "no runnable tests" outcome for non-Python selections (`pytest_run.py:341-346`).
    - Use MERGE for RAN and SUSPECTS or retry only reads (`graph.py:290-295, 406-413`).
    - Report `MAX_FILES` truncation (`discover.py:53`).
    - On the final `_ask_api` turn, send no tools or `tool_choice` none (`heal.py:180-199`).
    - Re-parse the suspect file at heal start for spans and compare Symbol.digest (`heal.py:241-283`).
    - Build the prompt failure context from recorded per-failure messages filtered to suspect-reaching tests, and read only a seek-based tail of the log (`pytest_run.py:139`).
    - Share one commit helper, create the `idx_testrun` index once in `ensure_schema`, and update D15 to match D19.
    - Use a per-file or sqlite parse cache with a unique temp name (`pipeline.py:119-124`).
    - Pass a `--` separator before pytest ids and re-check library paths with `allowed_path` at use.
22. **Test-suite gaps.** Add table-driven heal tests with a stub fixer (fixes A but breaks B, fixes nothing, fixes all, fixer raises, path outside repo, no suspects left, widen with `apply=True`). Add tests for the runner timeout, orphan-kill, collection-error, xfail and setup-error paths, and for `mine()`, `Score.as_dict`, tarjan and `set_lab`. Make the testlab runtime assertion a hard assert. Add per-session graph name suffixes, and fail instead of skip when `CI` is set and the graph is down.
23. **Rebuild-time UI work.** Apply the Section 7 requirements: shared cache, progressive overview, ELK in a worker, virtualized lists, dynamic imports, and trimmed fonts and blur effects.