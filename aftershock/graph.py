"""FalkorDB access. One graph per indexed repository, keyed `repo:<name>`; every Cypher string lives in QUERIES.

Schema
  (:Repo {name, root, url, commit, indexed_at, parser_version, files, symbols, calls})
  (:File {path, lang, sha, loc, is_test, error, out_digest, churn, commits, authors, last_change})
  (:Symbol {id, file, name, qname, kind, line, end_line, signature, params, digest, sig_digest, complexity, loc,
            doc, exported, is_test, min_args, max_args, pagerank, betweenness, community, fan_in, fan_out})
  (:External {name})            a package or module outside the repo
  (:Person {email, name})
  (File)-[:DEFINES]->(Symbol)   (Symbol)-[:CONTAINS]->(Symbol)    class -> method, function -> nested function
  (Symbol)-[:CALLS {how, confidence, count, lines, args, kind}]->(Symbol)
  (Symbol)-[:INHERITS|IMPLEMENTS {how, confidence}]->(Symbol)
  (Symbol)-[:OVERRIDES {how, confidence, lines}]->(Symbol)    Child.m -> nearest Base.m it redefines
  (File)-[:IMPORTS {names, line}]->(File)    (File)-[:USES]->(External)
  (File)-[:CO_CHANGES {count, strength}]->(File)    (Person)-[:AUTHORED {commits, last}]->(File)
  (Symbol test)-[:COVERS {runs}]->(Symbol)    the test executed it, per recorded per-test coverage (runtime/)
  Full-text index on Symbol(name, doc) (`db.idx.fulltext`): stemmed word search, used by lookup.search
  (:TestRun {id, mode, trigger, started, seconds, passed, failed, skipped, exit_code, commit, ...})   runtime/runs.py
  (TestRun)-[:RAN {outcome, seconds, message}]->(Symbol test)
  (TestRun)-[:SUSPECTS {rank, score, hops}]->(Symbol)   culprit ranking of the run's failures
  (TestRun)-[:RETRY_OF]->(TestRun)                      a heal re-run of an earlier run

Ownership (what makes incremental re-indexing safe): a file owns its Symbols and every edge *leaving* them or
leaving the File. Re-indexing a file replaces exactly what it owns; edges other files point at it survive unless
the target symbol vanished.

Every traversal is bounded (`*1..N` with N <= settings.max_depth) and every read goes through GRAPH.RO_QUERY.
"""

from __future__ import annotations

import contextvars
import json
import logging
import re
import time
from contextlib import contextmanager, suppress
from functools import lru_cache
from typing import Any

from redis.exceptions import RedisError

from .config import get_settings

log = logging.getLogger("aftershock.graph")

DEP = "CALLS|INHERITS|IMPLEMENTS|OVERRIDES"  # symbol-level dependency edges an impact can travel along
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

