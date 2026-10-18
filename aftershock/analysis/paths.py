""""How does A reach B?" — the shortest dependency chain between two symbols, every hop with its evidence."""

from __future__ import annotations

from ..graph import RepoGraph
from .lookup import find


def _steps(g: RepoGraph, ids: list[str], rels: list[dict]) -> list[dict]:
    syms = {r["symbol"]["id"]: r["symbol"] for r in g.ro("symbols_by_ids", {"ids": ids})}
    nodes = [{"id": i, "name": syms.get(i, {}).get("qname", i.split("::")[-1]), "file": syms.get(i, {}).get("file"),
              "line": syms.get(i, {}).get("line"), "kind": syms.get(i, {}).get("kind")} for i in ids]
    return [{"from": nodes[k], "to": nodes[k + 1], **rels[k]} for k in range(len(rels))]


def explain(g: RepoGraph, a: str, b: str, depth: int = 8) -> dict:
    ma, mb = find(g, a), find(g, b)
    # An ambiguous name is fine here: the path itself picks the candidate that actually connects.
    ia = ma.ids if ma.ok else [c["id"] for c in ma.candidates]
    ib = mb.ids if mb.ok else [c["id"] for c in mb.candidates]
    if not ia or not ib:
        return {"error": "could not resolve both ends",
                "from": {"ref": a, "error": ma.error, "candidates": ma.candidates},
                "to": {"ref": b, "error": mb.error, "candidates": mb.candidates}}
    best = None
    for src in ia[:5]:
        for dst in ib[:5]:
            for direction, (x, y) in (("forward", (src, dst)), ("reverse", (dst, src))):
                rows = g.path_query(x, y, depth)
                if rows and (best is None or len(rows[0]["rels"]) < len(best[1]["rels"])):
                    best = (direction, rows[0])
            if best and best[0] == "forward":
                break
    if best:
        direction, row = best
        steps = _steps(g, row["ids"], row["rels"])
        conf = 1.0
        for s in steps:
            conf *= float(s.get("confidence") or 0.5)
        return {
            "found": True, "direction": direction, "hops": len(steps), "confidence": round(conf, 3), "steps": steps,
            "summary": ("{} depends on {}" if direction == "forward" else "{} is depended on by {}").format(a, b)
                       + f" in {len(steps)} hop{'s' if len(steps) != 1 else ''} (path confidence {conf:.2f})",
        }
    fa = {i.split("::")[0] for i in ia[:5]}
    fb = {i.split("::")[0] for i in ib[:5]}
    for x in sorted(fa):
        for y in sorted(fb):
            if x == y:
                continue
            for direction, (p, q) in (("forward", (x, y)), ("reverse", (y, x))):
                rows = g.file_path_query(p, q, 10)
                if rows:
                    return {"found": True, "level": "file", "direction": direction, "files": rows[0]["ids"],
                            "summary": f"no symbol-level path within {depth} hops, but the files are linked by imports"}
    co = g.ro("cochanged_with", {"paths": sorted(fa), "limit": 50})
    coupled = [r for r in co if r["path"] in fb]
    return {"found": False, "summary": f"no static dependency path within {depth} hops in either direction",
            "cochange": coupled[:3]}
