"""Tests failed: which code is most likely responsible?

Spectrum-based fault localization (Ochiai) on the static graph instead of runtime coverage:

    suspicion(s) = failed(s) / sqrt(total_failed * (failed(s) + passed(s)))

failed(s): failing tests that statically reach s; passed(s): other tests that reach s. A test that calls Base.m also
reaches every override of it (dynamic dispatch). When per-test coverage is recorded (`aftershock coverage`), a test
also "reaches" every function it ran, which is classic spectrum-based localization; and a passing test with recorded
coverage counts against a symbol only if it actually ran it, so code a healthy test could reach but skipped (an early
return, an untaken branch) is not cleared by that test. Stale coverage (its file changed since) falls back to static. Code every failing test
depends on, but few healthy tests touch, ranks first. When the change set is known, changed symbols get a boost
and the answer becomes "this change, via this path, explains these failures". Every suspect carries the path from a
failing test to it.
"""

from __future__ import annotations

import math

from ..graph import RepoGraph
from ..ingest.discover import LIB_PREFIX
from .lookup import find

FORWARD_DEPTH = 5
REVERSE_DEPTH = 5
MAX_CANDIDATES = 60
CHANGED_BOOST = 1.5
# A changed symbol deeper than FORWARD_DEPTH (test -> runner -> main -> parse_args -> ... -> _split_opt) is still the
# likeliest culprit: test selection reached those tests through it. Search back from it this far instead.
CHANGED_DEPTH = 12
MAX_CHANGED_DEEP = 20


def _forward(g: RepoGraph, starts: list[str], depth: int) -> dict[str, dict[str, tuple[str | None, dict | None]]]:
    """Per start: node -> (parent, edge) for everything it depends on, BFS so parents give a shortest path.

    All starts expand together, one query per hop (batched), instead of one query per start per hop.
    """
    seen = {s: {s: (None, None)} for s in starts}
    frontier = {s: [s] for s in starts}
    for _ in range(depth):
        ids = sorted({n for f in frontier.values() for n in f})
        if not ids:
            break
        by_src: dict[str, list[dict]] = {}
        for i in range(0, len(ids), 500):
            batch = ids[i : i + 500]
            rows = g.ro("dependencies", {"ids": batch, "limit": 50_000})
            rows += [{**r, "type": "DISPATCH"} for r in g.ro("dispatch_targets", {"ids": batch, "limit": 50_000})]
            for r in rows:
                by_src.setdefault(r["src"], []).append(r)
        for s in starts:
            mine, nxt = seen[s], []
            for node in frontier[s]:
                for r in by_src.get(node, ()):
                    if r["dst"] not in mine:
                        mine[r["dst"]] = (r["src"], {"type": r["type"], "how": r["how"], "confidence": r["confidence"],
                                                     "lines": (r.get("lines") or [])[:3]})
                        nxt.append(r["dst"])
            frontier[s] = sorted(set(nxt))
    return seen


