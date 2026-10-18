"""HTTP API (`/api/v1`) + server-sent events + the MCP endpoint at `/mcp`.

Security model:
  * AFTERSHOCK_API_KEY set  -> every route except /health requires `Authorization: Bearer <key>` (constant-time check).
    The web UI never ships the key to the browser: its Next.js route handler proxies and adds the header server-side.
  * Local indexing is confined to AFTERSHOCK_REPO_ROOTS; remote indexing accepts only https URLs on allowed hosts,
    cloned shallow with hooks disabled. Repository code is parsed, never executed -- except by the test runner
    below.
  * Running a repo's tests (D18) is off unless AFTERSHOCK_ALLOW_RUN is set, and then only for a loopback peer
    with a loopback Host header (no DNS rebinding), one run per repo. It is not exposed over MCP.
  * Without an API key, only loopback Hosts and AFTERSHOCK_ALLOWED_HOSTS are served (DNS-rebinding guard).
  * Cypher from callers goes through the read-only guard and GRAPH.RO_QUERY.
  * Errors never carry stack traces; unexpected failures are logged server-side and returned as a generic 500.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import tools as T
from .config import get_settings
from .graph import NAME_RE, GraphUnavailable, get_store, query_stats

log = logging.getLogger("aftershock.api")
VERSION = "0.1.0"

_jobs = ThreadPoolExecutor(max_workers=2, thread_name_prefix="index")
_indexing: dict[str, float] = {}
_lock = threading.Lock()


# ---- auth ------------------------------------------------------------------------------------------------------------


def require_key(request: Request) -> None:
    key = get_settings().api_key
    if not key:
        return
    got = request.headers.get("authorization", "")
    token = got[7:] if got.lower().startswith("bearer ") else ""
    if not hmac.compare_digest(token.encode(), key.encode()):
        raise HTTPException(401, "missing or invalid API key", headers={"WWW-Authenticate": "Bearer"})


_LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}  # "testclient" is Starlette's TestClient peer


def _host_name(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("["):
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def _trusted_host(host: str) -> bool:
    """Loopback names, AFTERSHOCK_ALLOWED_HOSTS, and Starlette's TestClient default."""
    name = _host_name(host)
    return name in _LOOPBACK or name == "testserver" or name in {_host_name(h) for h in get_settings().allowed_host_list()}


