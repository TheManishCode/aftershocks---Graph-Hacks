"""Repo-level views: subsystems (import communities), dependency cycles, hotspots, load-bearing code, dead code."""

from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from contextlib import suppress

from ..graph import RepoGraph

# Decorators that register a function with a framework: unreferenced in our graph, but very much alive.
LIVE_DECORATORS = ("route", "get", "post", "put", "patch", "delete", "fixture", "command", "task", "app.", "router.",
                   "pytest", "click", "validator", "property", "on_event", "listener", "handler", "tool", "Override",
                   "Test", "Bean", "export", "subscribe", "receiver", "event", "api_view", "action", "callback")
LIVE_NAMES = {"main", "setup", "teardown", "setUp", "tearDown", "run", "handle", "default", "__call__", "lifespan"}
# Files a framework or toolchain loads by convention, so "never imported" says nothing about them.
ENTRY_FILES = re.compile(
    r"(^|/)(page|layout|route|loading|error|not-found|template|default|middleware|instrumentation|global-error)"
    r"\.(tsx?|jsx?|mjs)$|(^|/)pages/|(^|/)(__main__|manage|setup|conftest|wsgi|asgi|main|app|server|cli)\.py$"
    r"|\.config\.(ts|js|mjs|cjs)$|(^|/)main\.go$|(^|/)(main|lib|build)\.rs$|(^|/)(index|main|server|app)\.(ts|js|mjs)$"
)


