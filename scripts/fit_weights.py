# Fit the impact simulator's weights on some repos' history and score them on OTHER repos' history (held out).
# Usage: PYTHONPATH=. .venv/bin/python scripts/fit_weights.py --train click,httpx --test flask,starlette [--write]
# Every repo must be indexed. Objective: mean F1 at the "possible" tier of `aftershock eval` (static, depth 3) over the
# train repos, by coordinate descent over GRID. --write updates weights.json only if the held-out mean F1 improves.
import argparse
import json
import sys
from pathlib import Path

from aftershock import tools as T
from aftershock.analysis import impact
from aftershock.analysis.evaluate import TIERS, Eval, Score, cases
from aftershock.analysis.impact import simulate

GRID = {  # (path into weights.json) -> candidate values; the current value is always a candidate too
    ("transmit",): [0.3, 0.4, 0.5, 0.6, 0.7, 0.85],
    ("min_p",): [0.01, 0.02, 0.03, 0.05, 0.08, 0.12],
    ("seed", "body"): [0.2, 0.35, 0.5, 0.7],
    ("seed", "signature"): [0.6, 0.85, 1.0],
    ("edge", "INHERITS"): [0.4, 0.6, 0.8, 1.0],
    ("edge", "DISPATCH"): [0.3, 0.45, 0.6, 0.8],
    ("edge", "READ"): [0.2, 0.35, 0.5, 0.7, 0.9],
    ("caller_also_changed",): [0.25, 0.5, 0.75, 1.0],
}


def _get(W, path):
    for k in path[:-1]:
        W = W[k]
    return W[path[-1]]


def _set(W, path, v):
    for k in path[:-1]:
        W = W[k]
    W[path[-1]] = v


class Repo:
    def __init__(self, name: str, commits: int):
        self.name = name
        self.g = T._graph(name)
        root = Path(T._repo_props(self.g).get("root") or "")
        self.ev = Eval()
        self.cases = list(cases(self.g, root, self.ev, commits=commits))
        ro, memo = self.g.ro, {}

        def cached(q, params=None, **kw):  # the graph does not change while fitting; weights only change arithmetic
            key = (q, json.dumps(params, sort_keys=True, default=list), json.dumps(kw, sort_keys=True))
            if key not in memo:
                memo[key] = ro(q, params, **kw)
            return memo[key]
        self.g.ro = cached

    def score(self) -> dict[str, dict]:
        sc = {t: Score() for t in TIERS}
        for c in self.cases:
            res = simulate(self.g, c.seeds, depth=3, runtime=False)
            rows = res["impacted"] + res["tests"]
            for i, t in enumerate(TIERS):
                sc[t].add({r["file"] for r in rows if r["tier"] in TIERS[: i + 1]} - {c.anchor}, c.truth)
        return {t: s.as_dict() for t, s in sc.items()}


def mean_f1(repos, tier="possible"):
    return sum(r.score()[tier]["f1"] for r in repos) / len(repos)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("--test", required=True)
    ap.add_argument("--commits", type=int, default=200)
    ap.add_argument("--passes", type=int, default=2)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    train = [Repo(n, a.commits) for n in a.train.split(",")]
    test = [Repo(n, a.commits) for n in a.test.split(",")]
    W = impact.weights()  # simulate() reads this same cached dict, so edits to it take effect immediately
    before = {r.name: r.score() for r in train + test}
    best = mean_f1(train)
    print("cases: " + ", ".join(f"{r.name}={len(r.cases)}" for r in train + test), file=sys.stderr)
    print(f"start: train mean F1 {best:.4f}", file=sys.stderr)
    for _ in range(a.passes):
        moved = False
        for path, values in GRID.items():
            cur = _get(W, path)
            for v in sorted(set(values) | {cur}):
                if v == cur:
                    continue
                _set(W, path, v)
                f = mean_f1(train)
                if f > best + 1e-4:  # strictly better (beyond rounding) or keep the prior
                    best, cur, moved = f, v, True
                    print(f"  {'.'.join(path)} = {v}: train mean F1 {f:.4f}", file=sys.stderr)
            _set(W, path, cur)
        if not moved:
            break
    after = {r.name: r.score() for r in train + test}
    fitted = {".".join(p): _get(W, p) for p in GRID}
    held_before = sum(before[r.name]["possible"]["f1"] for r in test) / len(test)
    held_after = sum(after[r.name]["possible"]["f1"] for r in test) / len(test)
    out = {"fitted": fitted, "held_out_mean_f1": {"before": round(held_before, 4), "after": round(held_after, 4)},
           "repos": {n: {"split": "train" if n in a.train.split(",") else "test", "cases": len(r.cases),
                         "before": before[n], "after": after[n]} for n, r in ((r.name, r) for r in train + test)}}
    print(json.dumps(out, indent=1))
    if a.write:
        if held_after > held_before:
            raw = json.loads(impact.WEIGHTS_PATH.read_text())
            for p in GRID:
                _set(raw, p, _get(W, p))
            impact.WEIGHTS_PATH.write_text(json.dumps(raw, indent=2) + "\n")
            print(f"wrote {impact.WEIGHTS_PATH}", file=sys.stderr)
        else:
            print("held-out F1 did not improve; weights.json left unchanged", file=sys.stderr)


if __name__ == "__main__":
    main()