class _MCPAuth:
    """ASGI guard in front of the mounted MCP app (FastAPI dependencies don't reach mounted sub-apps)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        key = get_settings().api_key
        if scope["type"] == "http" and key:
            headers = dict(scope.get("headers") or [])
            got = headers.get(b"authorization", b"").decode("latin-1")
            token = got[7:] if got.lower().startswith("bearer ") else ""
            if not hmac.compare_digest(token.encode(), key.encode()):
                await JSONResponse({"detail": "missing or invalid API key"}, 401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


# ---- app -------------------------------------------------------------------------------------------------------------


def _mcp_app():
    from .mcp_server import server

    s = get_settings()
    # DNS-rebinding guard: only Hosts we serve on. Localhost always; add the public host via AFTERSHOCK_ALLOWED_HOSTS.
    hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*", "127.0.0.1", "localhost", *s.allowed_host_list()]
    security = TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=hosts,
                                         allowed_origins=[s.web_origin, "http://localhost:*", "http://127.0.0.1:*"])
    return server, server.streamable_http_app(streamable_http_path="/", stateless_http=True, json_response=True,
                                              transport_security=security)


_mcp_server, _mcp_asgi = _mcp_app()


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with _mcp_server.session_manager.run():
        yield
    _jobs.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Aftershock", version=VERSION, lifespan=lifespan, docs_url="/api/docs",
              openapi_url="/api/openapi.json", redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=[get_settings().web_origin], allow_methods=["GET", "POST", "DELETE"],
                   allow_headers=["Authorization", "Content-Type"], max_age=600)
app.mount("/mcp", _MCPAuth(_mcp_asgi))


@app.middleware("http")
async def rebinding_guard(request: Request, call_next):
    """Without an API key, a web page could DNS-rebind its own name to 127.0.0.1 and drive the API from a browser.
    Only Hosts we serve on are accepted then; with a key set, the key already stops that."""
    if not get_settings().api_key and not _trusted_host(request.headers.get("host", "")):
        return JSONResponse({"detail": "unknown Host; add it to AFTERSHOCK_ALLOWED_HOSTS"}, 421)
    return await call_next(request)


@app.middleware("http")
async def headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    return resp


@app.exception_handler(T.NotFound)
async def _nf(_: Request, e: T.NotFound):
    return JSONResponse({"detail": str(e)}, 404)


@app.exception_handler(T.ToolError)
async def _bad(_: Request, e: T.ToolError):
    return JSONResponse({"detail": str(e)}, 400)


@app.exception_handler(GraphUnavailable)
async def _down(_: Request, e: GraphUnavailable):
    log.warning("graph unavailable: %s", e)
    return JSONResponse({"detail": "graph database unavailable"}, 503)


@app.exception_handler(Exception)
async def _boom(request: Request, e: Exception):
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "internal error"}, 500)


async def call(fn, *a, **kw) -> dict:
    return await run_in_threadpool(T.run, fn, *a, **kw)


v1 = "/api/v1"
auth = [Depends(require_key)]


# ---- system ----------------------------------------------------------------------------------------------------------


@app.get(f"{v1}/health")
async def health():
    ok = await run_in_threadpool(get_store().ping)
    return JSONResponse({"ok": ok, "version": VERSION, "falkordb": "up" if ok else "down"}, 200 if ok else 503)


@app.get(f"{v1}/stats", dependencies=auth)
async def stats():
    return {"queries": query_stats(), "indexing": sorted(_indexing)}


# ---- repos -----------------------------------------------------------------------------------------------------------


class IndexBody(BaseModel):
    path: str | None = Field(None, max_length=1024)
    url: str | None = Field(None, max_length=512)
    name: str | None = Field(None, max_length=64)
    full: bool = False
    history: bool = True


@app.get(f"{v1}/repos", dependencies=auth)
async def repos(lab: bool = False):
    out = await call(T.list_repos, lab)
    for r in out["repos"]:
        r["indexing"] = r["name"] in _indexing
    return out


@app.post(f"{v1}/repos", dependencies=auth, status_code=202)
async def index(body: IndexBody):
    if bool(body.path) == bool(body.url):
        raise T.ToolError("give exactly one of path or url")
    # Validate synchronously so bad input is a 400 now, not a failed background job later.
    if body.path:
        root = T.allowed_path(body.path)
        name = T.repo_name_for(root, body.name)
    else:
        name = T.check_url(body.url, body.name)
    with _lock:
        if name in _indexing:
            raise HTTPException(409, f"{name} is already being indexed")
        if len(_indexing) >= 2:
            raise HTTPException(429, "two index jobs are already running; try again shortly")
        _indexing[name] = time.time()
    store = get_store()
    after = await run_in_threadpool(store.event_cursor, name)  # earlier jobs' events stay replayable; skip them

    def job():
        def progress(stage: str, data: dict):
            store.publish(name, {"type": "progress", "stage": stage, **{k: v for k, v in data.items()
                                                                          if not isinstance(v, (list, dict))}})
        try:
            T.index(body.path, url=body.url, name=name, full=body.full, history=body.history, progress=progress)
        except T.ToolError as e:
            store.publish(name, {"type": "error", "detail": str(e)})
        except Exception:
            log.exception("index job %s failed", name)
            store.publish(name, {"type": "error", "detail": "indexing failed; see server log"})
        finally:
            with _lock:
                _indexing.pop(name, None)

    _jobs.submit(job)
    return {"repo": name, "status": "indexing", "after": after, "events": f"{v1}/repos/{name}/events?after={after}"}


@app.delete(f"{v1}/repos/{{repo}}", dependencies=auth)
async def drop(repo: str):
    T._graph(repo)
    if repo in _indexing:
        raise HTTPException(409, "repo is being indexed")
    await run_in_threadpool(get_store().drop_repo, repo)
    return {"dropped": repo}


@app.get(f"{v1}/repos/{{repo}}/events", dependencies=auth)
async def events(repo: str, request: Request, after: int = Query(0, ge=0)):
    """Server-sent events: index progress and completion. Resumable via Last-Event-ID or ?after=."""
    if not NAME_RE.match(repo):
        raise T.ToolError("invalid repo name")
    last = request.headers.get("last-event-id")
    cursor = int(last) if last and last.isdigit() else after
    store = get_store()

    async def stream():
        nonlocal cursor
        yield "retry: 3000\n\n"
        idle = 0
        while not await request.is_disconnected():
            evs = await run_in_threadpool(store.events, repo, cursor, 15000, 100)
            for ev in evs:
                cursor = ev["seq"]
                yield f"id: {cursor}\nevent: {ev.get('type', 'message')}\ndata: {json.dumps(ev, default=str)}\n\n"
            if not evs:
                idle += 1
                yield ": keepalive\n\n"
                if idle > 240:  # an hour of silence: let the client reconnect
                    break
            else:
                idle = 0

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---- reads -----------------------------------------------------------------------------------------------------------


@app.get(f"{v1}/repos/{{repo}}/overview", dependencies=auth)
async def overview(repo: str):
    return await call(T.overview, repo)


@app.get(f"{v1}/repos/{{repo}}/graph", dependencies=auth)
async def file_graph(repo: str, limit: int = Query(600, ge=1, le=3000)):
    return await call(T.file_graph, repo, limit)


@app.get(f"{v1}/repos/{{repo}}/hotspots", dependencies=auth)
async def hotspots(repo: str, limit: int = Query(20, ge=1, le=200)):
    return await call(T.hotspots, repo, limit)


@app.get(f"{v1}/repos/{{repo}}/dead-code", dependencies=auth)
async def dead_code(repo: str, limit: int = Query(100, ge=1, le=500)):
    return await call(T.dead_code, repo, limit)


@app.get(f"{v1}/repos/{{repo}}/search", dependencies=auth)
async def search(repo: str, q: str = Query(..., min_length=1, max_length=200), limit: int = Query(20, ge=1, le=100)):
    return await call(T.search, repo, q, limit)


@app.get(f"{v1}/repos/{{repo}}/symbol", dependencies=auth)
async def symbol(repo: str, ref: str = Query(..., min_length=1, max_length=500)):
    return await call(T.symbol, repo, ref)


@app.get(f"{v1}/repos/{{repo}}/file", dependencies=auth)
async def file(repo: str, path: str = Query(..., min_length=1, max_length=1024)):
    return await call(T.file_detail, repo, path)


# ---- analysis --------------------------------------------------------------------------------------------------------


class ImpactBody(BaseModel):
    targets: list[str] = Field(..., min_length=1, max_length=50)
    change: Literal["body", "signature", "rename", "delete"] = "body"
    depth: int | None = Field(None, ge=1, le=12)


class DiffBody(BaseModel):
    rev: str | None = Field(None, max_length=200)
    depth: int | None = Field(None, ge=1, le=12)
    link: str | None = Field(None, max_length=300, pattern=r"^https://")


class TestsBody(BaseModel):
    targets: list[str] | None = Field(None, max_length=50)
    rev: str | None = Field(None, max_length=200)


class PathBody(BaseModel):
    source: str = Field(..., min_length=1, max_length=500)
    target: str = Field(..., min_length=1, max_length=500)
    depth: int = Field(8, ge=1, le=10)


class CulpritBody(BaseModel):
    failing: list[str] = Field(..., min_length=1, max_length=200)
    changed: list[str] | None = Field(None, max_length=200)
    limit: int = Field(15, ge=1, le=50)


class OwnersBody(BaseModel):
    paths: list[str] = Field(..., min_length=1, max_length=400)


class CypherBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=4000)
    params: dict | None = None


class AskBody(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    #: provider-qualified model id, e.g. "openrouter:anthropic/claude-sonnet-5". Unset = the server's default.
    model: str | None = Field(None, max_length=200)
    effort: Literal["low", "medium", "high"] = "medium"


@app.post(f"{v1}/repos/{{repo}}/impact", dependencies=auth)
async def impact(repo: str, body: ImpactBody):
    return await call(T.impact_of, repo, body.targets, body.change, body.depth, markdown=True)


@app.post(f"{v1}/repos/{{repo}}/diff", dependencies=auth)
async def diff(repo: str, body: DiffBody):
    return await call(T.diff_impact, repo, body.rev, body.depth, body.link)


@app.post(f"{v1}/repos/{{repo}}/diff.md", dependencies=auth, response_class=PlainTextResponse)
async def diff_md(repo: str, body: DiffBody):
    return (await call(T.diff_impact, repo, body.rev, body.depth, body.link))["markdown"]


@app.post(f"{v1}/repos/{{repo}}/tests", dependencies=auth)
async def tests(repo: str, body: TestsBody):
    return await call(T.select_tests, repo, body.targets, body.rev)


# ---- running tests (D18) -----------------------------------------------------------------------------------------

_runs: dict[str, threading.Event] = {}
MAX_RUNS = 2


def run_refusal(request: Request) -> str | None:
    """Why this request may not run tests, or None. Executing repo code is only for the operator's own machine."""
    if not get_settings().allow_run:
        return "running tests is off; start the API with AFTERSHOCK_ALLOW_RUN=1 on your own machine"
    peer = request.client.host if request.client else ""
    if peer not in _LOOPBACK or _host_name(request.headers.get("host", "")) not in _LOOPBACK:
        return "running tests is only allowed from this machine (loopback client and Host)"
    return None