QUERIES: dict[str, str] = {
    # ---- schema ------------------------------------------------------------------------------------------------
    # Range indexes only: FalkorDB's unique constraints conflict with MERGE, and MERGE on an indexed key is fast.
    "idx_file": "CREATE INDEX FOR (f:File) ON (f.path)",
    "idx_symbol_id": "CREATE INDEX FOR (s:Symbol) ON (s.id)",
    "idx_symbol_name": "CREATE INDEX FOR (s:Symbol) ON (s.name)",
    "idx_symbol_file": "CREATE INDEX FOR (s:Symbol) ON (s.file)",
    "idx_external": "CREATE INDEX FOR (e:External) ON (e.name)",
    "idx_person": "CREATE INDEX FOR (p:Person) ON (p.email)",
    "idx_testrun": "CREATE INDEX FOR (r:TestRun) ON (r.id)",
    "idx_symbol_text": "CALL db.idx.fulltext.createNodeIndex('Symbol', 'name', 'doc')",  # stemmed words in docstrings
    # ---- writes (batched with UNWIND, ~1000 rows each) --------------------------------------------------------------
    "upsert_repo": "MERGE (r:Repo {name: $name}) SET r += $props",
    "upsert_files": "UNWIND $rows AS r MERGE (f:File {path: r.path}) SET f += r.props",
    "upsert_symbols": """
        UNWIND $rows AS r
        MERGE (s:Symbol {id: r.id}) SET s += r.props
        WITH s, r MATCH (f:File {path: r.props.file}) MERGE (f)-[:DEFINES]->(s)""",
    "link_contains": """
        UNWIND $rows AS r MATCH (p:Symbol {id: r.parent}), (c:Symbol {id: r.child}) MERGE (p)-[:CONTAINS]->(c)""",
    "link_calls": """
        UNWIND $rows AS r MATCH (a:Symbol {id: r.src}), (b:Symbol {id: r.dst})
        MERGE (a)-[e:CALLS]->(b) SET e += r.props""",
    "link_inherits": """
        UNWIND $rows AS r MATCH (a:Symbol {id: r.src}), (b:Symbol {id: r.dst})
        MERGE (a)-[e:INHERITS]->(b) SET e += r.props""",
    "link_implements": """
        UNWIND $rows AS r MATCH (a:Symbol {id: r.src}), (b:Symbol {id: r.dst})
        MERGE (a)-[e:IMPLEMENTS]->(b) SET e += r.props""",
    "link_overrides": """
        UNWIND $rows AS r MATCH (a:Symbol {id: r.src}), (b:Symbol {id: r.dst})
        MERGE (a)-[e:OVERRIDES]->(b) SET e += r.props""",
    "link_imports": """
        UNWIND $rows AS r MATCH (a:File {path: r.src}), (b:File {path: r.dst})
        MERGE (a)-[e:IMPORTS]->(b) SET e += r.props""",
    "link_externals": """
        UNWIND $rows AS r MATCH (f:File {path: r.file}) MERGE (x:External {name: r.name}) MERGE (f)-[:USES]->(x)""",
    "drop_vanished_symbols": """
        UNWIND $rows AS r MATCH (s:Symbol {file: r.path}) WHERE NOT s.id IN r.keep DETACH DELETE s""",
    "drop_outgoing": """
        UNWIND $paths AS p MATCH (s:Symbol {file: p})-[e:CALLS|INHERITS|IMPLEMENTS|OVERRIDES]->() DELETE e""",
    "mark_coverage_stale": """
        UNWIND $paths AS p MATCH (s:Symbol {file: p})-[e:COVERS]-(:Symbol) SET e.stale = true""",
    "drop_file_links": """
        UNWIND $paths AS p MATCH (f:File {path: p})-[e:IMPORTS|USES]->() DELETE e""",
    "drop_files": """
        UNWIND $paths AS p MATCH (f:File {path: p}) OPTIONAL MATCH (f)-[:DEFINES]->(s:Symbol) DETACH DELETE s, f""",
    "drop_orphan_externals": "MATCH (x:External) WHERE NOT ()-[:USES]->(x) DELETE x",
    "drop_history": "MATCH ()-[e:CO_CHANGES|AUTHORED]->() DELETE e",
    "drop_coverage": "MATCH ()-[e:COVERS]->() DELETE e",
    "drop_coverage_of": "UNWIND $ids AS id MATCH (t:Symbol {id: id})-[e:COVERS]->() DELETE e",
    "link_covers": """
        UNWIND $rows AS r MATCH (a:Symbol {id: r.src}), (b:Symbol {id: r.dst})
        MERGE (a)-[e:COVERS]->(b) SET e.runs = r.runs""",
    "set_history": "UNWIND $rows AS r MATCH (f:File {path: r.path}) SET f += r.props",
    "link_cochange": """
        UNWIND $rows AS r MATCH (a:File {path: r.a}), (b:File {path: r.b})
        MERGE (a)-[e:CO_CHANGES]->(b) SET e.count = r.count, e.strength = r.strength""",
    "link_authored": """
        UNWIND $rows AS r MATCH (f:File {path: r.path}) MERGE (p:Person {email: r.email}) SET p.name = r.name
        MERGE (p)-[e:AUTHORED]->(f) SET e.commits = r.commits, e.last = r.last""",
    # ---- derived metrics (written back so reads stay cheap) ---------------------------------------------------------
    "algo_pagerank": "CALL algo.pageRank('Symbol', 'CALLS') YIELD node, score SET node.pagerank = score",
    "algo_betweenness": """
        CALL algo.betweenness({nodeLabels: ['Symbol'], relationshipTypes: ['CALLS'], samplingSize: $sample,
                               samplingSeed: 7})
        YIELD node, score SET node.betweenness = score""",
    "algo_communities": """
        CALL algo.labelPropagation({nodeLabels: ['File'], relationshipTypes: ['IMPORTS'], maxIterations: 20})
        YIELD node, communityId SET node.community = communityId""",
    "fan_counts": """
        MATCH (s:Symbol)
        OPTIONAL MATCH (s)<-[i:CALLS]-() WITH s, count(i) AS fi
        OPTIONAL MATCH (s)-[o:CALLS]->() WITH s, fi, count(o) AS fo
        SET s.fan_in = fi, s.fan_out = fo""",
    "symbol_community": """
        MATCH (f:File)-[:DEFINES]->(s:Symbol) SET s.community = f.community""",
    # ---- reads -------------------------------------------------------------------------------------------------
    "repo": "MATCH (r:Repo) RETURN properties(r) AS repo LIMIT 1",
    "counts": """
        MATCH (f:File) WITH count(f) AS files
        MATCH (s:Symbol) WITH files, count(s) AS symbols
        OPTIONAL MATCH ()-[c:CALLS]->() WITH files, symbols, count(c) AS calls
        OPTIONAL MATCH ()-[i:IMPORTS]->() RETURN files, symbols, calls, count(i) AS imports""",
    "edge_mix": "MATCH ()-[c:CALLS]->() RETURN c.how AS how, count(c) AS n ORDER BY n DESC",
    "file_index": """
        MATCH (f:File) RETURN f.path AS path, f.sha AS sha, f.out_digest AS out_digest, f.is_test AS is_test,
                              f.parser_version AS parser_version""",
    "files": """
        MATCH (f:File) OPTIONAL MATCH (f)-[:DEFINES]->(s:Symbol)
        RETURN f.path AS path, f.lang AS lang, f.loc AS loc, f.is_test AS is_test, f.churn AS churn,
               f.community AS community, f.error AS error, count(s) AS symbols,
               sum(coalesce(s.complexity, 0)) AS complexity
        ORDER BY path LIMIT $limit""",
    "file": """
        MATCH (f:File {path: $path}) OPTIONAL MATCH (f)-[:DEFINES]->(s:Symbol)
        WITH f, s ORDER BY s.line
        RETURN properties(f) AS file, collect(properties(s)) AS symbols""",
    "file_imports": """
        MATCH (f:File {path: $path})-[e:IMPORTS]->(g:File) RETURN g.path AS path, e.names AS names, e.line AS line ORDER BY path LIMIT 2000""",
    "file_importers": """
        MATCH (f:File {path: $path})<-[e:IMPORTS]-(g:File) RETURN g.path AS path, e.names AS names, e.line AS line ORDER BY path LIMIT 2000""",
    "file_externals": "MATCH (:File {path: $path})-[:USES]->(x:External) RETURN x.name AS name ORDER BY name",
    "importers_of": """
        UNWIND $paths AS p MATCH (f:File {path: p})<-[e:IMPORTS]-(g:File)
        RETURN g.path AS file, f.path AS imports, e.names AS names, e.line AS line ORDER BY file LIMIT $limit""",
    "import_edges": "MATCH (a:File)-[:IMPORTS]->(b:File) RETURN a.path AS src, b.path AS dst",
    "symbol": "MATCH (s:Symbol {id: $id}) RETURN properties(s) AS symbol",
    "symbols_by_ids": "UNWIND $ids AS id MATCH (s:Symbol {id: id}) RETURN properties(s) AS symbol",
    "symbols_in_files": """
        UNWIND $paths AS p MATCH (s:Symbol {file: p}) RETURN properties(s) AS symbol ORDER BY s.file, s.line""",
    "symbols_by_name": """
        MATCH (s:Symbol {name: $name}) RETURN properties(s) AS symbol ORDER BY s.is_test, s.file LIMIT $limit""",
    "search": """
        MATCH (s:Symbol) WHERE s.kind <> 'module' AND (toLower(s.name) CONTAINS $q OR toLower(s.qname) CONTAINS $q)
        RETURN s.id AS id, s.name AS name, s.qname AS qname, s.kind AS kind, s.file AS file, s.line AS line,
               s.is_test AS is_test, coalesce(s.pagerank, 0) AS pagerank, coalesce(s.fan_in, 0) AS fan_in
        ORDER BY pagerank DESC, id LIMIT 400""",
    "search_text": """
        CALL db.idx.fulltext.queryNodes('Symbol', $q) YIELD node AS s, score WITH s, score WHERE s.kind <> 'module'
        RETURN s.id AS id, s.name AS name, s.qname AS qname, s.kind AS kind, s.file AS file, s.line AS line,
               s.is_test AS is_test, coalesce(s.pagerank, 0) AS pagerank, coalesce(s.fan_in, 0) AS fan_in, score
        ORDER BY score DESC, id LIMIT 100""",
    "search_files": """
        MATCH (f:File) WHERE toLower(f.path) CONTAINS $q RETURN f.path AS path, f.lang AS lang ORDER BY path LIMIT 50""",
    # One hop of the reverse (who depends on these?) frontier; Python drives the BFS so it can keep the best
    # evidence path per node and stop early, instead of enumerating every path inside Cypher.
    "dependents": """
        UNWIND $ids AS id MATCH (b:Symbol {id: id})<-[e:CALLS|INHERITS|IMPLEMENTS]-(a:Symbol)
        RETURN a.id AS src, b.id AS dst, type(e) AS type, e.how AS how, e.confidence AS confidence,
               e.lines AS lines, e.args AS args, e.kind AS kind, e.names AS names, a.is_test AS is_test,
               a.kind AS src_kind
        ORDER BY src, dst LIMIT $limit""",
    "dependencies": """
        UNWIND $ids AS id MATCH (a:Symbol {id: id})-[e:CALLS|INHERITS|IMPLEMENTS]->(b:Symbol)
        RETURN a.id AS src, b.id AS dst, type(e) AS type, e.how AS how, e.confidence AS confidence,
               e.lines AS lines, e.args AS args, e.kind AS kind, b.is_test AS is_test, b.kind AS dst_kind
        ORDER BY src, dst LIMIT $limit""",
    # Dynamic dispatch, kept out of `dependents`/`dependencies` so culprit's reachability stays directional:
    # callers of a method the given override redefines (a call to Base.m can run Child.m) ...
    "dispatch_callers": """
        UNWIND $ids AS id MATCH p = (x:Symbol {id: id})-[:OVERRIDES*1..3]->(b:Symbol)<-[e:CALLS]-(a:Symbol)
        WHERE a.id <> x.id
        RETURN a.id AS src, x.id AS dst, b.id AS via, [r IN relationships(p) | r.confidence] AS confs,
               e.how AS how, e.confidence AS confidence, e.lines AS lines, e.args AS args, a.is_test AS is_test
        ORDER BY dst, src, via LIMIT $limit""",
    # ... the methods that redefine the given ones (what a call to Base.m may actually run) ...
    "dispatch_targets": """
        UNWIND $ids AS id MATCH (b:Symbol {id: id})<-[o:OVERRIDES]-(c:Symbol)
        RETURN b.id AS src, c.id AS dst, o.how AS how, o.confidence AS confidence, o.lines AS lines
        ORDER BY src, dst LIMIT $limit""",
    # ... and the overrides themselves, with their arity, for when a base method's contract changes.
    "overriders": """
        UNWIND $ids AS id MATCH (b:Symbol {id: id})<-[o:OVERRIDES]-(c:Symbol)
        RETURN c.id AS src, b.id AS dst, o.how AS how, o.confidence AS confidence, o.lines AS lines,
               c.min_args AS min_args, c.max_args AS max_args ORDER BY dst, src LIMIT $limit""",
    "bases_of": """
        UNWIND $ids AS id MATCH p = (:Symbol {id: id})-[:INHERITS|IMPLEMENTS*1..3]->(b:Symbol)
        RETURN id AS src, b.id AS base, length(p) AS depth ORDER BY src, depth, base""",
    "children": "UNWIND $ids AS id MATCH (:Symbol {id: id})-[:CONTAINS]->(c:Symbol) RETURN c.id AS id",
    "subclasses_of": """
        UNWIND $ids AS id MATCH (c:Symbol)-[:INHERITS|IMPLEMENTS]->(:Symbol {id: id}) RETURN c.id AS id""",
    "path": """
        MATCH (a:Symbol {id: $src}), (b:Symbol {id: $dst})
        WITH shortestPath((a)-[:CALLS|INHERITS|IMPLEMENTS|OVERRIDES*1..{depth}]->(b)) AS p WHERE p IS NOT NULL
        RETURN [n IN nodes(p) | n.id] AS ids,
               [r IN relationships(p) | {type: type(r), how: r.how, confidence: r.confidence, lines: r.lines}] AS rels""",
    "file_path": """
        MATCH (a:File {path: $src}), (b:File {path: $dst})
        WITH shortestPath((a)-[:IMPORTS*1..{depth}]->(b)) AS p WHERE p IS NOT NULL
        RETURN [n IN nodes(p) | n.path] AS ids""",
    "neighborhood": """
        MATCH (s:Symbol {id: $id})-[e:CALLS|INHERITS|IMPLEMENTS|OVERRIDES]-(o:Symbol)
        RETURN s.id AS center, o.id AS other, type(e) AS type, startNode(e) = s AS outgoing,
               e.how AS how, e.confidence AS confidence, e.lines AS lines
        ORDER BY confidence DESC, other LIMIT $limit""",
    "call_edges": """
        MATCH (a:Symbol)-[e:CALLS]->(b:Symbol) WHERE e.confidence >= $min_conf
        RETURN a.id AS src, b.id AS dst, e.confidence AS confidence ORDER BY confidence DESC, src, dst LIMIT $limit""",
    "hotspots": """
        MATCH (f:File) WHERE NOT f.is_test
        OPTIONAL MATCH (f)-[:DEFINES]->(s:Symbol)
        WITH f, sum(coalesce(s.complexity, 0)) AS complexity, max(coalesce(s.pagerank, 0)) AS pagerank,
             sum(coalesce(s.fan_in, 0)) AS fan_in
        RETURN f.path AS path, f.lang AS lang, f.loc AS loc, coalesce(f.churn, 0) AS churn,
               coalesce(f.commits, 0) AS commits, complexity, pagerank, fan_in, f.community AS community
        ORDER BY churn * complexity DESC, complexity DESC LIMIT $limit""",
    "central": """
        MATCH (s:Symbol) WHERE s.kind <> 'module' AND NOT s.is_test
        RETURN s.id AS id, s.name AS name, s.qname AS qname, s.kind AS kind, s.file AS file, s.line AS line,
               coalesce(s.pagerank, 0) AS pagerank, coalesce(s.betweenness, 0) AS betweenness,
               coalesce(s.fan_in, 0) AS fan_in, coalesce(s.complexity, 1) AS complexity
        ORDER BY pagerank DESC LIMIT $limit""",
    "unreferenced": """
        MATCH (s:Symbol) WHERE s.kind IN ['function', 'method'] AND NOT s.is_test AND NOT s.exported
              AND NOT ()-[:CALLS|INHERITS|IMPLEMENTS|OVERRIDES]->(s) AND NOT (s)-[:OVERRIDES]->()
        RETURN s.id AS id, s.name AS name, s.qname AS qname, s.kind AS kind, s.file AS file, s.line AS line,
               s.decorators AS decorators, s.loc AS loc
        ORDER BY s.file, s.line LIMIT $limit""",
    "unused_exports": """
        MATCH (f:File)-[:DEFINES]->(s:Symbol)
        WHERE s.exported AND NOT s.is_test AND NOT f.is_test AND s.kind IN ['function', 'class', 'struct', 'interface']
              AND NOT s.qname CONTAINS '.' AND NOT ()-[:CALLS|INHERITS|IMPLEMENTS]->(s) AND NOT ()-[:IMPORTS]->(f)
        RETURN s.id AS id, s.name AS name, s.qname AS qname, s.kind AS kind, s.file AS file, s.line AS line,
               s.decorators AS decorators, s.loc AS loc
        ORDER BY s.file, s.line LIMIT $limit""",
    "cochanged_with": """
        UNWIND $paths AS p MATCH (:File {path: p})-[e:CO_CHANGES]-(o:File) WHERE NOT o.path IN $paths
        RETURN o.path AS path, max(e.strength) AS strength, max(e.count) AS count, collect(DISTINCT p) AS via
        ORDER BY strength DESC LIMIT $limit""",
    "owners": """
        UNWIND $paths AS p MATCH (pe:Person)-[e:AUTHORED]->(:File {path: p})
        WITH pe, sum(e.commits) AS commits, max(e.last) AS last, collect(DISTINCT p) AS files
        RETURN pe.email AS email, pe.name AS name, commits, last, size(files) AS file_count, files[0..8] AS files
        ORDER BY commits DESC LIMIT $limit""",
    "communities": """
        MATCH (f:File) WHERE f.community IS NOT NULL
        RETURN f.community AS community, collect(f.path) AS files, count(f) AS size ORDER BY size DESC""",
    "community_edges": """
        MATCH (a:File)-[:IMPORTS]->(b:File) WHERE a.community IS NOT NULL AND b.community IS NOT NULL
              AND a.community <> b.community
        RETURN a.community AS src, b.community AS dst, count(*) AS weight""",
    "spans": """
        MATCH (s:Symbol) WHERE s.kind IN ['function', 'method'] AND s.file IN $files
        RETURN s.id AS id, s.file AS file, s.line AS line, s.end_line AS end_line""",
    "covering_tests": """
        MATCH (t:Symbol)-[e:COVERS]->(s:Symbol) WHERE s.id IN $ids AND t.is_test
        RETURN t.id AS src, s.id AS dst, e.runs AS runs, coalesce(e.stale, false) AS stale
        ORDER BY src, dst LIMIT $limit""",
    "tests_with_coverage": """
        MATCH (t:Symbol)-[e:COVERS]->(:Symbol) WHERE t.is_test AND NOT coalesce(e.stale, false)
        RETURN DISTINCT t.id AS id""",
    "covered_by": """
        MATCH (t:Symbol)-[:COVERS]->(s:Symbol) WHERE t.id IN $ids AND NOT s.is_test
        RETURN t.id AS src, s.id AS dst ORDER BY src, dst LIMIT $limit""",
    "tests": """
        MATCH (s:Symbol) WHERE s.is_test AND s.kind IN ['function', 'method', 'test']
        RETURN s.id AS id, s.name AS name, s.qname AS qname, s.file AS file, s.line AS line""",
    # ---- test runs (runtime/runs.py) ---------------------------------------------------------------------------
    "run_upsert": "MERGE (r:TestRun {id: $id}) SET r += $props",
    "run_link_ran": """
        UNWIND $rows AS x MATCH (r:TestRun {id: $id}) MATCH (s:Symbol {id: x.test})
        CREATE (r)-[:RAN {outcome: x.outcome, seconds: x.seconds, message: x.message}]->(s)""",
    "run_link_suspects": """
        UNWIND $rows AS x MATCH (r:TestRun {id: $id}) MATCH (s:Symbol {id: x.id})
        CREATE (r)-[:SUSPECTS {rank: x.rank, score: x.score, hops: x.hops}]->(s)""",
    "run_link_retry": "MATCH (a:TestRun {id: $id}), (b:TestRun {id: $parent}) MERGE (a)-[:RETRY_OF]->(b)",
    "run_prune": "MATCH (r:TestRun) WITH r ORDER BY r.started DESC, r.id DESC SKIP $keep DETACH DELETE r",
    "runs": """
        MATCH (r:TestRun) OPTIONAL MATCH (r)-[:RETRY_OF]->(p:TestRun)
        RETURN properties(r) AS run, p.id AS parent ORDER BY r.started DESC, r.id DESC LIMIT $limit""",
    "run": """
        MATCH (r:TestRun {id: $id}) OPTIONAL MATCH (r)-[:RETRY_OF]->(p:TestRun)
        RETURN properties(r) AS run, p.id AS parent""",
    "run_children": "MATCH (c:TestRun)-[:RETRY_OF]->(:TestRun {id: $id}) RETURN c.id AS id ORDER BY c.started",
    "run_results": """
        MATCH (:TestRun {id: $id})-[e:RAN]->(s:Symbol)
        RETURN s.id AS test, s.file AS file, s.line AS line, e.outcome AS outcome, e.seconds AS seconds,
               e.message AS message ORDER BY e.outcome = 'failed' DESC, test LIMIT $limit""",
    "run_suspects": """
        MATCH (:TestRun {id: $id})-[e:SUSPECTS]->(s:Symbol)
        RETURN s.id AS id, s.qname AS name, s.file AS file, s.line AS line, e.rank AS rank, e.score AS score,
               e.hops AS hops ORDER BY e.rank""",
    "test_history": """
        MATCH (r:TestRun)-[e:RAN]->(s:Symbol) WHERE s.id IN $ids
          AND NOT (coalesce(r.trigger, '') = 'heal' AND coalesce(r.heal_step, '') <> 'initial')
        RETURN s.id AS test, r.id AS run, r.started AS started, e.outcome AS outcome
        ORDER BY r.started DESC LIMIT $limit""",
}

