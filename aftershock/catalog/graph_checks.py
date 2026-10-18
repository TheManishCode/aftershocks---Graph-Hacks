"""`graph` scripts: read-only questions to the repo's FalkorDB graph. Every query goes through `g.ro`
(GRAPH.RO_QUERY with the configured timeout), so none of these can change the graph."""

from __future__ import annotations

from ..analysis import architecture
from . import Ctx, Finding, Script, register

# The most central functions, then which of them a test reaches within 4 CALLS hops (checked per id, bounded).
_CENTRAL = """
    MATCH (s:Symbol) WHERE s.kind IN ['function', 'method'] AND NOT s.is_test AND coalesce(s.pagerank, 0) > 0
    RETURN s.id AS id, s.file AS file, s.line AS line, s.pagerank AS pagerank, coalesce(s.fan_in, 0) AS fan_in
    ORDER BY pagerank DESC LIMIT $limit"""
_REACHED = """
    UNWIND $ids AS id MATCH (t:Symbol)-[:CALLS*1..4]->(s:Symbol {id: id}) WHERE t.is_test
    RETURN DISTINCT s.id AS id"""
# Test functions that call nothing in the repo: they test a library, a constant, or nothing at all.
_ORPHAN_TESTS = """
    MATCH (t:Symbol) WHERE t.is_test AND t.kind IN ['function', 'method', 'test'] AND NOT (t)-[:CALLS]->(:Symbol)
    RETURN t.id AS id, t.file AS file, t.line AS line ORDER BY id LIMIT $limit"""
# Hot files (churn x complexity); the ones whose symbols no test reaches are reported.
_HOT_FILES = """
    MATCH (f:File)-[:DEFINES]->(s:Symbol) WHERE NOT f.is_test AND coalesce(f.churn, 0) > 0
    WITH f, collect(s.id) AS ids, sum(coalesce(s.complexity, 0)) AS complexity
    RETURN f.path AS file, f.churn AS churn, complexity, ids ORDER BY churn * complexity DESC LIMIT $limit"""
_REACHED3 = """
    UNWIND $ids AS id MATCH (t:Symbol)-[:CALLS*1..3]->(s:Symbol {id: id}) WHERE t.is_test
    RETURN DISTINCT s.id AS id"""
# Very wide fan-in: a change here reaches a lot of callers.
_FAN_IN = """
    MATCH (s:Symbol) WHERE NOT s.is_test AND s.kind IN ['function', 'method'] AND coalesce(s.fan_in, 0) >= $min
    RETURN s.id AS id, s.file AS file, s.line AS line, s.fan_in AS fan_in ORDER BY fan_in DESC LIMIT $limit"""
# Calls the resolver bound by a repo-wide name heuristic (confidence < 0.5): impact through them is least certain.
_WEAK_EDGES = """
    MATCH (a:Symbol)-[c:CALLS]->(b:Symbol) WHERE c.confidence < 0.5 AND NOT a.is_test
    RETURN a.file AS file, a.line AS line, a.id AS src, b.id AS dst, c.how AS how ORDER BY file, line LIMIT $limit"""
_COCHANGE = """
    MATCH (a:File)-[e:CO_CHANGES]->(b:File) WHERE a.path < b.path AND NOT (a)-[:IMPORTS]-(b) AND e.count >= 3
    RETURN a.path AS a, b.path AS b, e.count AS n ORDER BY n DESC LIMIT $limit"""


def _g(ctx: Ctx):
    if ctx.graph is None:
        raise RuntimeError("no graph for this repository; index it first")
    return ctx.graph


def untested_hubs(ctx: Ctx):
    g = _g(ctx)
    rows = g.ro("catalog_central", {"limit": 200}, query=_CENTRAL)
    reached = {r["id"] for r in g.ro("catalog_reached", {"ids": [r["id"] for r in rows]}, query=_REACHED)}
    for r in [r for r in rows if r["id"] not in reached][:50]:
        yield Finding(r["file"], r["line"], f"{r['id']} is central (PageRank {r['pagerank']:.3f}, "
                                            f"{r['fan_in']} callers) and no test reaches it within 4 calls")


