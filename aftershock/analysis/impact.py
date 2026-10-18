"""The Aftershock simulator: given what changed, which code is likely to break, how likely, and why.

Reverse BFS over CALLS / INHERITS / IMPLEMENTS from the changed symbols ("seeds"), one hop per graph query, plus two
kinds of polymorphism: DISPATCH (callers of a method an impacted method overrides: a call bound to Base.m can run
Child.m) and OVERRIDES (methods redefining a seed whose contract changed: they must keep a compatible signature). Each
dependent gets a break probability combined noisy-OR over the parents that reach it at the same hop:

    contribution = p(parent) * edge_weight(type) * edge_confidence * (transmit, unless the parent is a seed)
    p(node)      = 1 - prod(1 - contribution)

and keeps the strongest contribution as its *evidence path*: every row in the answer can be traced back to a seed
through concrete edges with file:line call sites. When a seed's arity changed, direct callers are judged against the
argument counts recorded at their call sites ("passes 2 args; now requires 3") instead of the generic prior.

Deterministic: same graph + same seeds = same answer. Potentially impacted is not the same as broken; the output
says so, and every number comes from weights.json.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from functools import lru_cache
from itertools import pairwise
from pathlib import Path

from ..graph import RepoGraph, get_store

WEIGHTS_PATH = Path(__file__).with_name("weights.json")
CHANGES = ("delete", "rename", "signature", "body", "added")


@lru_cache
def weights() -> dict:
    return json.loads(WEIGHTS_PATH.read_text())


@dataclass
class Seed:
    id: str
    change: str = "body"  # delete | rename | signature | body | added
    min_args: int | None = None  # the new arity, when the signature changed
    max_args: int | None = None
    note: str = ""
    changed_files: frozenset[str] = frozenset()  # files edited in the same change (their call sites may be updated)


@dataclass
class _Node:
    id: str
    p: float
    hop: int
    parent: str | None = None
    edge: dict | None = None
    verdict: str = ""
    contributions: list[float] = field(default_factory=list)


def tier(p: float) -> str:
    t = weights()["tiers"]
    return "definite" if p >= t["definite"] else "likely" if p >= t["likely"] else "possible"


def _arity_verdict(seed: Seed, args_seen: list[int]) -> tuple[bool | None, str]:
    """True = some recorded call site no longer fits the new signature; False = all fit; None = unknown."""
    if seed.min_args is None or not args_seen:
        return None, ""
    known = [a for a in args_seen if a >= 0]
    if not known:
        return None, "call site uses spread/keyword arguments; arity not checkable"
    hi = seed.max_args if seed.max_args is not None else -1
    bad = [a for a in known if a < seed.min_args or (hi != -1 and a > hi)]
    want = f"{seed.min_args}" if hi == seed.min_args else f"{seed.min_args}..{'∞' if hi == -1 else hi}"
    if bad:
        return True, f"passes {bad[0]} arg{'s' if bad[0] != 1 else ''}; new signature takes {want}"
    return False, f"passes {', '.join(map(str, sorted(set(known))))} arg(s); still fits {want}"


def _override_verdict(seed: Seed, r: dict) -> tuple[bool | None, str]:
    """What a changed base method means for a method that overrides it: (broken?, why). None = not checkable."""
    if seed.change in ("delete", "rename"):
        return None, f"overrides a method that was {seed.change}d; it no longer overrides anything"
    lo, hi = r.get("min_args"), r.get("max_args")
    if seed.min_args is None or lo is None:
        return None, "overrides it; its signature must stay compatible"
    hi = -1 if hi is None else hi
    new_hi = seed.max_args if seed.max_args is not None else -1
    accepts = lo <= seed.min_args and (hi == -1 or (new_hi != -1 and hi >= new_hi))
    have = f"{lo}" if hi == lo else f"{lo}..{'∞' if hi == -1 else hi}"
    want = f"{seed.min_args}" if new_hi == seed.min_args else f"{seed.min_args}..{'∞' if new_hi == -1 else new_hi}"
    if accepts:
        return False, f"override still accepts the new arguments (takes {have}; base now takes {want})"
    return True, f"override takes {have}; base now takes {want}"


def simulate(g: RepoGraph, seeds: list[Seed], *, depth: int | None = None, min_p: float | None = None) -> dict:
    W = weights()
    s = g.store.s
    depth = max(1, min(depth or s.max_depth, s.max_depth))
    min_p = W["min_p"] if min_p is None else min_p
    nodes: dict[str, _Node] = {}
    seed_by_id: dict[str, Seed] = {}
    for sd in seeds:
        if sd.change not in CHANGES:
            raise ValueError(f"unknown change kind {sd.change!r}; expected one of {CHANGES}")
        seed_by_id[sd.id] = sd
        nodes[sd.id] = _Node(sd.id, W["seed"][sd.change], 0, verdict=sd.note)
    # Deleting or renaming a class takes its members with it.
    for sd in list(seeds):
        if sd.change in ("delete", "rename"):
            for r in g.ro("children", {"ids": [sd.id]}):
                if r["id"] not in nodes:
                    child = Seed(r["id"], sd.change, note=f"member of {sd.id.split('::')[-1]}")
                    seed_by_id[child.id] = child
                    nodes[child.id] = _Node(child.id, W["seed"][sd.change], 0, verdict=child.note)
    frontier = sorted(i for i, n in nodes.items() if n.p > 0)
    truncated = False
    hops_run = 0
    for hop in range(1, depth + 1):
        if not frontier:
            break
        hops_run = hop
        incoming: dict[str, list[tuple[float, str, dict, str]]] = {}

        def add(r: dict, typ: str, conf: float, extra: dict | None = None, hop: int = hop, incoming: dict = incoming) -> None:
            src, dst = r["src"], r["dst"]
            if src in nodes and nodes[src].hop < hop:
                return  # already settled at an earlier hop (and seeds never re-enter)
            parent = nodes[dst]
            w = W["edge"].get(typ, 0.5) * conf
            verdict = ""
            sd = seed_by_id.get(dst)
            if typ == "OVERRIDES":  # only queried for seeds whose contract changed (weights.json "override")
                broken, verdict = _override_verdict(sd, r)
                base = W["arity_break"] if broken is True else W["arity_ok"] if broken is False else W["override"][sd.change]
                if src.split("::", 1)[0] in sd.changed_files:
                    base *= W["caller_also_changed"]
                    verdict += "; its file is part of this change"
            elif sd is not None:
                base = parent.p
                if typ in ("CALLS", "DISPATCH") and sd.change == "signature":
                    broken, verdict = _arity_verdict(sd, r.get("args") or [])
                    if broken is True:
                        base = W["arity_break"]
                    elif broken is False:
                        base = W["arity_ok"]
                if src.split("::", 1)[0] in sd.changed_files:
                    base *= W["caller_also_changed"]
                    verdict = (verdict + "; " if verdict else "") + "caller's file is part of this change"
            else:
                base = parent.p * W["transmit"]
            edge = {"type": typ, "how": r["how"], "confidence": round(conf, 4),
                    "lines": (r.get("lines") or [])[:5], "args": r.get("args") or [], **(extra or {})}
            incoming.setdefault(src, []).append((base * w, dst, edge, verdict))

        for i in range(0, len(frontier), 500):
            ids = frontier[i : i + 500]
            for r in g.ro("dependents", {"ids": ids, "limit": 50_000}):
                add(r, r["type"], float(r["confidence"] or 0.5))
            # a call bound to a method this one overrides can run this one instead
            for r in g.ro("dispatch_callers", {"ids": ids, "limit": 50_000}):
                add(r, "DISPATCH", float(r["confidence"] or 0.5) * min(float(c or 0.5) for c in r["confs"]),
                    {"via": r["via"]})
            changed_contract = [x for x in ids if x in seed_by_id and W["override"].get(seed_by_id[x].change, 0) > 0]
            if changed_contract:
                for r in g.ro("overriders", {"ids": changed_contract, "limit": 50_000}):
                    add(r, "OVERRIDES", float(r["confidence"] or 0.5))
        new = []
        for src in sorted(incoming):
            contribs = incoming[src]
            p = 1.0 - math.prod(1.0 - min(c, 0.999) for c, *_ in contribs)
            c, dst, edge, verdict = max(contribs, key=lambda x: (x[0], x[1]))
            if p < min_p:
                continue
            nodes[src] = _Node(src, round(p, 4), hop, dst, edge, verdict, [round(x[0], 4) for x in contribs])
            new.append(src)
        new.sort(key=lambda i: (-nodes[i].p, i))
        budget = W["max_nodes"] - (len(nodes) - len(new))  # room left before this hop's nodes were added
        if budget <= 0 or len(new) > budget:
            truncated = True
            for i in new[max(budget, 0):]:
                del nodes[i]
            new = new[: max(budget, 0)]
        frontier = sorted(new)
        if truncated:
            break
    return _report(g, nodes, seed_by_id, hops_run, depth, truncated)


def _path(nodes: dict[str, _Node], nid: str) -> list[str]:
    out, cur, guard = [], nid, 0
    while cur is not None and guard < 64:
        out.append(cur)
        cur = nodes[cur].parent if cur in nodes else None
        guard += 1
    return out[::-1]  # seed first


def _symbols(g: RepoGraph, ids: list[str]) -> dict[str, dict]:
    out = {}
    for i in range(0, len(ids), 1000):
        for r in g.ro("symbols_by_ids", {"ids": ids[i : i + 1000]}):
            out[r["symbol"]["id"]] = r["symbol"]
    return out


def _label(sym: dict | None, sid: str) -> str:
    """Display name; the `#2` that keeps overloads apart in ids is dropped (the id still names the exact def)."""
    if not sym:
        return re.sub(r"#\d+(?=$|\.)", "", sid.split("::")[-1])
    q = sym.get("qname", "")
    return sym["file"].rsplit("/", 1)[-1] if q == "<module>" else re.sub(r"#\d+(?=$|\.)", "", q)


def _report(g: RepoGraph, nodes: dict[str, _Node], seeds: dict[str, Seed], hops_run: int, depth: int,
            truncated: bool) -> dict:
    W = weights()
    syms = _symbols(g, sorted(nodes))
    impacted, tests = [], []
    for nid, n in sorted(nodes.items(), key=lambda kv: (-kv[1].p, kv[1].hop, kv[0])):
        if n.hop == 0:
            continue
        sym = syms.get(nid) or {"id": nid, "file": nid.split("::")[0], "qname": nid.split("::")[-1]}
        chain = _path(nodes, nid)
        steps = []
        for a, b in pairwise(chain):
            e = nodes[b].edge or {}
            sb = syms.get(b, {})
            steps.append({
                "from": a, "to": b, "label": _label(sb, b), "type": e.get("type"), "how": e.get("how"),
                "confidence": e.get("confidence"), "file": sb.get("file"), "lines": e.get("lines", []),
                "verdict": nodes[b].verdict, **({"via": e["via"]} if e.get("via") else {}),
            })
        is_test = bool(sym.get("is_test")) or (sym.get("qname") == "<module>" and _is_test_file(sym.get("file", "")))
        row = {
            "id": nid, "name": _label(sym, nid), "kind": sym.get("kind"), "file": sym.get("file"),
            "line": sym.get("line"), "p": n.p, "tier": tier(n.p), "hop": n.hop, "is_test": is_test,
            "via": len(n.contributions), "seed": chain[0], "path": steps, "verdict": n.verdict,
            "pagerank": sym.get("pagerank") or 0,
        }
        (tests if is_test else impacted).append(row)

    seed_rows = []
    for sid, sd in seeds.items():
        sym = syms.get(sid, {})
        seed_rows.append({"id": sid, "name": _label(sym, sid), "change": sd.change, "file": sym.get("file") or sid.split("::")[0],
                          "line": sym.get("line"), "kind": sym.get("kind"), "note": sd.note,
                          "pagerank": sym.get("pagerank") or 0, "found": bool(sym),
                          "stub": "overload" in str(sym.get("decorators") or "")})

    files: dict[str, dict] = {}
    for r in impacted + tests:
        f = files.setdefault(r["file"], {"file": r["file"], "p": 0.0, "symbols": 0, "tests": 0, "min_hop": 99})
        f["p"] = max(f["p"], r["p"])
        f["symbols"] += 1
        f["tests"] += int(r["is_test"])
        f["min_hop"] = min(f["min_hop"], r["hop"])
    file_rows = sorted(files.values(), key=lambda f: (-f["p"], f["file"]))

    # Which seeds does at least one impacted test reach? The rest are changes no test exercises.
    covered = {t["seed"] for t in tests} | {st["from"] for t in tests for st in t["path"]}
    # `@overload` stubs never run, so they are not "untested"; their implementation (also a seed) is what tests reach.
    untested = [s for s in seed_rows if s["id"] not in covered and s["change"] != "added" and not s["stub"]]
    seed_files = sorted({s["file"] for s in seed_rows})
    hit_files = set(files) | set(seed_files)
    hidden = [r for r in g.ro("cochanged_with", {"paths": seed_files, "limit": 30}) if r["path"] not in hit_files][:10]
    # Files that import a changed file but have no resolved symbol edge to the change: a call that never resolved
    # (a local alias, an untyped receiver) still breaks them. Reported apart from the probabilities, unscored.
    import_only = [r for r in g.ro("importers_of", {"paths": seed_files, "limit": 400})
                   if r["file"] not in hit_files][:30]
    owners = g.ro("owners", {"paths": sorted(hit_files)[:400], "limit": 8}) if hit_files else []

    top_pr = g.ro("central", {"limit": 1})
    max_pr = float(top_pr[0]["pagerank"]) if top_pr else 0.0
    centrality = max((s["pagerank"] for s in seed_rows), default=0) / max_pr if max_pr else 0.0
    definite = sum(1 for r in impacted if r["tier"] == "definite")
    breadth = sum(r["p"] for r in impacted)
    R = W["risk"]
    code_files = len([f for f in file_rows if f["tests"] < f["symbols"]])
    x = (R["breadth"] * math.log1p(breadth) + R["files"] * math.log1p(code_files) + R["centrality"] * centrality
         + R["untested"] * (len(untested) / max(len(seed_rows), 1)) + R["definite"] * math.log1p(definite))
    score = round(100 * (1 - math.exp(-x)))
    level = "critical" if score >= 80 else "high" if score >= 60 else "medium" if score >= 30 else "low"
    return {
        "seeds": seed_rows,
        "impacted": impacted,
        "tests": tests,
        "files": file_rows,
        "untested_seeds": untested,
        "hidden_coupling": hidden,
        "import_only": import_only,
        "owners": owners,
        "risk": {
            "score": score, "level": level,
            "components": {"expected_breakages": round(breadth, 2), "definite": definite,
                           "files": len(file_rows), "seed_centrality": round(centrality, 3),
                           "untested_seeds": len(untested)},
        },
        "counts": {"impacted": len(impacted), "tests": len(tests), "files": len(file_rows),
                   "definite": definite, "likely": sum(1 for r in impacted if r["tier"] == "likely"),
                   "possible": sum(1 for r in impacted if r["tier"] == "possible")},
        "hops": hops_run, "max_depth": depth, "truncated": truncated,
        "model": {k: W[k] for k in ("seed", "edge", "transmit", "min_p")},
        "note": "Potentially impacted is not the same as broken: probabilities are priors from weights.json applied "
                "to statically resolved edges. Dynamic dispatch, reflection and string-built calls are not seen.",
    }


def _is_test_file(path: str) -> bool:
    from ..ingest.parse import is_test_path, lang_for

    lang = lang_for(path)
    return bool(lang and is_test_path(path, lang))


def impact_of(repo: str, refs: list[str], change: str = "body", depth: int | None = None) -> dict:
    """Convenience for tools: resolve human references, then simulate."""
    from .lookup import find

    g = get_store().repo(repo)
    seeds, problems = [], []
    for ref in refs:
        m = find(g, ref)
        if m.ok:
            seeds += [Seed(i, change) for i in m.ids]
        else:
            problems.append({"ref": ref, "error": m.error, "candidates": m.candidates})
    if not seeds:
        return {"error": "no symbols matched", "problems": problems}
    out = simulate(g, seeds, depth=depth)
    out["problems"] = problems
    return out
