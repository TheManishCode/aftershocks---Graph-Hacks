"""What changed, symbol by symbol, between the indexed graph (the "before") and a working tree or git revision.

The graph already stores each symbol's body digest and contract digest (name + params + return + decorators), so a
change is classified without any textual diff:

  signature  contract digest differs        -> callers may break; new arity is checked against each call site
  body       only the body digest differs   -> behavior may change
  rename     a vanished symbol's body reappears under a new name (same or another changed file)
  delete     vanished, no matching body
  added      new name, nothing to break yet

CI flow: index the base branch, check out the PR head (or pass --rev), run this. Nothing in the repo is executed.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from ..graph import RepoGraph
from ..ingest.discover import list_sources
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
                 note=f"renamed to {c.renamed_to}" if c.renamed_to else "", changed_files=touched)
            for c in self.symbols if c.change != "added"
        ]

    def as_dict(self) -> dict:
        return {"base": self.base, "head": self.head, "files_changed": self.files_changed,
                "files_added": self.files_added, "files_removed": self.files_removed,
                "symbols": [c.as_dict() for c in self.symbols]}


def _git(root: Path, *args: str, timeout: int = 60) -> bytes:
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=timeout, check=True).stdout


def _head_contents(root: Path, rev: str | None, graph_files: dict[str, str], base_commit: str) -> dict[str, bytes | None]:
    """{path: new bytes or None if removed} for every path that differs from the graph."""
    out: dict[str, bytes | None] = {}
    if rev is None:
        current = set(list_sources(root))
        for p in sorted(current):
            try:
                data = (root / p).read_bytes()
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
    contents = _head_contents(root.resolve(), rev, graph_files, repo.get("commit", ""))
    cs = ChangeSet(base=(repo.get("commit") or "graph")[:12], head=rev or "working tree")
    old_syms: dict[str, list[dict]] = {}
    paths = sorted(contents)
    for i in range(0, len(paths), 200):
        for r in g.ro("symbols_in_files", {"paths": paths[i : i + 200]}):
            old_syms.setdefault(r["symbol"]["file"], []).append(r["symbol"])
    new_defs: dict[str, list[Def]] = {}
    for p in paths:
        data = contents[p]
        if data is None:
            cs.files_removed.append(p)
            continue
        (cs.files_changed if p in graph_files else cs.files_added).append(p)
        facts = parse_file(p, data)
        new_defs[p] = [d for d in facts.defs if d.qname != MODULE]

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
    order = {"delete": 0, "rename": 1, "signature": 2, "body": 3, "added": 4}
    cs.symbols.sort(key=lambda c: (order[c.change], c.file, c.line or 0))
    return cs


def analyze(g: RepoGraph, root: Path, rev: str | None = None, depth: int | None = None) -> dict:
    cs = detect(g, root, rev)
    seeds = cs.seeds()
    result = simulate(g, seeds, depth=depth) if seeds else None
    return {"changes": cs.as_dict(), "impact": result}
