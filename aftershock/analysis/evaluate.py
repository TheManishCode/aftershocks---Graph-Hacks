"""Replay real commits against the graph and measure how well the simulator predicts what else had to change.

For every recent non-merge commit, each changed source file in turn is the *anchor*: its symbols that the commit
changed (classified by digest, exactly as `diff.detect` does) become seeds, and the simulator's predicted files are
compared with the other source files the same commit touched. A signature change whose callers were edited in the
same commit is the closest thing to ground-truth breakage that history offers; body changes are a weaker signal.

Honest about its limits:
- one graph (the indexed HEAD) stands in for every past state, so a seed that no longer exists is skipped, and edges
  added after the commit can make a prediction look better than it was at the time;
- co-changed is not the same as broken: a commit can bundle unrelated edits (lowers precision) and a caller can be
  broken without being fixed in the same commit (lowers recall);
- only static impact is scored. The graph's co-change coupling is mined from this same history, so it is left out.

The baseline predicts every indexed file in the anchor's directory. If the simulator does not beat that, the
weights need tuning for this repository.
"""

from __future__ import annotations

import subprocess
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from ..graph import RepoGraph
from ..ingest.model import MODULE, Def, sym_id
from ..ingest.parse import is_test_path, lang_for, parse_file
from .impact import Seed, simulate

TIERS = ("definite", "likely", "possible")


@dataclass
class Score:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    cases: int = 0
    any_hit: int = 0

    def add(self, predicted: set[str], truth: set[str]) -> None:
        hit = len(predicted & truth)
        self.tp += hit
        self.fp += len(predicted) - hit
        self.fn += len(truth) - hit
        self.cases += 1
        self.any_hit += int(hit > 0)

    def as_dict(self) -> dict:
        p = self.tp / (self.tp + self.fp) if self.tp + self.fp else 0.0
        r = self.tp / (self.tp + self.fn) if self.tp + self.fn else 0.0
        f1 = 2 * p * r / (p + r) if p + r else 0.0
        return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f1, 3), "cases": self.cases,
                "hit_rate": round(self.any_hit / self.cases, 3) if self.cases else 0.0,
                "tp": self.tp, "fp": self.fp, "fn": self.fn}


@dataclass
class Eval:
    commits_seen: int = 0
    commits_used: int = 0
    skipped: Counter = field(default_factory=Counter)
    scores: dict[str, Score] = field(default_factory=dict)
    examples: list[dict] = field(default_factory=list)

    def score(self, key: str) -> Score:
        return self.scores.setdefault(key, Score())


def _git(root: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=60, check=True).stdout


def _show(root: Path, rev: str, path: str) -> bytes | None:
    try:
        return _git(root, "show", f"{rev}:{path}")
    except subprocess.CalledProcessError:
        return None


def _defs(path: str, data: bytes | None) -> dict[str, Def]:
    if data is None:
        return {}
    return {d.qname: d for d in parse_file(path, data).defs if d.qname != MODULE}


def changed_symbols(path: str, before: bytes | None, after: bytes | None) -> list[tuple[str, str, Def | None]]:
    """(qname, change, new def) for symbols that existed before and changed; additions cannot break anything."""
    old, new = _defs(path, before), _defs(path, after)
    out = []
    for q, o in old.items():
        n = new.get(q)
        if n is None:
            out.append((q, "delete", None))
        elif n.sig_digest != o.sig_digest:
            out.append((q, "signature", n))
        elif n.digest != o.digest:
            out.append((q, "body", n))
    return out


def _is_test(path: str) -> bool:
    lang = lang_for(path)
    return bool(lang and is_test_path(path, lang))


def _commits(root: Path, rev: str, limit: int) -> list[str]:
    out = _git(root, "log", "--no-merges", "--format=%H", f"-n{limit}", rev).decode().split()
    return [c for c in out if c]


def _files(root: Path, commit: str) -> list[str]:
    raw = _git(root, "diff-tree", "--no-commit-id", "-r", "--no-renames", "--name-only", "-z", f"{commit}^", commit)
    return sorted({p for p in raw.decode("utf-8", "replace").split("\0") if p and lang_for(p)})


