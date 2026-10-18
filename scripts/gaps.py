# Unresolved, non-external call sites (the graph's blind spots), grouped by a coarse receiver pattern.
# Usage: PYTHONPATH=. .venv/bin/python scripts/gaps.py <repo root> [src|all] [filter]
import re
import sys
from collections import Counter
from pathlib import Path

from aftershock.ingest.discover import list_sources, read_configs
from aftershock.ingest.parse import parse_file
from aftershock.ingest.resolve import _PY_BUILTINS, RepoConfig, Resolver, _param_names

root = Path(sys.argv[1])
src_only = len(sys.argv) > 2 and sys.argv[2] == "src"
files = [parse_file(p, (root / p).read_bytes()) for p in list_sources(root)]
r = Resolver(files, RepoConfig.load(read_configs(root)))
for f in r.files.values():
    r.bind_file(f)
pat, ex, tot = Counter(), Counter(), 0
for path, f in r.files.items():
    if src_only and f.is_test:
        continue
    for c in f.calls:
        if c.kind in ("ref", "jsx") or (f.lang == "python" and c.receiver is None and c.name in _PY_BUILTINS):
            continue
        hit = r.resolve_name(path, c.caller, c.name) if c.receiver is None else r.resolve_attr(path, c.caller, c.receiver, c.name)
        if hit is None and c.receiver is None and c.kind == "call":
            hit = r.callable_var(path, c.caller, c.name)
        if hit is not None or r.is_external(path, c.caller, c.receiver, c.name):
            continue
        tot += 1
        rv = c.receiver or ""
        owner = r.defs[path].get(c.caller)
        head = re.split(r"[.(\[]", rv or c.name)[0]
        isparam = owner is not None and head in _param_names(owner)
        typ = r._var_type(path, c.caller, head)
        k = ("bare " if not rv else "recv ") + ("param" if isparam and not typ else "typed:" + typ.split(":")[0] if typ else "untyped")
        pat[k] += 1
        if len(sys.argv) > 3 and sys.argv[3] in k:
            print("   ", path, c.line, rv, c.name, typ[:90])
        ex[f"{rv + '.' if rv else ''}{c.name}"] += 1
print(root.name, "blind call sites:", tot)
for k, v in pat.most_common(12):
    print(f"  {v:5d} {k}")
print("  top:", ex.most_common(40))
