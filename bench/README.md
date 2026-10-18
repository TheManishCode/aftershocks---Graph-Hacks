# Benchmarks

Real open-source projects with real test suites, pinned by commit in `repos.toml`. They exist to measure Aftershock,
not to show users: index them as lab graphs (D13).

```bash
python scripts/bench_env.py click --index   # clone if missing, pin, build .aftershock/envs/click, index as lab
aftershock coverage click                   # whole suite once under per-test coverage → COVERS edges
aftershock mutate click --n 30 --seed 7     # real breakage: how much of it does each test selector catch?
aftershock eval click --commits 1500        # history replay: co-change precision / recall
aftershock run click wrap_text              # run only the tests a change reaches
```

| Repo | Status | Why it is here |
|---|---|---|
| click | ready | Small, fast (2263 tests in ~8s under coverage), heavy fixture use: the static-vs-runtime gap is large. |
| httpx | ready, needs port 8000 free | Async + sync clients, a local test server; checks selection across transports. |
| code-graph-rag | unsupported | Suite needs Memgraph and LLM keys. Static eval only. |
| zustand | unsupported | TypeScript/vitest; runtime evidence is Python-only for now. |

Adding a repo: give it a `[name]` table with `url`, `commit`, `path`, `python`, an `install` list of test-only deps
(`{root}` is the checkout), and `status`. Prefer projects whose tests need no network, database or secrets.
