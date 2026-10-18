"""Turn what a person or an agent types ("EnvGraph.ro", "api/graph.py::ro", "get_settings", "api/graph.py") into graph ids.

Never guesses silently: an ambiguous name returns every candidate, ranked, and the caller decides (the API returns
them as choices, the agent asks, the CLI prints them).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..graph import RepoGraph


@dataclass
class Match:
    ids: list[str] = field(default_factory=list)  # resolved symbol ids
    candidates: list[dict] = field(default_factory=list)  # when ambiguous
    file: str | None = None  # the reference named a file
    error: str | None = None

    @property
    def ok(self) -> bool:
        return bool(self.ids) and not self.error


def _rank(row: dict, q: str) -> tuple:
    name, qname = row["name"].lower(), row["qname"].lower()
    exact = 0 if q in (name, qname) else 1 if qname.endswith("." + q) else 2
    return (exact, bool(row.get("is_test")), -float(row.get("pagerank") or 0), -int(row.get("fan_in") or 0), row["id"])


def search(g: RepoGraph, q: str, limit: int = 20) -> list[dict]:
    q = q.strip().lower()
    if not q:
        return []
    rows = g.ro("search", {"q": q})
    rows.sort(key=lambda r: _rank(r, q))
    return rows[:limit]


def find(g: RepoGraph, ref: str) -> Match:
    ref = ref.strip()
    if not ref:
        return Match(error="empty reference")
    if "::" in ref:
        rows = g.ro("symbol", {"id": ref})
        if rows:
            return Match(ids=_overloads(g, ref))
        path, _, name = ref.partition("::")
        rows = [r for r in g.ro("symbols_in_files", {"paths": [path]})
                if r["symbol"]["qname"] == name or r["symbol"]["name"] == name]
        if len(rows) == 1:
            return Match(ids=_overloads(g, rows[0]["symbol"]["id"]))
        if rows:
            return Match(candidates=[_brief(r["symbol"]) for r in rows])
        return Match(error=f"no symbol {ref!r}")
    if "/" in ref or "." in ref:
        rows = g.ro("file", {"path": ref})
        if rows and rows[0]["file"]:
            syms = [s for s in rows[0]["symbols"] if s and s.get("kind") != "module"]
            top = [s["id"] for s in syms if "." not in s["qname"]] or [s["id"] for s in syms]
            return Match(ids=top or [f"{ref}::<module>"], file=ref)
    hits = search(g, ref, 25)
    q = ref.lower()
    exact = [h for h in hits if q in (h["name"].lower(), h["qname"].lower())]
    if len(exact) == 1:
        return Match(ids=_overloads(g, exact[0]["id"]))
    nontest = [h for h in exact if not h.get("is_test")]
    if len(nontest) == 1:
        return Match(ids=_overloads(g, nontest[0]["id"]))
    if exact or hits:
        return Match(candidates=[_brief(h) for h in (exact or hits)[:15]])
    return Match(error=f"nothing in the graph matches {ref!r}")


def _overloads(g: RepoGraph, sid: str) -> list[str]:
    """A symbol plus its same-scope redefinitions (`@overload` stubs and the implementation, ids `x`, `x#2`, ...).
    Calls bind to the implementation, so a change to "the" function has to start from all of them."""
    base = re.sub(r"#\d+$", "", sid)
    rows = g.ro("symbols_by_ids", {"ids": [base] + [f"{base}#{k}" for k in range(2, 13)]})
    ids = [r["symbol"]["id"] for r in rows]
    return ids if sid in ids else [sid, *ids]


def _brief(s: dict) -> dict:
    return {k: s.get(k) for k in ("id", "name", "qname", "kind", "file", "line", "is_test")}
