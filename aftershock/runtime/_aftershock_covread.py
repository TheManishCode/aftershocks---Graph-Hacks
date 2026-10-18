"""Run with the *target* repo's interpreter: reduce a per-test coverage data file to (test, symbol) pairs.

argv: <data file> <repo root> <symbols.json> <out.json>
symbols.json maps a repo-relative path to [[start, end, index], ...]. A line belongs to the innermost range holding it.
out.json: {"contexts": [node id, ...], "pairs": {context index: [symbol index, ...]}, "files": measured file count}.
The data is read inside the target env because coverage.py's file format is not a public, cross-version API.
"""

import json
import os
import sys

from coverage import CoverageData

data_file, root, sym_file, out_file = sys.argv[1:5]
with open(sym_file, encoding="utf-8") as fh:
    ranges = json.load(fh)
data = CoverageData(basename=data_file)
data.read()
contexts: dict[str, int] = {}
pairs: dict[int, set[int]] = {}
measured = 0
for path in data.measured_files():
    rel = os.path.relpath(path, root).replace(os.sep, "/")
    spans = ranges.get(rel)
    if not spans:
        continue
    measured += 1
    owner: dict[int, int] = {}
    for start, end, idx in sorted(spans, key=lambda s: s[0] - s[1]):  # widest first, so inner ranges overwrite
        for ln in range(start, end + 1):
            owner[ln] = idx
    for ln, ctxs in data.contexts_by_lineno(path).items():
        idx = owner.get(ln)
        if idx is None:
            continue
        for ctx in ctxs:
            if not ctx:  # collection/import time, outside any test
                continue
            ci = contexts.setdefault(ctx, len(contexts))
            pairs.setdefault(ci, set()).add(idx)
with open(out_file, "w", encoding="utf-8") as fh:
    json.dump({"contexts": list(contexts), "pairs": {k: sorted(v) for k, v in pairs.items()}, "files": measured}, fh)