def tarjan(edges: dict[str, set[str]]) -> list[list[str]]:
    """Strongly connected components with more than one node (iterative, so deep import chains can't overflow)."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on: set[str] = set()
    stack: list[str] = []
    out: list[list[str]] = []
    counter = 0
    for root in sorted(edges):
        if root in index:
            continue
        work = [(root, iter(sorted(edges.get(root, ()))))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on.add(root)
        while work:
            v, it = work[-1]
            w = next(it, None)
            if w is not None:
                if w not in index:
                    index[w] = low[w] = counter
                    counter += 1
                    stack.append(w)
                    on.add(w)
                    work.append((w, iter(sorted(edges.get(w, ())))))
                elif w in on:
                    low[v] = min(low[v], index[w])
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                if len(comp) > 1:
                    out.append(sorted(comp))
    return sorted(out, key=lambda c: (-len(c), c))


def _cycle_example(comp: list[str], edges: dict[str, set[str]]) -> list[str]:
    """One concrete loop through the component, for display: a -> b -> ... -> a."""
    members = set(comp)
    start = comp[0]
    prev = {start: None}
    queue = [start]
    while queue:
        v = queue.pop(0)
        for w in sorted(edges.get(v, ())):
            if w == start:
                path = [v]
                while prev[path[-1]] is not None:
                    path.append(prev[path[-1]])
                return path[::-1] + [start]
            if w in members and w not in prev:
                prev[w] = v
                queue.append(w)
    return comp + [start]


def cycles(g: RepoGraph, limit: int = 20) -> list[dict]:
    edges: dict[str, set[str]] = defaultdict(set)
    for r in g.ro("import_edges"):
        edges[r["src"]].add(r["dst"])
    return [{"files": c, "size": len(c), "example": _cycle_example(c, edges)} for c in tarjan(edges)[:limit]]


_TEST_PATH = re.compile(r"(^|/)(tests?|__tests__|spec|testing)/|(^|/)test_[^/]*$|_test\.\w+$|\.(test|spec)\.\w+$")


def _name(files: list[str]) -> str:
    files = [f for f in files if not _TEST_PATH.search(f)] or files  # a group of code + its tests is named for the code
    """The directory most of the community lives in (two levels deep), e.g. `api/agents`."""
    common = os.path.commonpath(files) if len(files) > 1 else os.path.dirname(files[0])
    if common.count("/") >= 1:
        return common
    dirs: dict[str, int] = defaultdict(int)
    for f in files:
        d = "/".join(f.split("/")[:-1][:2]) or "(root)"
        dirs[d] += 1
    return max(sorted(dirs), key=lambda k: dirs[k])


def _hint(files: list[str]) -> str:
    """The two most telling file stems in a group (`persist, devtools`), skipping index/__init__ and test suffixes."""
    files = [f for f in files if not _TEST_PATH.search(f)] or files
    stems: list[str] = []
    for f in sorted(files, key=lambda x: (x.count("/"), x)):
        stem = os.path.basename(f).split(".")[0]
        if stem not in ("index", "__init__", "mod", "lib", "main") and stem not in stems:
            stems.append(stem)
    return ", ".join(stems[:2]) + (f" +{len(files) - 2}" if len(files) > 2 else "") if stems else f"{len(files)} files"


def subsystems(g: RepoGraph) -> dict:
    comms = g.ro("communities")
    base = [_name(c["files"]) for c in comms]
    clash = {n for n in base if base.count(n) > 1}
    nodes, seen = [], defaultdict(int)
    for c, name in zip(comms, base, strict=True):
        if name in clash:  # several groups in one directory: name each by its files, not by a counter
            name = f"{name} · {_hint(c['files'])}"
            seen[name] += 1
            if seen[name] > 1:
                name = f"{name} ({seen[name]})"
        nodes.append({"id": c["community"], "name": name, "size": c["size"], "files": sorted(c["files"])[:50]})
    names = {n["id"]: n["name"] for n in nodes}
    links = [{"src": e["src"], "dst": e["dst"], "weight": e["weight"]} for e in g.ro("community_edges")
             if e["src"] in names and e["dst"] in names]
    return {"subsystems": nodes, "links": links}


def _alive(r: dict) -> bool:
    decos = r.get("decorators") or []
    if any(any(k.lower() in d.lower() for k in LIVE_DECORATORS) for d in decos):
        return True
    name = r["name"]
    return name in LIVE_NAMES or (name.startswith("__") and name.endswith("__")) or name.startswith("test")


# Ambient declarations (`.d.ts`) and type-only exports are consumed by the type checker, not by calls or imports.
DECL_FILE = re.compile(r"\.d\.[cm]?ts$")


def dead_code(g: RepoGraph, limit: int = 100) -> list[dict]:
    """Candidates only: reflection, entry points named in config files, and string dispatch are invisible here."""
    out = [{**r, "category": "private", "reason": "no static references, not exported, no framework decorator"}
           for r in g.ro("unreferenced", {"limit": limit * 4}) if not _alive(r)][:limit]
    if len(out) < limit:
        out += [{**r, "category": "unused-export", "reason": "exported, but its file is never imported in this repo"}
                for r in g.ro("unused_exports", {"limit": limit * 4})
                if not _alive(r) and not ENTRY_FILES.search(r["file"]) and not DECL_FILE.search(r["file"])
                and r["kind"] != "interface"][: limit - len(out)]
    return out


def overview(g: RepoGraph) -> dict:
    repo = (g.ro("repo") or [{"repo": {}}])[0]["repo"]
    for k in ("edge_mix", "langs", "unresolved_top"):
        if isinstance(repo.get(k), str):
            with suppress(ValueError):
                repo[k] = json.loads(repo[k])
    counts = (g.ro("counts") or [{}])[0]
    cyc = cycles(g, 10)
    return {
        "repo": repo, "counts": counts,
        "hotspots": g.ro("hotspots", {"limit": 15}),
        "central": g.ro("central", {"limit": 15}),
        "cycles": cyc, "cycle_count": len(cyc),
        "dead_code": dead_code(g, 25),
        **subsystems(g),
    }


def file_graph(g: RepoGraph, limit: int = 600) -> dict:
    """File-level import graph for the map view, nodes carrying size/churn/community for styling."""
    files = g.ro("files", {"limit": limit})
    keep = {f["path"] for f in files}
    edges = [e for e in g.ro("import_edges") if e["src"] in keep and e["dst"] in keep]
    return {"nodes": files, "edges": edges}