def untested_hotspots(ctx: Ctx):
    g = _g(ctx)
    rows = g.ro("catalog_hot_files", {"limit": 40}, query=_HOT_FILES)
    ids = [i for r in rows for i in (r["ids"] or [])][:4000]
    reached = {r["id"] for r in g.ro("catalog_reached3", {"ids": ids}, query=_REACHED3)} if ids else set()
    for r in rows:
        if not reached.intersection(r["ids"] or []):
            yield Finding(r["file"], None, f"changes often ({r['churn']} lines churned, complexity "
                                           f"{r['complexity']}) and no test reaches it")


def import_cycles(ctx: Ctx):
    for c in architecture.cycles(_g(ctx), 30):
        ex = c.get("example") or c["files"]
        yield Finding(c["files"][0], None, f"cycle of {c['size']} files: " + " → ".join(ex[:8]))


def dead_code(ctx: Ctx):
    for r in architecture.dead_code(_g(ctx), 150):
        yield Finding(r["file"], r.get("line"), f"{r.get('qname') or r['name']}: {r['reason']}")


def orphan_tests(ctx: Ctx):
    for r in _g(ctx).ro("catalog_orphan_tests", {"limit": 100}, query=_ORPHAN_TESTS):
        yield Finding(r["file"], r["line"], f"{r['id']} calls no code in this repository")


def wide_fan_in(ctx: Ctx):
    for r in _g(ctx).ro("catalog_fan_in", {"limit": 30, "min": 15}, query=_FAN_IN):
        yield Finding(r["file"], r["line"], f"{r['id']} has {r['fan_in']} callers; any change ripples widely")


def weak_edges(ctx: Ctx):
    for r in _g(ctx).ro("catalog_weak_edges", {"limit": 150}, query=_WEAK_EDGES):
        yield Finding(r["file"], r["line"], f"{r['src']} → {r['dst']} resolved by {r['how']} (low confidence)")


def hidden_coupling(ctx: Ctx):
    for r in _g(ctx).ro("catalog_cochange", {"limit": 40}, query=_COCHANGE):
        yield Finding(r["a"], None, f"changes together with {r['b']} in {r['n']} commits but neither imports the other")


def _indexed(c: Ctx) -> bool:
    return c.graph is not None


def gq(id_, name, summary, fn, severity="info", tags=()):
    return Script(id=id_, name=name, category="graph", ecosystem="graph", summary=summary, kind="graph", fn=fn,
                  applies=_indexed, severity=severity, tags=tuple(tags))


register(
    gq("graph.untested-hubs", "Untested central code",
       "The most central functions (PageRank over CALLS) that no test reaches within 4 calls.", untested_hubs,
       severity="warn", tags=("coverage", "risk")),
    gq("graph.untested-hotspots", "Untested hotspots",
       "Files with high churn × complexity that no test reaches.", untested_hotspots, severity="warn",
       tags=("coverage", "risk")),
    gq("graph.import-cycles", "File import cycles", "Strongly connected groups in the IMPORTS graph.",
       import_cycles, severity="warn", tags=("architecture",)),
    gq("graph.dead-code", "Dead-code candidates",
       "Functions nothing references and exports nothing imports. Candidates: reflection is invisible.", dead_code,
       tags=("cleanup",)),
    gq("graph.orphan-tests", "Tests that call nothing", "Test functions with no CALLS edge into the repository.",
       orphan_tests, tags=("tests",)),
    gq("graph.wide-fan-in", "Very wide fan-in", "Functions with 15 or more callers.", wide_fan_in,
       tags=("risk",)),
    gq("graph.weak-edges", "Low-confidence call edges",
       "Calls bound only by a repo-wide name heuristic, where impact analysis is least sure.", weak_edges,
       tags=("accuracy",)),
    gq("graph.hidden-coupling", "Hidden coupling",
       "Files that change together in git history (3+ commits) with no import between them.", hidden_coupling,
       tags=("architecture", "history")),
)
