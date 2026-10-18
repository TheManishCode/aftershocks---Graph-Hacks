"""Tests failed: which code is most likely responsible?

Spectrum-based fault localization (Ochiai) on the static graph instead of runtime coverage:

    suspicion(s) = failed(s) / sqrt(total_failed * (failed(s) + passed(s)))

failed(s): failing tests that statically reach s; passed(s): other tests that reach s. A test that calls Base.m also
reaches every override of it (dynamic dispatch). Code every failing test
depends on, but few healthy tests touch, ranks first. When the change set is known, changed symbols get a boost
and the answer becomes "this change, via this path, explains these failures". Every suspect carries the path from a
failing test to it.
"""

from __future__ import annotations

import math

from ..graph import RepoGraph
from .lookup import find

FORWARD_DEPTH = 5
REVERSE_DEPTH = 5
MAX_CANDIDATES = 60
CHANGED_BOOST = 1.5


def _forward(g: RepoGraph, start: str, depth: int) -> dict[str, tuple[str | None, dict | None]]:
    """node -> (parent, edge) for everything `start` depends on, BFS so parents give a shortest path."""
    seen: dict[str, tuple[str | None, dict | None]] = {start: (None, None)}
    frontier = [start]
    for _ in range(depth):
        if not frontier:
            break
        nxt = []
        rows = g.ro("dependencies", {"ids": frontier, "limit": 20_000})
        rows += [{**r, "type": "DISPATCH"} for r in g.ro("dispatch_targets", {"ids": frontier, "limit": 20_000})]
        for r in rows:
            if r["dst"] not in seen:
                seen[r["dst"]] = (r["src"], {"type": r["type"], "how": r["how"], "confidence": r["confidence"],
                                             "lines": (r.get("lines") or [])[:3]})
                nxt.append(r["dst"])
        frontier = sorted(set(nxt))
    return seen


def _tests_reaching(g: RepoGraph, ids: list[str], depth: int) -> dict[str, set[str]]:
    """For each id, the test symbols that (transitively) depend on it. One query per hop for all ids together."""
    origins: dict[str, set[str]] = {i: {i} for i in ids}
    out: dict[str, set[str]] = {i: set() for i in ids}
    frontier = dict(origins)
    for _ in range(depth):
        if not frontier:
            break
        nxt: dict[str, set[str]] = {}
        keys = sorted(frontier)
        for i in range(0, len(keys), 500):
            batch = keys[i : i + 500]
            for r in [*g.ro("dependents", {"ids": batch, "limit": 50_000}),
                      *g.ro("dispatch_callers", {"ids": batch, "limit": 50_000})]:
                src_origins = frontier[r["dst"]]
                if r.get("is_test"):
                    for o in src_origins:
                        out[o].add(r["src"])
                prev = origins.setdefault(r["src"], set())
                new = src_origins - prev
                if new:
                    prev |= new
                    nxt.setdefault(r["src"], set()).update(new)
        frontier = nxt
    return out


def suspects(g: RepoGraph, failing: list[str], changed: list[str] | None = None, limit: int = 15) -> dict:
    tests, problems = [], []
    for ref in failing:
        m = find(g, ref)
        if m.ok:
            tests += m.ids
        else:
            problems.append({"ref": ref, "error": m.error, "candidates": m.candidates})
    tests = sorted(set(tests))
    if not tests:
        return {"error": "none of the failing tests were found in the graph", "problems": problems}
    reach = {t: _forward(g, t, FORWARD_DEPTH) for t in tests}
    failed_by: dict[str, set[str]] = {}
    for t, seen in reach.items():
        for node in seen:
            if node != t:
                failed_by.setdefault(node, set()).add(t)
    changed_set = set(changed or [])
    cands = sorted(failed_by, key=lambda n: (-len(failed_by[n]), n not in changed_set, n))[:MAX_CANDIDATES]
    cands = sorted(set(cands) | (changed_set & set(failed_by)))
    syms = {}
    for i in range(0, len(cands), 1000):
        for r in g.ro("symbols_by_ids", {"ids": cands[i : i + 1000]}):
            syms[r["symbol"]["id"]] = r["symbol"]
    cands = [c for c in cands if not syms.get(c, {}).get("is_test") and syms.get(c, {}).get("kind") != "module"]
    reaching = _tests_reaching(g, cands, REVERSE_DEPTH)
    F = len(tests)
    rows = []
    for c in cands:
        f = len(failed_by[c])
        passed = len(reaching.get(c, set()) - set(tests))
        score = f / math.sqrt(F * (f + passed)) if f else 0.0
        if c in changed_set:
            score *= CHANGED_BOOST
        # the shortest chain from any failing test; on equal scores the nearer symbol is the more actionable suspect
        path = min((_chain(reach[t], c) for t in sorted(failed_by[c])), key=len)
        rows.append({
            "id": c, "name": syms[c].get("qname"), "file": syms[c].get("file"), "line": syms[c].get("line"),
            "score": round(score, 4), "failed": f, "passed": passed, "changed": c in changed_set,
            "failing_tests": sorted(failed_by[c])[:10], "hops": len(path), "path": path,
        })
    rows.sort(key=lambda r: (-r["score"], -r["failed"], r["passed"], r["hops"], r["id"]))
    unexplained = [t for t in tests if changed_set and not (set(reach[t]) & changed_set)]
    return {
        "failing": tests, "suspects": rows[:limit], "problems": problems,
        "unexplained": unexplained,
        "method": "Ochiai over static reachability (no runtime coverage); changed symbols x1.5",
    }


def _chain(seen: dict[str, tuple[str | None, dict | None]], node: str) -> list[dict]:
    out, cur = [], node
    while cur is not None and len(out) < 32:
        parent, edge = seen[cur]
        if parent is None:
            break
        out.append({"from": parent, "to": cur, **(edge or {})})
        cur = parent
    return out[::-1]