class RunBody(BaseModel):
    mode: Literal["diff", "targets", "all", "coverage"] = "diff"
    targets: list[str] | None = Field(None, max_length=50)
    rev: str | None = Field(None, max_length=200)
    timeout: int = Field(1800, ge=10, le=7200)


@app.get(f"{v1}/runtime", dependencies=auth)
async def runtime_status(request: Request):
    why = run_refusal(request)
    return {"enabled": why is None, "reason": why}


@app.post(f"{v1}/repos/{{repo}}/run/stream", dependencies=auth)
async def run_stream(repo: str, body: RunBody, request: Request):
    """Select and run the repo's tests, streaming each outcome as SSE (start, selected, test, progress, done).
    The run is recorded in the graph; `done` carries its `run_id`."""
    from .runtime import jobs

    return _job_stream(repo, request, "run", lambda emit, cancel: jobs.run_tests(
        repo, body.mode, emit, targets=body.targets, rev=body.rev, cancel=cancel, timeout=body.timeout))


class HealBody(BaseModel):
    max_rounds: int = Field(3, ge=1, le=5)
    timeout: int = Field(1800, ge=10, le=7200)


@app.post(f"{v1}/repos/{{repo}}/runs/{{run_id}}/heal/stream", dependencies=auth)
async def heal_stream(repo: str, run_id: str, body: HealBody, request: Request):
    """Take a recorded failing run to the fix loop (D25): re-run, ask Claude with the graph's culprit chain as
    context, re-verify, keep only a strict improvement. Streams start, run, ran, suspect, asking, round, done.
    It writes to the checkout, so it sits behind the same gate as running tests and is never exposed over MCP.
    Leaving the page does not stop it: an edit is always either kept after a re-run or reverted."""
    from .runtime import jobs

    # The run gate comes before the run-id shape check, so that a caller who is
    # not allowed to run anything gets the same 403 here as on `run/stream`
    # rather than a 400 that tells them their id was malformed. Validating
    # input ahead of authorisation is how a gate starts answering questions
    # for people who have not passed it.
    if why := run_refusal(request):
        raise HTTPException(403, why)
    if not T.RUN_ID.match(run_id):
        raise HTTPException(400, "invalid run id")
    return _job_stream(repo, request, "heal", lambda emit, cancel: jobs.heal_run(
        repo, run_id, emit, max_rounds=body.max_rounds, timeout=body.timeout), stop_on_leave=False)


