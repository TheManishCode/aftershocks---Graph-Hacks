"""What changed, symbol by symbol, between the indexed graph (the "before") and a working tree or git revision.

The graph already stores each symbol's body digest and contract digest (name + params + return + decorators), so a
change is classified without any textual diff:

  signature  contract digest differs        -> callers may break; new arity is checked against each call site
  body       only the body digest differs   -> behavior may change
  rename     a vanished symbol's body reappears under a new name (same or another changed file)
  delete     vanished, no matching body
  added      new name, nothing to break yet; a new method that overrides an inherited one seeds the base method,
             since calls bound to it can now run the new code
  module     a module-level value (`TIMEOUT = 5`) changed: the module is seeded with the changed names, and only code
             that reads one of them depends on it

CI flow: index the base branch, check out the PR head (or pass --rev), run this. Nothing in the repo is executed.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from ..graph import RepoGraph
from ..ingest.discover import LIB_PREFIX, libraries, library_sources, list_sources
from ..ingest.model import MODULE, Def
from ..ingest.parse import file_sha, lang_for, parse_file
from .impact import Seed, simulate


@dataclass
class SymbolChange:
    id: str
    file: str
    qname: str
    kind: str
    change: str
    line: int | None = None
    old_signature: str = ""
    new_signature: str = ""
    min_args: int | None = None
    max_args: int | None = None
    renamed_to: str | None = None
    names: list[str] = field(default_factory=list)  # module seeds: the module-level values that changed
    overridden_by: str | None = None  # a base method a newly added method now overrides

    def as_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}


@dataclass
class ChangeSet:
    files_changed: list[str] = field(default_factory=list)
    files_added: list[str] = field(default_factory=list)
    files_removed: list[str] = field(default_factory=list)
    symbols: list[SymbolChange] = field(default_factory=list)
    base: str = "graph"
    head: str = "working tree"

    def seeds(self) -> list[Seed]:
        touched = frozenset(self.files_changed + self.files_added)
        return [
            Seed(c.id, c.change, c.min_args if c.change == "signature" else None,
                 c.max_args if c.change == "signature" else None,
                 note=(f"renamed to {c.renamed_to}" if c.renamed_to else
                       f"now overridden by {c.overridden_by.split('::')[-1]}" if c.overridden_by else
                       f"module values changed: {', '.join(c.names[:5])}" if c.names else ""),
                 changed_files=touched, names=frozenset(c.names))
            for c in self.symbols if c.change != "added"
        ]

    def as_dict(self) -> dict:
        return {"base": self.base, "head": self.head, "files_changed": self.files_changed,
                "files_added": self.files_added, "files_removed": self.files_removed,
                "symbols": [c.as_dict() for c in self.symbols]}


def _git(root: Path, *args: str, timeout: int = 60) -> bytes:
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=timeout, check=True).stdout


def _head_contents(root: Path, rev: str | None, graph_files: dict[str, str], base_commit: str,
                   libs: dict[str, str] | None = None) -> dict[str, bytes | None]:
    """{path: new bytes or None if removed} for every path that differs from the graph."""
    out: dict[str, bytes | None] = {}
    if rev is None:
        lib_files = library_sources(libs or {})
        current = set(list_sources(root)) | set(lib_files)
        for p in sorted(current):
            try:
                data = (lib_files.get(p) or root / p).read_bytes()
            except OSError:
                continue
            if graph_files.get(p) != file_sha(data):
                out[p] = data
        for p in graph_files:
            if p not in current:
                out[p] = None
        return out
    if not base_commit:
        raise ValueError("the index has no recorded commit; re-index from a git checkout to diff against a revision")
    names = _git(root, "diff", "--name-status", "--no-renames", "-z", base_commit, rev).decode("utf-8", "replace")
    parts = [x for x in names.split("\0") if x]
    for status, path in zip(parts[::2], parts[1::2], strict=False):
        if lang_for(path) is None:
            continue
        if status.startswith("D"):
            out[path] = None if path in graph_files else out.get(path)
        else:
            try:
                out[path] = _git(root, "show", f"{rev}:{path}")
            except subprocess.CalledProcessError:
                out[path] = None
    return {p: v for p, v in out.items() if v is not None or p in graph_files}


def detect(g: RepoGraph, root: Path, rev: str | None = None) -> ChangeSet:
    graph_files = {r["path"]: r["sha"] for r in g.ro("file_index")}
    repo = (g.ro("repo") or [{"repo": {}}])[0]["repo"]
    if rev is not None:  # test libraries live outside the repo's git history: a revision diff leaves them as indexed
        graph_files = {p: v for p, v in graph_files.items() if not p.startswith(LIB_PREFIX)}
    contents = _head_contents(root.resolve(), rev, graph_files, repo.get("commit", ""), libraries(repo))
    cs = ChangeSet(base=(repo.get("commit") or "graph")[:12], head=rev or "working tree")
    old_syms: dict[str, list[dict]] = {}
    paths = sorted(contents)
    for i in range(0, len(paths), 200):
        for r in g.ro("symbols_in_files", {"paths": paths[i : i + 200]}):
            old_syms.setdefault(r["symbol"]["file"], []).append(r["symbol"])
    new_defs: dict[str, list[Def]] = {}
    new_mods: dict[str, Def] = {}
    for p in paths:
        data = contents[p]
        if data is None:
            cs.files_removed.append(p)
            continue
        (cs.files_changed if p in graph_files else cs.files_added).append(p)
        facts = parse_file(p, data)
        new_defs[p] = [d for d in facts.defs if d.qname != MODULE]
        new_mods[p] = next(d for d in facts.defs if d.qname == MODULE)
    for p in paths:
        cs.symbols += _module_change(old_syms.get(p, []), new_mods.get(p), p)

    vanished: list[dict] = []
    appeared: list[Def] = []
    for p in paths:
        old = {s["qname"]: s for s in old_syms.get(p, []) if s["qname"] != MODULE}
        new = {d.qname: d for d in new_defs.get(p, [])}
        for q, s in old.items():
            d = new.get(q)
            if d is None:
                vanished.append(s)
            elif d.sig_digest != s.get("sig_digest"):
                cs.symbols.append(SymbolChange(s["id"], p, q, d.kind, "signature", d.line, s.get("signature", ""),
                                               d.signature, d.min_args, d.max_args))
            elif d.digest != s.get("digest"):
                cs.symbols.append(SymbolChange(s["id"], p, q, d.kind, "body", d.line, s.get("signature", ""),
                                               d.signature))
        appeared += [d for q, d in new.items() if q not in old]

    by_digest: dict[tuple[str, str], list[Def]] = {}
    for d in appeared:
        by_digest.setdefault((d.kind, d.digest), []).append(d)
    renamed_new: set[str] = set()
    for s in vanished:
        twins = [d for d in by_digest.get((s.get("kind"), s.get("digest")), []) if d.id not in renamed_new]
        if len(twins) == 1:  # identical body under a new name: a rename/move, which breaks every caller of the old name
            d = twins[0]
            renamed_new.add(d.id)
            cs.symbols.append(SymbolChange(s["id"], s["file"], s["qname"], s.get("kind", ""), "rename", s.get("line"),
                                           s.get("signature", ""), d.signature, renamed_to=d.id))
        else:
            cs.symbols.append(SymbolChange(s["id"], s["file"], s["qname"], s.get("kind", ""), "delete", s.get("line"),
                                           s.get("signature", "")))
    for d in appeared:
        if d.id not in renamed_new:
            cs.symbols.append(SymbolChange(d.id, d.path, d.qname, d.kind, "added", d.line, "", d.signature,
                                           d.min_args, d.max_args))
    cs.symbols += _new_overrides(g, [d for d in appeared if d.id not in renamed_new], {c.id for c in cs.symbols})
    order = {"delete": 0, "rename": 1, "signature": 2, "body": 3, "added": 4}
    cs.symbols.sort(key=lambda c: (order[c.change], c.file, c.line or 0))
    return cs


def _module_change(old: list[dict], new: Def | None, path: str) -> list[SymbolChange]:
    """Module-level values whose binding statement changed, appeared or vanished. Graphs indexed before values were
    recorded have none to compare, so they yield nothing rather than flagging every reader."""
    om = next((s for s in old if s["qname"] == MODULE), None)
    if om is None or om.get("values") is None:
        return []
    before = dict(x.split("=", 1) for x in om["values"])
    after = new.values if new is not None else {}
    names = sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
    if not names:
        return []
    change = "delete" if new is None else "body"
    return [SymbolChange(om["id"], path, MODULE, "module", change, 1, names=names)]


def _new_overrides(g: RepoGraph, added: list[Def], already: set[str]) -> list[SymbolChange]:
    """A method added to an existing class that redefines an inherited one changes what calls bound to the base
    method run: seed the nearest base method, so its callers (and the tests behind them) are reached."""
    methods = [d for d in added if d.kind == "method" and "." in d.qname and d.name not in ("__init__", "__new__")]
    owners = sorted({f"{d.path}::{d.qname.rsplit('.', 1)[0]}" for d in methods})
    if not owners:
        return []
    bases: dict[str, list[str]] = {}
    for r in g.ro("bases_of", {"ids": owners}):
        bases.setdefault(r["src"], []).append(r["base"])
    want = {f"{b}.{d.name}": d for d in methods for b in bases.get(f"{d.path}::{d.qname.rsplit('.', 1)[0]}", [])}
    if not want:
        return []
    found = {r["symbol"]["id"]: r["symbol"] for r in g.ro("symbols_by_ids", {"ids": sorted(want)})}
    out, seen = [], set(already)
    for d in methods:
        for b in bases.get(f"{d.path}::{d.qname.rsplit('.', 1)[0]}", []):  # nearest base first
            s = found.get(f"{b}.{d.name}")
            if s is None:
                continue
            if s["id"] not in seen:
                seen.add(s["id"])
                out.append(SymbolChange(s["id"], s["file"], s["qname"], s.get("kind", "method"), "body",
                                        s.get("line"), s.get("signature", ""), overridden_by=d.id))
            break
    return out


def analyze(g: RepoGraph, root: Path, rev: str | None = None, depth: int | None = None) -> dict:
    cs = detect(g, root, rev)
    seeds = cs.seeds()
    result = simulate(g, seeds, depth=depth) if seeds else None
    return {"changes": cs.as_dict(), "impact": result}