def _reverse_chains(g: RepoGraph, origin: str, depth: int) -> dict[str, list[dict]]:
    """Every test that transitively depends on `origin`, with the shortest test -> ... -> origin edge chain."""
    parent: dict[str, tuple[str, dict]] = {}
    tests: list[str] = []
    frontier = [origin]
    for _ in range(depth):
        if not frontier:
            break
        nxt = []
        for i in range(0, len(frontier), 500):
            batch = frontier[i : i + 500]
            for r in [*g.ro("dependents", {"ids": batch, "limit": 50_000}),
                      *g.ro("dispatch_callers", {"ids": batch, "limit": 50_000})]:
                if r["src"] == origin or r["src"] in parent:
                    continue
                parent[r["src"]] = (r["dst"], {"type": r.get("type") or "DISPATCH", "how": r["how"],
                                               "confidence": r["confidence"], "lines": (r.get("lines") or [])[:3]})
                nxt.append(r["src"])
                if r.get("is_test"):
                    tests.append(r["src"])
        frontier = sorted(set(nxt))
    out = {}
    for t in tests:
        chain, cur = [], t
        while cur != origin and len(chain) < 32:
            nxt_node, edge = parent[cur]
            chain.append({"from": cur, "to": nxt_node, **edge})
            cur = nxt_node
        out[t] = chain
    return out


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
    reach = _forward(g, tests, FORWARD_DEPTH)
    failed_by: dict[str, set[str]] = {}
    for t, seen in reach.items():
        for node in seen:
            if node != t:
                failed_by.setdefault(node, set()).add(t)
    ran = g.ro("covered_by", {"ids": tests, "limit": 200_000})
    for r in ran:
        failed_by.setdefault(r["dst"], set()).add(r["src"])
    changed_set = set(changed or [])
    deep: dict[str, dict[str, list[dict]]] = {}  # changed symbol out of forward reach -> test -> chain to it
    for c in sorted(changed_set)[:MAX_CHANGED_DEEP]:
        chains = _reverse_chains(g, c, CHANGED_DEPTH)
        if set(chains) & set(tests):  # tests that reach c directly have a chain here too, so this only adds
            deep[c] = chains
            failed_by[c] = failed_by.get(c, set()) | (set(chains) & set(tests))
    cands = sorted(failed_by, key=lambda n: (-len(failed_by[n]), n not in changed_set, n))[:MAX_CANDIDATES]
    cands = sorted(set(cands) | (changed_set & set(failed_by)))
    syms = {}
    for i in range(0, len(cands), 1000):
        for r in g.ro("symbols_by_ids", {"ids": cands[i : i + 1000]}):
            syms[r["symbol"]["id"]] = r["symbol"]
    cands = [c for c in cands if not syms.get(c, {}).get("is_test") and syms.get(c, {}).get("kind") != "module"
             and not c.startswith(LIB_PREFIX)]  # a test library's helpers are test code, not a suspect
    reaching = _tests_reaching(g, cands, REVERSE_DEPTH)
    measured_c: set[str] = set()  # candidates whose passing-test count comes from recorded coverage
    if ran:
        measured = {r["id"] for r in g.ro("tests_with_coverage")}
        covering: dict[str, set[str]] = {}
        stale: set[str] = set()
        for i in range(0, len(cands), 500):
            for r in g.ro("covering_tests", {"ids": cands[i : i + 500], "limit": 500_000}):
                (stale.add(r["dst"]) if r["stale"] else covering.setdefault(r["dst"], set()).add(r["src"]))
        for c in cands:
            static = reaching.get(c, set())
            # a measured test's coverage replaces its static guess, for what coverage measures (function bodies)
            if c not in stale and syms[c].get("kind") in ("function", "method"):
                static = {t for t in static if t not in measured}
                if measured:
                    measured_c.add(c)
            reaching[c] = static | covering.get(c, set())
    F = len(tests)
    rows = []
    for c in cands:
        f = len(failed_by[c])
        passed = len(reaching.get(c, set()) - set(tests))  # same depth for every candidate, deep or not
        score = f / math.sqrt(F * (f + passed)) if f else 0.0
        if c in changed_set:
            score *= CHANGED_BOOST
        # the shortest chain from any failing test; on equal scores the nearer symbol is the more actionable suspect
        path = min((deep[c][t] if c in deep else _chain(reach[t], c) if c in reach[t] else
                    [{"from": t, "to": c, "type": "COVERS", "how": "coverage", "confidence": 1.0, "lines": []}]
                    for t in sorted(failed_by[c])), key=len)
        basis = "coverage" if c in measured_c else "static"
        why = (f"reached by {f} of {F} failing test(s) and {passed} passing one(s) "
               f"({'measured by coverage' if basis == 'coverage' else 'static call graph'}); "
               f"Ochiai {f}/sqrt({F}*({f}+{passed})) = {f / math.sqrt(F * (f + passed)) if f else 0:.2f}"
               + (f", x{CHANGED_BOOST} because it changed" if c in changed_set else "")
               + f"; {len(path)} hop(s) from a failing test")
        rows.append({
            "id": c, "name": syms[c].get("qname"), "file": syms[c].get("file"), "line": syms[c].get("line"),
            "end_line": syms[c].get("end_line"),
            "score": round(score, 4), "failed": f, "passed": passed, "changed": c in changed_set,
            "failing_tests": sorted(failed_by[c])[:10], "hops": len(path), "path": path, "basis": basis, "why": why,
        })
    rows.sort(key=lambda r: (-r["score"], -r["failed"], r["passed"], r["hops"], r["id"]))
    ran_by: dict[str, set[str]] = {}
    for r in ran:
        ran_by.setdefault(r["src"], set()).add(r["dst"])
    explained = {t for c in deep for t in deep[c]}
    unexplained = [t for t in tests if changed_set and t not in explained
                   and not ((set(reach[t]) | ran_by.get(t, set())) & changed_set)]
    return {
        "failing": tests, "suspects": rows[:limit], "problems": problems,
        "unexplained": unexplained, "runtime": bool(ran),
        "method": ("Ochiai over static reachability plus recorded per-test coverage" if ran else
                   "Ochiai over static reachability (no runtime coverage recorded)") + "; changed symbols x1.5",
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