def _claim(repo: str, cancel: threading.Event) -> tuple[int, str] | None:
    """Take the repo's run slot, or return (status, why not). Runs, heals and command scripts share it."""
    with _lock:
        if repo in _runs:
            return 409, f"a test run for {repo} is already in progress"
        if len(_runs) >= MAX_RUNS:
            return 429, "too many test runs in progress; try again shortly"
        _runs[repo] = cancel
    return None


def _release(repo: str) -> None:
    with _lock:
        _runs.pop(repo, None)


def _job_stream(repo: str, request: Request, what: str, job, *, stop_on_leave: bool = True,
                gated: bool = True) -> StreamingResponse:
    """Run `job(emit, cancel)` on a thread, one per repo, and stream what it emits as SSE, ending with `end`.
    `gated=False` is only for jobs that execute nothing (read-only scripts); they still take the slot."""
    if gated and (why := run_refusal(request)):
        raise HTTPException(403, why)
    T._graph(repo)
    cancel = threading.Event()
    if busy := _claim(repo, cancel):
        raise HTTPException(*busy, headers={"Retry-After": "10"} if busy[0] == 429 else None)
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def emit(kind: str, data: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, (kind, data))

    def work():
        try:
            emit("done", job(emit, cancel))
        except (T.ToolError, T.NotFound) as e:
            emit("error", {"detail": str(e)})
        except Exception as e:  # RuntimeErrorReport carries pytest's own output, which is the useful part
            from .runtime.pytest_run import RuntimeErrorReport

            if isinstance(e, RuntimeErrorReport):
                emit("error", {"detail": str(e)[-2000:]})
            else:
                log.exception("%s failed", what)
                emit("error", {"detail": f"the {what} failed; see server log"})
        finally:
            _release(repo)
            emit("end", {})

    threading.Thread(target=work, name=f"{what}-{repo}", daemon=True).start()

    async def stream():
        try:
            while True:
                try:
                    kind, data = await asyncio.wait_for(queue.get(), 15)
                except TimeoutError:
                    if await request.is_disconnected():
                        break
                    yield ": keep-alive\n\n"
                    continue
                yield f"event: {kind}\ndata: {json.dumps(data, default=str)}\n\n"
                if kind == "end":
                    break
                if kind == "test" and await request.is_disconnected():
                    break
        finally:
            if stop_on_leave:
                cancel.set()  # the browser left or the run ended: either way stop pytest

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get(f"{v1}/repos/{{repo}}/runs", dependencies=auth)
async def runs_list(repo: str, limit: int = Query(20, ge=1, le=50)):
    return await call(T.test_runs, repo, limit)