# Labels/edges that must never be written to by the guarded "run your own Cypher" escape hatch.
WRITE_CLAUSES = re.compile(r"\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|LOAD\s+CSV|FOREACH)\b|\bCALL\s+db\.idx", re.IGNORECASE)


class GraphUnavailable(RuntimeError):
    """FalkorDB is unreachable or timed out; callers turn this into a 503 / a clear CLI error."""


class QueryRejected(ValueError):
    """A user-supplied query failed the read-only guard."""


# ---- receipts: every query a request ran, with timing, so answers can show their work -----------------------------
_receipts: contextvars.ContextVar[list[dict] | None] = contextvars.ContextVar("aftershock_receipts", default=None)
_stats: dict[str, list[float]] = {}


@contextmanager
def recording():
    token = _receipts.set([])
    try:
        yield _receipts.get()
    finally:
        _receipts.reset(token)


def _note(name: str, ms: float, rows: int) -> None:
    bucket = _stats.setdefault(name, [])
    bucket.append(ms)
    if len(bucket) > 500:
        del bucket[:250]
    rec = _receipts.get()
    if rec is not None and len(rec) < 200:
        rec.append({"query": name, "ms": round(ms, 2), "rows": rows})


def query_stats() -> dict[str, dict]:
    out = {}
    for name, xs in sorted(_stats.items()):
        s = sorted(xs)
        out[name] = {"n": len(s), "p50": round(s[len(s) // 2], 2), "p95": round(s[min(len(s) - 1, int(len(s) * 0.95))], 2)}
    return out


def _plain(v: Any) -> Any:
    """Make FalkorDB result values JSON-safe (OrderedDicts from map projections, nested lists)."""
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    if hasattr(v, "properties"):  # Node / Edge objects from a raw query
        return _plain(dict(v.properties))
    return v


class RepoGraph:
    """One repository's graph. `ro` for reads (GRAPH.RO_QUERY), `rw` for writes; both time, log and retry once."""

    def __init__(self, store: Store, name: str):
        self.store = store
        self.name = name
        self.key = f"repo:{name}"
        self._g = store.db.select_graph(self.key)

    def ro(self, name: str, params: dict | None = None, *, query: str | None = None, timeout: int | None = None):
        try:
            return self._run(name, query or QUERIES[name], params, self._g.ro_query, timeout or self.store.s.query_timeout_ms)
        except GraphUnavailable:
            raise
        except Exception as e:  # a graph that was never written reads as empty, not as an error
            if "empty key" in str(e).lower() or "invalid graph operation on empty key" in str(e).lower():
                return []
            raise

    def rw(self, name: str, params: dict | None = None, *, query: str | None = None, timeout: int | None = None):
        return self._run(name, query or QUERIES[name], params, self._g.query, timeout or self.store.s.write_timeout_ms)

    def batched(self, name: str, rows: list[dict], size: int = 1000, key: str = "rows") -> None:
        for i in range(0, len(rows), size):
            self.rw(name, {key: rows[i : i + size]})

    def _run(self, name, q, params, fn, timeout):
        from redis.exceptions import ConnectionError as RConnErr
        from redis.exceptions import TimeoutError as RTimeout

        t0 = time.perf_counter()
        for attempt in (0, 1):
            try:
                res = fn(q, params or {}, timeout=timeout)
                break
            except (RConnErr, RTimeout, OSError) as e:
                if attempt:
                    raise GraphUnavailable(f"FalkorDB unavailable: {e}") from e
                time.sleep(0.2)
        ms = (time.perf_counter() - t0) * 1000
        cols = [h[1] if isinstance(h, (list, tuple)) else h for h in (res.header or [])]
        rows = [dict(zip(cols, (_plain(v) for v in r), strict=False)) for r in (res.result_set or [])]
        _note(name, ms, len(rows))
        if ms > 1000:
            log.info(json.dumps({"graph": self.key, "query": name, "ms": round(ms), "rows": len(rows)}))
        return rows

    def exists(self) -> bool:
        return self.key in self.store.list_keys()

    def ensure_schema(self) -> None:
        for name in ("idx_file", "idx_symbol_id", "idx_symbol_name", "idx_symbol_file", "idx_external", "idx_person",
                     "idx_testrun", "idx_symbol_text"):
            try:
                self.rw(name)
            except GraphUnavailable:
                raise
            except Exception as e:  # already indexed
                if "already" not in str(e).lower():
                    raise

    def explain_guard(self, cypher: str) -> None:
        """Reject anything that is not a bounded read. Used by the `cypher` tool only; our own QUERIES are trusted."""
        if WRITE_CLAUSES.search(cypher):
            raise QueryRejected("only read queries are allowed")
        for m in re.finditer(r"\*\s*(\d*)\s*\.\.\s*(\d*)", cypher):
            hi = m.group(2)
            if not hi or int(hi) > self.store.s.max_depth:
                raise QueryRejected(f"variable-length patterns must be bounded to *..{self.store.s.max_depth}")
        if re.search(r"\[[^\]]*\*\s*\]", cypher):
            raise QueryRejected(f"unbounded variable-length pattern; use *1..{self.store.s.max_depth}")
        try:
            self._g.explain(cypher)
        except Exception as e:
            raise QueryRejected(f"invalid query: {e}") from e

    def user_query(self, cypher: str, params: dict | None = None) -> list[dict]:
        self.explain_guard(cypher)
        cap = self.store.s.max_rows
        cypher = cypher.strip().rstrip(";").rstrip()
        m = re.search(r"\bLIMIT\s+(\d+)$", cypher, re.IGNORECASE)
        if not m:
            cypher = f"{cypher} LIMIT {cap}"
        elif int(m.group(1)) > cap:  # a huge trailing LIMIT is clamped, not trusted
            cypher = f"{cypher[: m.start()]}LIMIT {cap}"
        return self.ro("user_query", params, query=cypher)[:cap]

    def path_query(self, src: str, dst: str, depth: int) -> list[dict]:
        depth = max(1, min(int(depth), self.store.s.max_depth + 2))
        return self.ro("path", {"src": src, "dst": dst}, query=QUERIES["path"].replace("{depth}", str(depth)))

    def file_path_query(self, src: str, dst: str, depth: int) -> list[dict]:
        depth = max(1, min(int(depth), 12))
        return self.ro("file_path", {"src": src, "dst": dst}, query=QUERIES["file_path"].replace("{depth}", str(depth)))

    def delete(self) -> None:
        try:
            self._g.delete()
        except Exception as e:
            if "empty key" not in str(e).lower():
                raise


class Store:
    """The FalkorDB connection plus repo-level bookkeeping (listing, events)."""

    _PUBLISH = """
        local seq = redis.call('INCR', KEYS[1])
        redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '0-' .. seq, 'data', ARGV[1])
        return seq"""

    def __init__(self, url: str | None = None):
        self.s = get_settings()
        self.url = url or self.s.falkordb_url
        self._db = None

    @property
    def db(self):
        if self._db is None:
            from falkordb import FalkorDB

            try:
                self._db = FalkorDB.from_url(
                    self.url, socket_timeout=self.s.socket_timeout_s, socket_connect_timeout=5
                )
            except Exception as e:
                raise GraphUnavailable(f"FalkorDB unavailable: {e}") from e
        return self._db

    @property
    def redis(self):
        return self.db.connection

    def repo(self, name: str) -> RepoGraph:
        if not NAME_RE.match(name):
            raise ValueError(f"invalid repo name {name!r}")
        return RepoGraph(self, name)

    def list_keys(self) -> list[str]:
        try:
            return list(self.db.list_graphs())
        except Exception as e:
            raise GraphUnavailable(f"FalkorDB unavailable: {e}") from e

    def list_repos(self, include_lab: bool = False) -> list[str]:
        names = sorted(k[5:] for k in self.list_keys() if k.startswith("repo:"))
        if include_lab:
            return names
        lab = self.lab_repos()
        return [n for n in names if n not in lab]

    LAB_KEY = "aftershock:lab"

    def lab_repos(self) -> set[str]:
        """Benchmark graphs (eval clones, reference repos): kept for `aftershock eval`, hidden from listings."""
        try:
            return {m.decode() if isinstance(m, bytes) else m for m in self.redis.smembers(self.LAB_KEY)}
        except RedisError:
            return set()

    def set_lab(self, name: str, on: bool) -> None:
        if on:
            self.redis.sadd(self.LAB_KEY, name)
        else:
            self.redis.srem(self.LAB_KEY, name)

    def ping(self) -> bool:
        # GraphUnavailable as well as the socket errors: `self.redis` goes through
        # the `db` property, which turns a *first* failed connection into
        # GraphUnavailable rather than a RedisError. Letting that escape would
        # make `/api/v1/health` throw a 500 in precisely the case it exists to
        # report cleanly — FalkorDB not up yet. The contract is a bool; keep it.
        try:
            return bool(self.redis.ping())
        except (RedisError, OSError, GraphUnavailable):
            return False

    def publish(self, repo: str, event: dict, maxlen: int = 2000) -> int:
        data = json.dumps({**event, "ts": time.time()}, default=str)
        try:
            return int(self.redis.eval(self._PUBLISH, 2, f"seq:{repo}", f"events:{repo}", data, maxlen))
        except RedisError as e:  # events are best-effort; never fail an index because the feed hiccuped
            log.warning("publish failed: %s", e)
            return 0

    def event_cursor(self, repo: str) -> int:
        """The last published seq: subscribe after it to see only what happens from now on."""
        try:
            return int(self.redis.get(f"seq:{repo}") or 0)
        except (RedisError, ValueError):
            return 0

    def events(self, repo: str, after: int = 0, block_ms: int | None = None, count: int = 100) -> list[dict]:
        key = f"events:{repo}"
        try:
            if block_ms:
                res = self.redis.xread({key: f"0-{after}"}, count=count, block=block_ms) or []
                entries = res[0][1] if res else []
            else:
                entries = self.redis.xrange(key, min=f"0-{after + 1}", max="+", count=count)
        except RedisError as e:
            log.warning("events read failed: %s", e)
            return []
        out = []
        for eid, fields in entries:
            eid = eid.decode() if isinstance(eid, bytes) else eid
            raw = fields.get(b"data") or fields.get("data")
            try:
                ev = json.loads(raw)
            except (TypeError, ValueError):
                continue
            ev["seq"] = int(eid.split("-")[1])
            out.append(ev)
        return out

    def drop_repo(self, name: str) -> None:
        self.repo(name).delete()
        with suppress(RedisError):
            self.redis.delete(f"seq:{name}", f"events:{name}")
            self.redis.srem(self.LAB_KEY, name)


@lru_cache
def get_store() -> Store:
    return Store()