def evaluate(g: RepoGraph, root: Path, *, commits: int = 200, rev: str = "HEAD", depth: int | None = 3,
             max_files: int = 12, max_seeds: int = 40, progress=None) -> dict:
    indexed = {r["path"] for r in g.ro("file_index")}
    by_dir: dict[str, set[str]] = {}
    for p in indexed:
        by_dir.setdefault(p.rsplit("/", 1)[0] if "/" in p else "", set()).add(p)
    known: dict[str, bool] = {}

    def exists(ids: list[str]) -> set[str]:
        ask = [i for i in ids if i not in known]
        for i in range(0, len(ask), 1000):
            found = {r["symbol"]["id"] for r in g.ro("symbols_by_ids", {"ids": ask[i : i + 1000]})}
            known.update({x: x in found for x in ask[i : i + 1000]})
        return {i for i in ids if known[i]}

    ev = Eval()
    shas = _commits(root, rev, commits)
    for n, commit in enumerate(shas, 1):
        ev.commits_seen += 1
        if progress and n % 25 == 0:
            progress("eval", {"done": n, "total": len(shas)})
        try:
            files = _files(root, commit)
        except subprocess.CalledProcessError:
            ev.skipped["root commit"] += 1
            continue
        files = [f for f in files if f in indexed]
        if len(files) < 2:
            ev.skipped["fewer than 2 indexed files"] += 1
            continue
        if len(files) > max_files:
            ev.skipped[f"more than {max_files} files (bulk edit)"] += 1
            continue
        used = False
        for anchor in files:
            changes = changed_symbols(anchor, _show(root, f"{commit}^", anchor), _show(root, commit, anchor))
            changes = [c for c in changes if c[1] != "delete"]  # gone from HEAD too, usually: nothing to seed
            if not changes or len(changes) > max_seeds:
                ev.skipped["anchor: no seeds" if not changes else "anchor: too many seeds"] += 1
                continue
            live = exists([sym_id(anchor, q) for q, *_ in changes])
            seeds = [Seed(sym_id(anchor, q), ch, d.min_args if d and ch == "signature" else None,
                          d.max_args if d and ch == "signature" else None)
                     for q, ch, d in changes if sym_id(anchor, q) in live]
            if not seeds:
                ev.skipped["anchor: seeds no longer in graph"] += 1
                continue
            truth = set(files) - {anchor}
            res = simulate(g, seeds, depth=depth)
            rows = res["impacted"] + res["tests"]
            kind = "signature" if any(s.change == "signature" for s in seeds) else "body"
            for i, t in enumerate(TIERS):
                predicted = {r["file"] for r in rows if r["tier"] in TIERS[: i + 1]} - {anchor}
                ev.score(f"{t}+").add(predicted, truth)
                if t == "possible":
                    ev.score(f"by_change:{kind}").add(predicted, truth)
                    for part, pick in (("tests", True), ("code", False)):
                        sub = {f for f in truth if _is_test(f) == pick}
                        if sub:
                            ev.score(f"by_truth:{part}").add({f for f in predicted if _is_test(f) == pick}, sub)
                    if len(ev.examples) < 15 and predicted & truth:
                        ev.examples.append({"commit": commit[:10], "anchor": anchor, "seeds": len(seeds),
                                            "hits": sorted(predicted & truth)[:5], "missed": sorted(truth - predicted)[:5]})
            # the product's file-level fallback: importers of the anchor with no resolved edge to the change
            all_rows = {r["file"] for r in rows} | {r["file"] for r in res.get("import_only", [])}
            ev.score("variant:+importers").add(all_rows - {anchor}, truth)
            d = anchor.rsplit("/", 1)[0] if "/" in anchor else ""
            ev.score("baseline:same_dir").add(by_dir.get(d, set()) - {anchor}, truth)
            used = True
        ev.commits_used += int(used)

    tiers = {k[:-1]: ev.scores[k].as_dict() for k in (f"{t}+" for t in TIERS) if k in ev.scores}
    return {
        "commits": {"seen": ev.commits_seen, "used": ev.commits_used, "skipped": dict(ev.skipped)},
        "tiers": tiers,
        "by_change": {k.split(":", 1)[1]: v.as_dict() for k, v in ev.scores.items() if k.startswith("by_change:")},
        "by_truth": {k.split(":", 1)[1]: v.as_dict() for k, v in ev.scores.items() if k.startswith("by_truth:")},
        "variants": {k.split(":", 1)[1]: v.as_dict() for k, v in ev.scores.items() if k.startswith("variant:")},
        "baseline": {k.split(":", 1)[1]: v.as_dict() for k, v in ev.scores.items() if k.startswith("baseline:")},
        "examples": ev.examples,
        "settings": {"rev": rev, "commits": commits, "depth": depth, "max_files": max_files, "max_seeds": max_seeds},
        "note": "Ground truth is the other source files each commit touched; tiers are cumulative (likely = definite + "
                "likely). One graph (the indexed HEAD) stands in for every past state. See analysis/evaluate.py.",
    }


def render(res: dict) -> str:
    c = res["commits"]
    lines = [f"Replayed {c['used']} of {c['seen']} commits (skipped: "
             + (", ".join(f"{v} {k}" for k, v in sorted(c["skipped"].items())) or "none") + ")", "",
             f"{'predictor':<22}{'cases':>7}{'precision':>11}{'recall':>8}{'f1':>7}{'hit rate':>10}"]
    rows = [(f"simulator ≥{t}", s) for t, s in res["tiers"].items()]
    rows += [(f"  {k} seeds", s) for k, s in sorted(res["by_change"].items())]
    rows += [(f"  {k} files only", s) for k, s in sorted(res["by_truth"].items())]
    rows += [(f"simulator {k}", s) for k, s in res["variants"].items()]
    rows += [(f"baseline {k}", s) for k, s in res["baseline"].items()]
    for name, s in rows:
        lines.append(f"{name:<22}{s['cases']:>7}{s['precision']:>11.3f}{s['recall']:>8.3f}{s['f1']:>7.3f}{s['hit_rate']:>10.3f}")
    lines += ["", res["note"]]
    return "\n".join(lines)