@app.get(f"{v1}/repos/{{repo}}/runs/{{run_id}}", dependencies=auth)
async def run_get(repo: str, run_id: str):
    return await call(T.run_detail, repo, run_id)


@app.get(f"{v1}/repos/{{repo}}/libraries", dependencies=auth)
async def libraries_list(repo: str):
    return await call(T.test_libraries, repo)


class LibraryBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=40)
    path: str = Field(..., min_length=1, max_length=1024)


@app.post(f"{v1}/repos/{{repo}}/libraries", dependencies=auth)
async def library_add(repo: str, body: LibraryBody):
    """Register an external pytest directory with the repo, so its tests are indexed, selected and run alongside.

    The path goes through the same `allowed_path` guard as indexing, so it cannot escape AFTERSHOCK_REPO_ROOTS.
    This records the directory; the repo must be re-indexed before its tests appear in the graph.
    """
    return await call(T.library_set, repo, body.name, body.path)


@app.delete(f"{v1}/repos/{{repo}}/libraries/{{name}}", dependencies=auth)
async def library_remove(repo: str, name: str):
    return await call(T.library_set, repo, name, None)


# ---- built-in script library (D28) --------------------------------------------------------------------------------


@app.get(f"{v1}/repos/{{repo}}/scripts", dependencies=auth)
async def scripts_list(repo: str, request: Request, q: str | None = Query(None, max_length=200),
                       category: str | None = Query(None, max_length=40),
                       ecosystem: str | None = Query(None, max_length=40), applicable: bool = False):
    """The catalog: every built-in script, whether it applies to this repo, and whether its tool is installed.
    `can_exec` says whether this caller may run `command` scripts (the same gate as running tests)."""
    from . import catalog

    out = await call(catalog.listing, repo, q=q, category=category, ecosystem=ecosystem, applicable_only=applicable)
    why = run_refusal(request)
    return {**out, "can_exec": why is None, "exec_reason": why}


class ScriptsBody(BaseModel):
    ids: list[str] = Field(..., min_length=1, max_length=60)
    timeout: int = Field(900, ge=10, le=7200)


@app.post(f"{v1}/repos/{{repo}}/scripts/run/stream", dependencies=auth)
async def scripts_run_stream(repo: str, body: ScriptsBody, request: Request):
    """Run picked scripts, streaming start, script, output, result, done. Read-only picks (`check`, `graph`) run
    for anyone with the API key; a pick that includes a `command` script needs the run gate (D18), like tests."""
    from . import catalog

    catalog.scripts()  # loads the registry
    # As on heal, the gate comes before id validation: a refused caller learns nothing from a bad id but a 403.
    if (why := run_refusal(request)) and any(
            (s := catalog.REGISTRY.get(i)) is None or s.executes for i in body.ids):
        raise HTTPException(403, why)
    try:
        chosen = catalog.pick(body.ids, allow_exec=True)
    except T.NotFound as e:
        raise HTTPException(404, str(e)) from e
    except T.ToolError as e:
        raise HTTPException(400, str(e)) from e
    executes = any(s.executes for s in chosen)
    return _job_stream(repo, request, "scripts", lambda emit, cancel: catalog.run(
        repo, [s.id for s in chosen], emit, allow_exec=executes, cancel=cancel, timeout=body.timeout),
        gated=executes)


