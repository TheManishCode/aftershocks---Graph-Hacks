# Security

Aftershock reads code, stores a graph of it, and on request **runs** it: test suites, linters, installs, and a fix
loop that edits files. Its security model is mostly about who is allowed to trigger the running part.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting instead:
**[Security → Report a vulnerability](https://github.com/TheManishCode/aftershocks---Graph-Hacks/security/advisories/new)**.

Include what you did, what happened, and the commit you tested (`git rev-parse --short HEAD`). You'll get an
acknowledgement within a few days. Fixes are released on `main` and credited in the advisory and in
[`CONTRIBUTORS.md`](CONTRIBUTORS.md) unless you'd rather stay anonymous.

Only the latest `main` is supported.

## Trust model

| Caller | Trusted to | Not trusted to |
|---|---|---|
| CLI user | Everything, including running and editing any repo they point it at | — |
| API client with the key | Read the graph, index paths under `AFTERSHOCK_REPO_ROOTS`, clone allow-listed `https` URLs | Run code, unless the operator gate passes or the repo is a showcase repo |
| Anonymous visitor (no key set, or via the web proxy) | Read; run tests and scripts on **showcase repos only** | Index, delete, attach libraries, change model keys, run anything else |
| MCP client over stdio | Read-only tools; test runs only if the server was launched with `AFTERSHOCK_ALLOW_RUN=1` | — |
| MCP client over HTTP (`/mcp`) | Read-only tools behind the API key | Any execution |

### The run gate

Anything that executes the indexed repository (`coverage`, `run`, `mutate`, `heal`, scripts of kind `command`,
setup and installs) is reachable from the API only when **both** hold:

- the server was started with `AFTERSHOCK_ALLOW_RUN=1`, and
- the request comes from loopback and was not forwarded by the web proxy (which marks every non-local visitor with
  `X-Aftershock-Remote`; the API can only lose access from that header, never gain it).

**Showcase repos** (`AFTERSHOCK_SHOWCASE_REPOS`) are the one exception, for public demos: any visitor may run tests,
scripts and setup on those repos, one public run at a time across the server, under
`AFTERSHOCK_PUBLIC_RUN_TIMEOUT`. A public *Fix with AI* run is capped at 2 rounds and restores every file it wrote
when it ends. Nobody but the operator can re-index, delete or extend a showcase repo. Only name repos you would be
happy for a stranger to execute.

`heal --apply` from the CLI writes to the repo's own files and reverts any round that doesn't reduce failures.
Run the execution features only on code you trust, never on a repo cloned from a URL someone else gave you.

## What is enforced

- `AFTERSHOCK_API_KEY` guards every `/api/v1` route except `/health`, plus `/mcp`, and is compared in constant time.
  Without a key, the API answers only loopback hosts and `AFTERSHOCK_ALLOWED_HOSTS` (a DNS-rebinding guard).
- `/mcp` has DNS-rebinding protection; public hostnames go in `AFTERSHOCK_ALLOWED_HOSTS`.
- The API indexes only paths under `AFTERSHOCK_REPO_ROOTS` and clones only `https` URLs from
  `AFTERSHOCK_ALLOWED_CLONE_HOSTS`, with no credentials in the URL. Errors do not echo server paths.
- `/cypher` accepts read-only queries only. Write clauses, mutating procedures and unbounded variable-length paths
  are rejected, and queries run with `GRAPH.RO_QUERY` under the configured timeout.
- Installs come only from fixed recipes in `aftershock/runtime/setup.py`, never from a name the caller typed. npm
  installs use `--ignore-scripts`.
- `check` and `graph` scripts only read. They do not follow symlinks out of the checkout, and `sec.secrets` masks
  what it finds.
- Model keys are read from the environment, or stored by the UI in `<cache_dir>/providers.json` with mode `0600` in
  a `0700` directory. No route returns a key; status shows only its last four characters. Keys are never logged and
  are sent only to the provider's own base URL.
- FalkorDB is bound to `127.0.0.1` in the bundled `docker-compose.yml` and needs a password.

## Deploying publicly

- Set `AFTERSHOCK_API_KEY`. If the UI shouldn't be open to everyone, set `AFTERSHOCK_WEB_PASSWORD` or put it
  behind your own auth.
- **Never** set `AFTERSHOCK_ALLOW_RUN=1` on a host the public can reach. Use showcase repos instead.
- Keep FalkorDB off the network.
- Set `AFTERSHOCK_REPO_ROOTS` to the narrowest directory that works.

## What has not been done

There has been no external security review or penetration test. The controls above are covered by the test suite
(see `tests/test_d29.py` and the API tests) but have only been reviewed by the people who wrote them.
