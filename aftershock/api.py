"""HTTP API (`/api/v1`) + server-sent events + the MCP endpoint at `/mcp`.

Security model:
  * AFTERSHOCK_API_KEY set  -> every route except /health requires `Authorization: Bearer <key>` (constant-time check).
    The web UI never ships the key to the browser: its Next.js route handler proxies and adds the header server-side.
  * Local indexing is confined to AFTERSHOCK_REPO_ROOTS; remote indexing accepts only https URLs on allowed hosts,
    cloned shallow with hooks disabled. Repository code is parsed, never executed.
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
async def ask(repo: str, body: AskBody):
    from . import agent

    T._graph(repo)
    return await run_in_threadpool(agent.ask, repo, body.question)


@app.post(f"{v1}/repos/{{repo}}/ask/stream", dependencies=auth)
async def ask_stream(repo: str, body: AskBody, request: Request):
    """The agent's steps as SSE (plan, tool calls with receipts, answer) so the UI can show its work live."""
    from . import agent

    T._graph(repo)
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def emit(kind: str, data: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, (kind, data))

    async def runner():
        try:
            await run_in_threadpool(agent.ask, repo, body.question, emit)
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