def _script_runner(repo: str, request: Request):
    """For the Ask agent: run `command` scripts too, but only when this request passed the run gate. It shares the
    repo's run slot with the Tests page, so the agent cannot start a second run under a running one."""
    if run_refusal(request):
        return None
    from . import catalog

    def run_scripts(ids: list[str]) -> dict:
        cancel = threading.Event()
        if busy := _claim(repo, cancel):
            raise T.ToolError(busy[1])
        try:
            return catalog.brief(catalog.run(repo, ids, allow_exec=True, cancel=cancel, timeout=600))
        finally:
            _release(repo)

    return run_scripts


# ---- model providers (D27) ---------------------------------------------------------------------------------------


class ProviderKeyBody(BaseModel):
    key: str = Field(..., min_length=8, max_length=400)


@app.get(f"{v1}/providers", dependencies=auth)
async def providers_list():
    """Every provider, whether it has a key, and the last four characters of it. Never the key itself."""
    from . import providers

    return {"providers": providers.status(), "default": providers.default_model()}


@app.put(f"{v1}/providers/{{provider_id}}", dependencies=auth)
async def provider_set(provider_id: str, body: ProviderKeyBody, request: Request):
    """Store a provider key on the server, owner-only on disk.

    Writing a credential is an operator action, so it is held to the same bar as running tests: the request must
    come from the machine the API runs on. A shared deployment sets keys through the environment instead.
    """
    from . import providers

    if provider_id not in providers.BY_ID:
        raise HTTPException(404, "unknown provider")
    peer = request.client.host if request.client else ""
    if peer not in _LOOPBACK or _host_name(request.headers.get("host", "")) not in _LOOPBACK:
        raise HTTPException(403, "keys can only be set from the machine the API runs on; use the environment "
                                 "variable on a shared deployment")
    try:
        providers.set_key(provider_id, body.key)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return {"ok": True, "provider": provider_id}


@app.delete(f"{v1}/providers/{{provider_id}}", dependencies=auth)
async def provider_clear(provider_id: str, request: Request):
    from . import providers

    if provider_id not in providers.BY_ID:
        raise HTTPException(404, "unknown provider")
    peer = request.client.host if request.client else ""
    if peer not in _LOOPBACK or _host_name(request.headers.get("host", "")) not in _LOOPBACK:
        raise HTTPException(403, "keys can only be cleared from the machine the API runs on")
    providers.clear_key(provider_id)
    return {"ok": True, "provider": provider_id}


@app.post(f"{v1}/repos/{{repo}}/path", dependencies=auth)
async def path(repo: str, body: PathBody):
    return await call(T.explain_path, repo, body.source, body.target, body.depth)


@app.post(f"{v1}/repos/{{repo}}/culprit", dependencies=auth)
async def culprit(repo: str, body: CulpritBody):
    return await call(T.culprits, repo, body.failing, body.changed, body.limit)


@app.post(f"{v1}/repos/{{repo}}/owners", dependencies=auth)
async def owners(repo: str, body: OwnersBody):
    return await call(T.owners, repo, body.paths)


@app.post(f"{v1}/repos/{{repo}}/cypher", dependencies=auth)
async def cypher(repo: str, body: CypherBody):
    return await call(T.cypher, repo, body.query, body.params)


@app.post(f"{v1}/repos/{{repo}}/ask", dependencies=auth)
async def ask(repo: str, body: AskBody, request: Request):
    from . import agent

    T._graph(repo)
    return await run_in_threadpool(agent.ask, repo, body.question, None, model=body.model, effort=body.effort,
                                   run_scripts=_script_runner(repo, request))


@app.post(f"{v1}/repos/{{repo}}/ask/stream", dependencies=auth)
async def ask_stream(repo: str, body: AskBody, request: Request):
    """The agent's steps as SSE (plan, tool calls with receipts, answer) so the UI can show its work live."""
    from . import agent

    T._graph(repo)
    runs = _script_runner(repo, request)
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def emit(kind: str, data: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, (kind, data))

    async def runner():
        try:
            await run_in_threadpool(agent.ask, repo, body.question, emit, model=body.model, effort=body.effort,
                                    run_scripts=runs)
        except Exception:
            log.exception("ask failed")
            emit("error", {"detail": "the agent failed; see server log"})
        finally:
            emit("end", {})

    task = asyncio.create_task(runner())

    async def stream():
        try:
            while True:
                kind, data = await queue.get()
                yield f"event: {kind}\ndata: {json.dumps(data, default=str)}\n\n"
                if kind == "end" or await request.is_disconnected():
                    break
        finally:
            task.cancel()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
