"""Cross-file resolution: link every file's call sites, bases and imports to definitions elsewhere in the repo.

Each resolved edge carries `how` (the rule that bound it) and `confidence`. The rules run most-precise first and stop
at the first hit. When a name stays ambiguous, the edge is left out and counted as unresolved. It is never bound to
the alphabetically first candidate. That fallback is what makes other code graphs report impact that isn't real.

    how            confidence  meaning
    self           0.95        self./this./Self:: method on the enclosing class or one of its bases
    local          0.95        a definition in the same file, nearest enclosing scope first
    import         0.90        a name bound by an import statement
    module-attr    0.90        alias.name where alias is an imported module / namespace / Go package
    static         0.85        Class.method / Type::new on a class the file can see
    package        0.85        same Go package (directory) or Java package: visible without an import
    inferred       0.80        receiver type followed through declared/assigned types: x = Foo(); x.m(), get_db().q()
                               (also undeclared returns read from the body, `with X() as x`, and pytest fixtures)
    receiver       0.75        Go/Rust method on the caller's own receiver type, receiver named by variable
    star-import    0.70        a name provided by `from x import *` / `use x::*` / `import pkg.*`
    name-unique    0.45        the only exported top-level definition with this name in the repo (heuristic)
    method-unique  0.35        obj.name where exactly one method in the repo is called `name` (heuristic)
"""

from __future__ import annotations

import builtins
import json
import posixpath
import re
from collections import defaultdict
from dataclasses import dataclass, field

from .model import MODULE, Def, FileFacts, sym_id
from .parse import JSLIKE

CONFIDENCE = {
    "self": 0.95, "local": 0.95, "import": 0.90, "module-attr": 0.90, "static": 0.85, "package": 0.85,
    "inferred": 0.80, "receiver": 0.75, "star-import": 0.70, "name-unique": 0.45, "method-unique": 0.35,
}
HEURISTIC = {"name-unique", "method-unique"}
CLASSY = {"class", "interface", "struct", "trait", "enum", "type"}
REFERABLE = {"function", "method", "class", "struct"}  # what a bare identifier passed as a value may bind to
REF_HOW = {"local", "import", "module-attr", "package", "star-import", "self", "static"}  # no repo-wide guesses


def _param_names(d: Def) -> set[str]:
    return {re.split(r"[:=\s]", p.lstrip("*&."), maxsplit=1)[0] for p in d.params}
CTOR_NAMES = {"__init__", "constructor", "<init>", "new"}
JS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts")
# Method names too generic for the method-unique heuristic: a hit on them says nothing about the receiver's type.
GENERIC_METHODS = {
    "get", "set", "add", "put", "run", "map", "len", "close", "open", "read", "write", "send", "next", "push", "pop",
    "call", "apply", "bind", "then", "catch", "format", "join", "split", "strip", "append", "extend", "update",
    "keys", "items", "values", "copy", "clear", "remove", "delete", "init", "start", "stop", "emit", "on", "off",
    "find", "filter", "reduce", "forEach", "toString", "equals", "hashCode", "clone", "parse", "load", "save",
    "render", "handle", "process", "execute", "query", "fetch", "log", "debug", "info", "warn", "error", "has",
    "is", "of", "from", "create", "build", "test", "check", "validate", "flush", "reset", "insert", "length",
    "size", "count", "lower", "upper", "replace", "match", "sort", "encode", "decode", "dump", "dumps", "loads",
}


@dataclass(slots=True)
class Edge:
    src: str
    dst: str
    type: str  # CALLS | INHERITS | IMPLEMENTS | OVERRIDES
    how: str
    confidence: float
    lines: list[int] = field(default_factory=list)
    args: list[int] = field(default_factory=list)  # argument counts seen at the call sites (CALLS only)
    kind: str = "call"  # call | new

    @property
    def count(self) -> int:
        return len(self.lines)


@dataclass(slots=True)
class FileLink:
    src: str
    dst: str
    names: list[str] = field(default_factory=list)
    line: int = 0


@dataclass(slots=True)
class Resolution:
    edges: list[Edge]
    file_links: list[FileLink]
    externals: dict[str, set[str]]  # path -> external package names it imports
    unresolved: dict[str, int]  # path -> call sites that matched nothing in the repo (or matched ambiguously)
    ambiguous: dict[str, int]
    external: dict[str, int] = field(default_factory=dict)  # path -> call sites provably into libraries/builtins


@dataclass(slots=True)
class RepoConfig:
    go_module: str = ""
    # tsconfig `paths`, TypeScript semantics: ("@/*", ["src/*"]) or ("pkg", ["src/index.ts"]); at most one `*` each
    ts_paths: list[tuple[str, list[str]]] = field(default_factory=list)

    @staticmethod
    def load(read: dict[str, bytes]) -> RepoConfig:
        """Build from the few config files that change how imports resolve. `read` maps repo path -> bytes."""
        cfg = RepoConfig()
        gomod = read.get("go.mod")
        if gomod:
            m = re.search(rb"^module\s+(\S+)", gomod, re.MULTILINE)
            cfg.go_module = m.group(1).decode() if m else ""
        for name in ("tsconfig.json", "jsconfig.json", "web/tsconfig.json", "frontend/tsconfig.json", "app/tsconfig.json"):
            raw = read.get(name)
            if not raw:
                continue
            base_dir = posixpath.dirname(name)
            try:
                opts = json.loads(_strip_jsonc(raw.decode("utf-8", "replace"))).get("compilerOptions", {})
            except (ValueError, AttributeError):
                continue
            base = posixpath.normpath(posixpath.join(base_dir, opts.get("baseUrl", ".")))
            for pattern, targets in (opts.get("paths") or {}).items():
                if not isinstance(targets, list) or pattern.count("*") > 1:
                    continue
                outs = [_join_pattern(base, t) for t in targets if isinstance(t, str) and t.count("*") <= 1]
                cfg.ts_paths.append((pattern, outs))
        # the longest prefix wins, as in tsc; exact patterns outrank wildcards
        cfg.ts_paths.sort(key=lambda pt: ("*" in pt[0], -len(pt[0].split("*")[0])))
        return cfg


_JSONC = re.compile(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?\*/|,(?=\s*[}\]])', re.DOTALL)


def _strip_jsonc(text: str) -> str:
    """tsconfig is JSON with comments and trailing commas. Strings are matched first, so `"pkg/*"` or `"src/**/*"`
    never open or close a comment."""
    return _JSONC.sub(lambda m: m.group(0) if m.group(0).startswith('"') else "", text)


def _join_pattern(base: str, target: str) -> str:
    """`base` + a tsconfig target that may hold one `*`, normalized without collapsing the wildcard."""
    head, star, tail = target.partition("*")
    joined = posixpath.normpath(posixpath.join(base, head or ".")) + ("/" if head.endswith("/") else "")
    joined = "" if joined in (".", "./") else joined.removeprefix("./")
    return joined + star + tail


def match_ts_path(pattern: str, spec: str) -> str | None:
    """The text `*` captures when `spec` matches `pattern` ("" for an exact match), or None."""
    if "*" not in pattern:
        return "" if spec == pattern else None
    pre, _, post = pattern.partition("*")
    if spec.startswith(pre) and spec.endswith(post) and len(spec) >= len(pre) + len(post):
        return spec[len(pre) : len(spec) - len(post)]
    return None


@dataclass(slots=True)
class _Bind:
    paths: list[str]  # files the name points into (a Go package / Java wildcard spans several)
    symbol: str | None  # top-level name inside those files; None when the binding is the module itself


def _unnumbered(qname: str) -> str:
    """`Cls.m#3` -> `Cls.m`; a nested `f#2.g` keeps its own name."""
    return re.sub(r"#\d+$", "", qname)


def _is_stub(d: Def) -> bool:
    return any(x.split("(")[0].rsplit(".", 1)[-1] == "overload" for x in d.decorators)


class Resolver:
    def __init__(self, files: list[FileFacts], cfg: RepoConfig | None = None):
        self.cfg = cfg or RepoConfig()
        self.files = {f.path: f for f in files}
        self.defs: dict[str, dict[str, Def]] = {f.path: {d.qname: d for d in f.defs} for f in files}
        self.paths = set(self.files)
        self.top: dict[str, dict[str, Def]] = {}  # path -> top-level name -> def
        self.by_name: dict[str, list[Def]] = defaultdict(list)  # exported top-level defs, repo-wide
        self.methods_by_name: dict[str, list[Def]] = defaultdict(list)
        # A name defined twice in one scope (`@overload` stubs, TS overload signatures, conditional redefinitions) runs
        # its last definition, so calls bind to that implementation, not to the first stub.
        impl: dict[tuple[str, str], Def] = {}
        for f in files:
            for d in f.defs:
                key = (f.path, _unnumbered(d.qname))
                if key not in impl or not _is_stub(d):
                    impl[key] = d
        for (path, base), d in impl.items():
            self.defs[path][base] = d  # qualified lookups (`Class.method`) reach the implementation too
        for f in files:
            tops = self.top.setdefault(f.path, {})
            for d in f.defs:
                if d.qname == MODULE or d.is_test and d.kind in ("test", "suite"):
                    continue
                if impl.get((f.path, _unnumbered(d.qname))) is not d:
                    continue
                if "." not in _unnumbered(d.qname):
                    tops[d.name] = d
                    if d.exported:
                        self.by_name[d.name].append(d)
                elif d.kind == "method":
                    self.methods_by_name[d.name].append(d)
        # Rust impls and Go methods put `Type.method` in files that may not define `Type`; index classes by name too.
        self.members: dict[str, dict[str, Def]] = defaultdict(dict)  # "<path>::<Class>" -> member name -> def
        for f in files:
            for d in f.defs:
                if "." in d.qname and d.kind in ("method", "function", "class", "struct", "enum", "interface"):
                    owner, _, member = d.qname.rpartition(".")
                    if impl.get((f.path, _unnumbered(d.qname))) is d:
                        self.members[sym_id(f.path, owner)][member.split("#")[0]] = d
        self.dir_files: dict[str, list[str]] = defaultdict(list)
        self.java_pkg: dict[str, list[str]] = defaultdict(list)
        for f in files:
            self.dir_files[posixpath.dirname(f.path)].append(f.path)
            if f.lang == "java" and f.package:
                self.java_pkg[f.package].append(f.path)
        self.py_modules = self._python_modules()
        self.binds: dict[str, dict[str, _Bind]] = {}
        self.stars: dict[str, list[str]] = {}
        self.module_aliases: dict[str, dict[str, list[str]]] = {}
        self.file_links: dict[tuple[str, str], FileLink] = {}
        self.externals: dict[str, set[str]] = defaultdict(set)
        # Local names a file binds to something outside the repo (`from pathlib import Path`, `import numpy as np`).
        # Such a name is settled: it must never fall through to a repo-wide name-unique / method-unique guess.
        self.foreign: dict[str, set[str]] = defaultdict(set)
        self._typing: set[tuple[str, str, str]] = set()
        self._aliasing: set[tuple[str, str]] = set()
        # Objects built at runtime (`return { getState, setState }`, `Object.assign(fn, api)`) as synthetic Defs that
        # are never emitted: their members are real definitions, so edges still land on real symbols.
        self._shapes: dict[tuple[str, str, str], Def | None] = {}
        self._shape_bases: dict[str, list[Def]] = {}
        self._callable: dict[str, Def] = {}  # shape id -> the function a call on it runs

    # ---- module lookup per language ------------------------------------------------------------------------------
    def _python_modules(self) -> dict[str, str]:
        mods: dict[str, str] = {}
        suffix: dict[str, set[str]] = defaultdict(set)
        for p, f in self.files.items():
            if f.lang != "python":
                continue
            stem = p.removesuffix(".pyi").removesuffix(".py")
            if stem.endswith("/__init__"):
                stem = stem.removesuffix("/__init__")
            dotted = stem.replace("/", ".")
            if p.endswith(".pyi") and dotted in mods:
                continue  # prefer the implementation over its stub
            mods[dotted] = p
            parts = dotted.split(".")
            for i in range(1, len(parts)):  # src.pkg.mod is importable as pkg.mod (src layout, nested roots)
                suffix[".".join(parts[i:])].add(p)
        for name, ps in suffix.items():
            if name not in mods and len(ps) == 1:
                mods[name] = next(iter(ps))
        return mods

    def py_module(self, path: str, module: str, level: int) -> str | None:
        if level:
            pkg = posixpath.dirname(path)
            for _ in range(level - 1):
                pkg = posixpath.dirname(pkg)
            cand = posixpath.join(pkg, module.replace(".", "/")) if module else pkg
            for c in (cand + ".py", cand + "/__init__.py", cand + ".pyi"):
                if c in self.paths:
                    return c
            return None
        return self.py_modules.get(module)

    def js_module(self, path: str, spec: str) -> str | None:
        bases: list[str] = []
        if spec.startswith("."):
            bases.append(posixpath.normpath(posixpath.join(posixpath.dirname(path), spec)))
        else:
            for pattern, targets in self.cfg.ts_paths:
                star = match_ts_path(pattern, spec)
                if star is not None:
                    bases.extend(posixpath.normpath(t.replace("*", star)) for t in targets)
                    break
            if not bases and spec[:2] in ("@/", "~/"):  # conventional alias without a tsconfig we could read
                rest = spec[2:]
                bases.extend(r + rest for r in ("src/", "", "app/", "web/", "web/src/"))
        for base in bases:
            base = base.removeprefix("./")
            stem = re.sub(r"\.(m|c)?js$|\.jsx$", "", base)  # TS ESM imports name the emitted .js file
            for cand in (base, *(stem + e for e in JS_EXTS), *(f"{stem}/index{e}" for e in JS_EXTS)):
                if cand in self.paths:
                    return cand
        return None

    def go_package(self, spec: str) -> list[str]:
        mod = self.cfg.go_module
        if mod and (spec == mod or spec.startswith(mod + "/")):
            d = spec[len(mod):].lstrip("/")
            return [p for p in self.dir_files.get(d, []) if p.endswith(".go") and not p.endswith("_test.go")]
        return []

    def rust_module(self, path: str, module: str) -> list[str]:
        """Files for a `use` path: crate::a::b -> <crate src>/a/b.rs | a/b/mod.rs | a.rs (b is then an item)."""
        if not module:
            return []
        segs = module.split("::")
        src_root = path.split("/src/", 1)[0] + "/src" if "/src/" in path else ("src" if path.startswith("src/") else posixpath.dirname(path))
        here = posixpath.dirname(path)
        if posixpath.basename(path) not in ("mod.rs", "lib.rs", "main.rs"):
            here = posixpath.join(here, posixpath.basename(path).removesuffix(".rs"))
        if segs[0] == "crate":
            base, segs = src_root, segs[1:]
        elif segs[0] == "self":
            base, segs = here, segs[1:]
        elif segs[0] == "super":
            base = here
            while segs and segs[0] == "super":
                base, segs = posixpath.dirname(base), segs[1:]
        else:
            return []  # an external crate
        out: list[str] = []
        for cut in range(len(segs), -1, -1):
            d = posixpath.join(base, *segs[:cut]) if segs[:cut] else base
            for cand in (d + ".rs", d + "/mod.rs", (d + "/lib.rs") if d == src_root else "", (d + "/main.rs") if d == src_root else ""):
                if cand and cand in self.paths:
                    out.append(cand)
                    return out
        return out

    # ---- import bindings -----------------------------------------------------------------------------------------
    def bind_file(self, f: FileFacts) -> None:
        binds: dict[str, _Bind] = {}
        stars: list[str] = []
        aliases: dict[str, list[str]] = {}
        for imp in f.imports:
            targets = self._targets(f, imp.module, imp.level)
            if not targets:
                if f.lang == "python" and imp.names and not imp.alias:  # `from pkg import mod` where pkg/__init__ is absent
                    for name, local in imp.names:
                        sub = self.py_module(f.path, f"{imp.module}.{name}" if imp.module else name, imp.level)
                        if sub:
                            binds[local] = _Bind([sub], None)
                            self._link(f.path, sub, name, imp.line)
                    if any(local in binds for _, local in imp.names):
                        continue
                ext = self._external_name(f, imp.module, imp.level)
                if ext:
                    self.externals[f.path].add(ext)
                    foreign = self.foreign[f.path]
                    foreign.update(local for name, local in imp.names if name != "*")
                    if imp.alias:
                        foreign.add(imp.alias)
                    elif not imp.names and f.lang == "python":
                        foreign.add(imp.module.split(".")[0])
                continue
            for t in targets:
                self._link(f.path, t, ",".join(n for n, _ in imp.names) or (imp.alias or ""), imp.line)
            if imp.alias:
                aliases[imp.alias] = targets
            elif f.lang == "python" and not imp.names:  # `import a.b.c` binds `a`; receivers are matched by prefix
                aliases[imp.module] = targets
                top = imp.module.split(".")[0]
                pkg = self.py_module(f.path, top, 0) if top != imp.module and top not in aliases else None
                if pkg:
                    aliases[top] = [pkg]
            for name, local in imp.names:
                if name == "*":
                    stars.extend(targets)
                    continue
                if f.lang == "python":
                    sub = self.py_module(f.path, f"{imp.module}.{name}" if imp.module else name, imp.level)
                    if sub and name not in self.top.get(targets[0], {}):
                        binds[local] = _Bind([sub], None)
                        self._link(f.path, sub, name, imp.line)
                        continue
                if f.lang == "rust":
                    sub = self.rust_module(f.path, f"{imp.module}::{name}")
                    if sub and sub != targets:
                        binds[local] = _Bind(sub, None)
                        continue
                if f.lang == "java" and len(targets) == 1 and name not in self.top.get(targets[0], {}):
                    cls = self._java_class_file(imp.module)  # static import: com.x.Foo.bar
                    if cls:
                        binds[local] = _Bind([cls[0]], f"{cls[1]}.{name}")
                        continue
                binds[local] = _Bind(targets, name)
        self.binds[f.path] = binds
        self.stars[f.path] = stars
        self.module_aliases[f.path] = aliases

    def _targets(self, f: FileFacts, module: str, level: int) -> list[str]:
        lang = f.lang
        if lang == "python":
            p = self.py_module(f.path, module, level)
            return [p] if p else []
        if lang in JSLIKE:
            p = self.js_module(f.path, module)
            return [p] if p else []
        if lang == "go":
            return self.go_package(module)
        if lang == "java":
            if module in self.java_pkg:
                return sorted(self.java_pkg[module])
            cls = self._java_class_file(module)
            return [cls[0]] if cls else []
        if lang == "rust":
            return self.rust_module(f.path, module)
        return []

    def _java_class_file(self, dotted: str) -> tuple[str, str] | None:
        pkg, _, cls = dotted.rpartition(".")
        for p in self.java_pkg.get(pkg, []):
            if cls in self.top.get(p, {}):
                return p, cls
        return None

    def _external_name(self, f: FileFacts, module: str, level: int) -> str | None:
        if level or not module:
            return None
        if f.lang in JSLIKE:
            if module.startswith((".", "/", "@/", "~/")):
                return None
            parts = module.split("/")
            return "/".join(parts[:2]) if module.startswith("@") else parts[0]
        if f.lang == "go":
            return module
        if f.lang == "rust":
            root = module.split("::")[0]
            return None if root in ("crate", "self", "super") else root
        if f.lang == "java":
            return ".".join(module.split(".")[:2])
        return module.split(".")[0]

    def _link(self, src: str, dst: str, names: str, line: int) -> None:
        if src == dst:
            return
        link = self.file_links.get((src, dst))
        if link is None:
            link = self.file_links[(src, dst)] = FileLink(src, dst, [], line)
        for n in names.split(","):
            if n and n not in link.names:
                link.names.append(n)

    # ---- symbol lookup -------------------------------------------------------------------------------------------
    def lookup(self, paths: list[str], symbol: str, _seen: frozenset[str] = frozenset()) -> Def | None:
        """`symbol` inside one of `paths`: a top-level name, or Class.member. Follows re-exports, named or star
        (`from .impl import thing` / `from ._models import *` in __init__.py, `export * from './x'` in index.ts)."""
        head, _, rest = symbol.partition(".")
        for p in paths:
            if p in _seen:
                continue  # re-export cycle
            seen = _seen | {p}
            if head == "default":
                d = self._default_export(p)
            else:
                d = self.top.get(p, {}).get(head) or self._value_alias(p, head)
            if d is None:
                b = self.binds.get(p, {}).get(head)
                if b is not None and b.symbol and p not in b.paths:
                    d = self.lookup(b.paths, b.symbol, seen)
            if d is None and head != "default":
                for star in self.stars.get(p, []):
                    d = self.lookup([star], head, seen)
                    if d is not None:
                        break
            if d is not None and rest:
                d = self.member(d, rest)
            if d is not None:
                return d
        return None

    def _value_alias(self, path: str, name: str) -> Def | None:
        """A module-level name bound to another definition: `export const devtools = devtoolsImpl as unknown as
        Devtools` (TS/JS) or `Client = HttpClient` (Python). Calls through the alias reach the definition."""
        mod = self.defs.get(path, {}).get(MODULE)
        types = mod.types if mod is not None else {}
        t = types.get(name, "")
        target = types.get("ref:" + name) or (t[6:] if t.startswith("alias:") and t[6:].isidentifier() else "")
        key = (path, name)
        if not target or target == name or key in self._aliasing:
            return None
        self._aliasing.add(key)
        try:
            hit = self.resolve_name(path, MODULE, target)
            return hit[0] if hit else None
        finally:
            self._aliasing.discard(key)

    def _default_export(self, path: str) -> Def | None:
        tops = [d for d in self.top.get(path, {}).values() if d.exported]
        return tops[0] if len(tops) == 1 else None

    def member(self, cls: Def, name: str, depth: int = 0) -> Def | None:
        d = self.members.get(cls.id, {}).get(name)
        if d is not None or depth >= 4:
            return d
        for owner in self._types_named(cls):  # Rust/Go: methods of `S` defined in another file of the crate/package
            d = self.members.get(owner, {}).get(name)
            if d is not None:
                return d
        for base in self.bases(cls):
            d = self.member(base, name, depth + 1)
            if d is not None:
                return d
        return None

    def _types_named(self, cls: Def) -> list[str]:
        f = self.files[cls.path]
        if f.lang not in ("go", "rust"):
            return []
        same = self.dir_files.get(posixpath.dirname(cls.path), [])  # Go package / Rust module directory
        return [sym_id(p, cls.qname) for p in same if p != cls.path]

    def bases(self, cls: Def) -> list[Def]:
        out = list(self._shape_bases.get(cls.id, ()))
        for raw in cls.bases:
            hit = self.resolve_name(cls.path, MODULE, raw, kinds=CLASSY)
            if hit is not None and hit[0].id != cls.id:
                out.append(hit[0])
        return out

    def resolve_name(self, path: str, caller: str, raw: str, kinds: set[str] | None = None) -> tuple[Def, str] | None:
        """A bare or dotted name as written in `path`, seen from inside `caller`."""
        raw = raw.replace("::", ".")
        if "." in raw:
            recv, _, name = raw.rpartition(".")
            return self.resolve_attr(path, caller, recv, name, kinds)
        # A JS test case is named by its label string (`it('devtools', …)`), which no code can call: never a match.
        ok = (lambda d: d.kind in kinds) if kinds else (lambda d: d.kind not in ("test", "suite"))
        defs = self.defs[path]
        scope = caller if caller != MODULE else ""
        while scope:  # nearest enclosing scope first
            d = defs.get(f"{scope}.{raw}")
            if d is not None and ok(d) and d.qname != caller:
                return d, "local"
            scope = scope.rpartition(".")[0]
        d = self.top.get(path, {}).get(raw)
        if d is not None and ok(d):
            return d, "local"
        d = self._value_alias(path, raw)
        if d is not None and ok(d):
            return d, "local"
        b = self.binds.get(path, {}).get(raw)
        if b is not None:
            if b.symbol is None:
                return None  # a module, not a callable
            d = self.lookup(b.paths, b.symbol)
            if d is not None and ok(d):
                return d, "import"
            return None
        if raw in self.foreign.get(path, ()):
            return None
        f = self.files[path]
        if f.lang in ("go", "java", "rust"):
            peers = self.dir_files.get(posixpath.dirname(path), []) if f.lang != "java" else self.java_pkg.get(f.package, [])
            for p in sorted(peers):
                if p == path or (f.lang == "go" and p.endswith("_test.go") and not path.endswith("_test.go")):
                    continue
                d = self.top.get(p, {}).get(raw)
                if d is not None and ok(d) and (f.lang != "rust"):
                    return d, "package"
        for p in self.stars.get(path, []):
            d = self.lookup([p], raw)
            if d is not None and ok(d):
                return d, "star-import"
        cands = [d for d in self.by_name.get(raw, []) if ok(d) and d.path != path]
        if len(cands) == 1 and len(raw) > 3:
            return cands[0], "name-unique"
        return None

    def resolve_attr(self, path: str, caller: str, recv: str, name: str, kinds: set[str] | None = None) -> tuple[Def, str] | None:
        f = self.files[path]
        ok = (lambda d: d.kind in kinds) if kinds else (lambda d: True)
        if recv.startswith("<expr>:"):  # ", ".join(): a method of a builtin literal
            return None
        if "<expr>" in recv:
            return self._method_unique(name) if kinds is None else None
        root = recv.split(".")[0]
        # self/this/Self/super: the enclosing class and its bases
        if root in ("self", "this", "Self", "cls", "super", "super()") and "." not in recv or recv == "super()":
            cls = self.enclosing_class(path, caller)
            if cls is not None:
                for c in (self.bases(cls) if root.startswith("super") else [cls]):
                    d = self.member(c, name)
                    if d is not None and ok(d):
                        return d, "self"
            return None
        if root in self.foreign.get(path, ()) and not self._var_type(path, caller, root):
            return None  # np.array(), requests.get(), z.object(): a library call, not a repo method
        # alias.name / pkg.mod.name: longest receiver prefix that is a bound module
        aliases = self.module_aliases.get(path, {})
        parts = recv.split(".")
        for cut in range(len(parts), 0, -1):
            key = ".".join(parts[:cut])
            if "()" in key or "[]" in key:
                continue
            targets = aliases.get(key)
            b = self.binds.get(path, {}).get(key)
            if targets is None and b is not None and b.symbol is None:
                targets = b.paths
            if targets is None:
                continue
            leftover = parts[cut:]
            if leftover and f.lang == "python":  # import a  ->  a.b.c.f(): find module a.b.c
                mod = self.py_module(path, ".".join([key, *leftover]), 0)
                if mod:
                    d = self.lookup([mod], name)
                    return (d, "module-attr") if d is not None and ok(d) else None
            if not any(s.endswith("()") for s in leftover):
                sym = ".".join([*leftover, name])
                d = self.lookup(targets, sym)
                return (d, "module-attr") if d is not None and ok(d) else None
            break
        # A receiver whose type we can infer: x = Foo(); x.m()  /  self.repo.m()  /  get_graph().env().ro()
        cls = self.type_of(path, caller, recv)
        if cls is not None:
            d = self.member(cls, name)
            if d is not None and ok(d):
                return d, "inferred"
        if "()" in recv or "[]" in recv:
            return self._method_unique(name) if kinds is None else None
        # Class.method / Type::new on a class this file can see
        owner = self.resolve_name(path, caller, recv, kinds=CLASSY) if root[:1].isupper() or f.lang in ("rust", "go") else None
        if owner is not None:
            d = self.member(owner[0], name)
            if d is not None and ok(d):
                return d, "static"
        # Go/Rust: method on the caller's own receiver type, receiver named by a variable
        if f.lang in ("go", "rust") and "." not in recv:
            cls = self.enclosing_class(path, caller)
            if cls is not None:
                d = self.member(cls, name)
                if d is not None and ok(d):
                    return d, "receiver"
        return self._method_unique(name) if kinds is None else None

    def _method_unique(self, name: str) -> tuple[Def, str] | None:
        if name in GENERIC_METHODS or len(name) <= 3 or name.startswith("_"):
            return None
        cands = self.methods_by_name.get(name, [])
        return (cands[0], "method-unique") if len(cands) == 1 else None

    # ---- light type inference ------------------------------------------------------------------------------------
    def type_of(self, path: str, caller: str, recv: str, depth: int = 0) -> Def | None:
        """The class a receiver chain evaluates to, or None. Every step must be backed by a declared or assigned type."""
        key = (path, caller, recv)
        # resolve_attr and type_of call each other (`db: db.Conn`), so depth alone can't bound it: guard re-entry.
        if depth > 4 or "<expr>" in recv or key in self._typing or len(self._typing) > 12:
            return None
        self._typing.add(key)
        try:
            return self._type_of(path, caller, recv, depth)
        finally:
            self._typing.discard(key)

    def _type_of(self, path: str, caller: str, recv: str, depth: int) -> Def | None:
        if "[]" in recv:  # xs[0].m() / self.by_id[k].m(): an element of whatever the prefix is written as
            i = recv.rindex("[]")
            return self._walk(self._type_def(path, caller, f"item:{recv[:i]}", depth), recv[i + 2:].split(".")[1:], depth)
        segs = recv.split(".")
        first, rest = segs[0], segs[1:]
        name, is_call = first.removesuffix("()"), first.endswith("()")
        cur: Def | None = None
        if name in ("self", "this", "Self") and not is_call:
            cur = self.enclosing_class(path, caller)
        elif is_call and name.endswith("()"):  # create<T>()(init): only a curried factory is understood
            hit = self.resolve_name(path, caller, name[:-2])
            cur = self._result_type(hit[0], depth) if hit and hit[0].ret_hint.startswith("curry:") and not hit[0].returns else None
        elif is_call:
            hit = self.resolve_name(path, caller, name)
            fn = hit[0] if hit else self.callable_var(path, caller, name, depth + 1)
            cur = self._result_type(fn, depth) if fn is not None else None
        else:
            typ = self._var_type(path, caller, name)
            fx = None if typ else self._fixture(path, caller, name)
            imp = None if typ or fx is not None else self._import_var(path, name)
            if typ:
                cur = self._type_def(path, caller, typ, depth)
            elif fx is not None:
                cur = self._fixture_type(fx, depth)
            elif imp is not None:  # import { store } from "./store": typed where it is defined
                cur = self._type_def(imp[0], MODULE, imp[1], depth + 1)
            elif rest:
                targets = self.module_aliases.get(path, {}).get(name)
                b = self.binds.get(path, {}).get(name)
                if targets is None and b is not None and b.symbol is None:
                    targets = b.paths
                if targets:  # mod.func().x / mod.CONST.x
                    nxt, rest = rest[0], rest[1:]
                    d = self.lookup(targets, nxt.removesuffix("()"))
                    cur = self._result_type(d, depth) if d is not None and nxt.endswith("()") else None
        return self._walk(cur, rest, depth)

    def _walk(self, cur: Def | None, rest: list[str], depth: int) -> Def | None:
        for seg in rest:
            if cur is None:
                return None
            nm = seg.removesuffix("()")
            if seg.endswith("()"):
                m = self.member(cur, nm)
                cur = self._result_type(m, depth) if m is not None else None
            else:
                cur = self._attr_type(cur, nm, depth)
        return cur

    def _var_type(self, path: str, caller: str, name: str) -> str:
        defs = self.defs[path]
        scope = caller
        while True:
            d = defs.get(scope)
            if d is not None and name in d.types:
                return d.types[name]
            if scope == MODULE:
                return ""
            scope = scope.rpartition(".")[0] or MODULE

    def _import_var(self, path: str, name: str) -> tuple[str, str] | None:
        """An imported module-level variable (`export const api = createClient()`), as (defining path, its type)."""
        b = self.binds.get(path, {}).get(name)
        if b is None or not b.symbol or self.lookup(b.paths, b.symbol) is not None:
            return None
        for p in b.paths:
            mod = self.defs.get(p, {}).get(MODULE)
            t = mod.types.get(b.symbol, "") if mod is not None else ""
            if t and not t.startswith("alias:"):
                return p, t
        return None

    def _attr_type(self, cls: Def, name: str, depth: int) -> Def | None:
        w = self._declared_attr(cls, name)
        return self._type_def(*w, depth) if w else None

    def _declared_attr(self, cls: Def, name: str) -> tuple[str, str, str] | None:
        """How attribute `name` of `cls` is declared, as (path, scope, type): a typed or assigned field, or the return
        type of a `@property` (`result.output -> str`)."""
        for c in (cls, *self.bases(cls)):
            typ = c.types.get(name)
            if typ:
                return c.path, c.qname, typ
        m = self.member(cls, name)
        if m is not None and m.kind == "method" and PROPERTY_DECOS & {x.rpartition(".")[2] for x in m.decorators}:
            typ = m.returns or (m.ret_hint if m.ret_hint not in ("Self", "?") and not m.ret_hint.startswith(("yield:", "curry:")) else "")
            return (m.path, m.qname, typ) if typ else None
        return None

    def _result_type(self, d: Def, depth: int) -> Def | None:
        if d.kind in CLASSY:
            return d  # a constructor call evaluates to an instance of the class
        if d.name in CTOR_NAMES and "." in d.qname:  # Type::new(), Foo.<init>
            return self.enclosing_class(d.path, d.qname)
        typ = d.returns or (d.ret_hint if not d.ret_hint.startswith("yield:") else "")
        if typ.startswith("curry:"):
            return self.type_of(d.path, d.qname, typ[6:] + "()", depth + 1)
        if typ:
            if typ.strip() in ("Self", "this") and "." in d.qname:
                return self.enclosing_class(d.path, d.qname)
            return self._type_def(d.path, d.qname, typ, depth)
        return None

    def _fixture(self, path: str, caller: str, name: str) -> Def | None:
        """The pytest fixture an untyped test parameter receives: same class, same file, then conftest.py upwards."""
        f = self.files[path]
        if f.lang != "python" or not (f.is_test or path.endswith("conftest.py")):
            return None
        owner = self.defs[path].get(caller)
        if owner is None or name not in _param_names(owner):
            return None
        cls = self.enclosing_class(path, caller)
        local = self.defs[path].get(f"{cls.qname}.{name}") if cls is not None else None
        if local is not None and _is_fixture(local):
            return local
        d = posixpath.dirname(path)
        places = [path]
        while True:
            places.append(posixpath.join(d, "conftest.py") if d else "conftest.py")
            if not d:
                break
            d = posixpath.dirname(d)
        for p in places:
            if p in self.files:
                hit = self.resolve_name(p, MODULE, name)
                if hit is not None and _is_fixture(hit[0]):
                    return hit[0]
        return None

    def _fixture_type(self, fx: Def, depth: int) -> Def | None:
        if fx.returns:  # -> Iterator[Client] / Generator[Client, None, None] for a yield fixture
            m = re.match(r"(?:[\w.]+\.)?(?:Async)?(?:Iterator|Generator|Iterable)\[\s*([^,\]]+)", fx.returns.strip())
            return self._type_def(fx.path, fx.qname, m.group(1) if m else fx.returns, depth)
        typ = fx.ret_hint.removeprefix("yield:")
        return self._type_def(fx.path, fx.qname, typ, depth) if typ else None

    def _written(self, path: str, caller: str, recv: str, depth: int) -> tuple[str, str, str] | None:
        """The type a receiver chain is *written* with, as (path, scope, text), so a container keeps its element
        type: `self.jobs` -> list[Job]. Only declared types and returns count; a constructor is never a container."""
        if depth > 4 or "<expr>" in recv:
            return None
        if recv.endswith("[]"):
            w = self._written(path, caller, recv[:-2], depth + 1)
            return (w[0], w[1], _element(w[2], "item")) if w else None
        head, _, last = recv.rpartition(".")
        name = last.removesuffix("()")
        if last.endswith("()"):
            if head:
                cls = self.type_of(path, caller, head, depth + 1)
                d = self.member(cls, name) if cls is not None else None
            else:
                hit = self.resolve_name(path, caller, name)
                d = hit[0] if hit else None
            return (d.path, d.qname, d.returns) if d is not None and d.returns and d.kind not in CLASSY else None
        if not head:
            typ = self._var_type(path, caller, name)
            return self._expand(path, caller, typ, depth) if typ else None
        cls = self.type_of(path, caller, head, depth + 1)
        for c in (cls, *self.bases(cls)) if cls is not None else ():
            if c.types.get(name):
                return self._expand(c.path, c.qname, c.types[name], depth)
        return None

    def _expand(self, path: str, caller: str, typ: str, depth: int) -> tuple[str, str, str] | None:
        if typ.startswith("call:"):
            return self._written(path, caller, typ[5:] + "()", depth + 1)
        if typ.startswith(("iter:", "item:")):
            w = self._written(path, caller, typ[5:], depth + 1)
            return (w[0], w[1], _element(w[2], typ[:4])) if w else None
        if typ.startswith("alias:"):
            return path, MODULE, typ[6:]
        alias = self._alias(path, typ) if re.fullmatch(r"[\w.]+", typ) else None
        return (alias[0], MODULE, alias[1]) if alias else (path, caller, typ)

    def _alias(self, path: str, name: str, hops: int = 0) -> tuple[str, str] | None:
        """A module-level type alias (`Env = Annotated[EnvGraph, …]`) that `name` names in this file, defined here or
        imported, as (defining path, aliased type text)."""
        mod = self.defs.get(path, {}).get(MODULE)
        t = mod.types.get(name, "") if mod is not None else ""
        if t.startswith("alias:"):
            return path, t[6:]
        b = self.binds.get(path, {}).get(name)
        if b is None or not b.symbol or hops > 3:
            return None
        for p in b.paths:
            hit = self._alias(p, b.symbol, hops + 1)
            if hit:
                return hit
        return None

    def _type_def(self, path: str, caller: str, typ: str, depth: int) -> Def | None:
        if depth > 8:  # aliases and element types can chain; `A = A` must not loop
            return None
        if typ.startswith(("iter:", "item:")):  # for x in xs / xs[0]: the element type xs is declared with
            w = self._written(path, caller, typ[5:], depth + 1)
            el = _element(w[2], typ[:4]) if w else ""
            return self._type_def(w[0], w[1], el, depth + 1) if w and el else None
        if typ.startswith("with:"):  # `with X() as x`: x is what X.__enter__ returns, by convention X itself
            cm = self._type_def(path, caller, typ[5:], depth)
            enter = next((m for m in (self.member(cm, "__enter__"), self.member(cm, "__aenter__")) if m), None) if cm else None
            got = self._result_type(enter, depth + 1) if enter is not None else None
            return got or cm
        if typ.startswith("call:"):
            return self.type_of(path, caller, typ[5:] + "()", depth + 1)
        if typ.startswith(("obj:", "fn:")):
            return self._shape(path, caller, typ)
        if typ.startswith("cb:"):  # create((set, get, api) => …): what the factory passes that parameter
            b = self._cb_binding(path, caller, typ)
            return self.type_of(b[0], b[1], b[2], depth + 1) if b else None
        if typ.startswith("part:"):  # one name destructured out of a result: not typed
            return None
        if typ.startswith("prop:"):  # const { store } = make(): an attribute of what make() returns
            base, _, attr = typ[5:].rpartition(".")
            cls = self.type_of(path, caller, base, depth + 1)
            return self._attr_type(cls, attr, depth + 1) if cls is not None else None
        name = _type_name(typ)
        if not name:
            return None
        hit = self.resolve_name(path, caller, name, kinds=CLASSY)
        if hit is None and "." not in name:
            alias = self._alias(path, name)
            return self._type_def(alias[0], MODULE, alias[1], depth + 1) if alias else None
        return hit[0] if hit else None

    def _shape(self, path: str, caller: str, typ: str) -> Def | None:
        """The object a literal or a returned function evaluates to. `obj:k=ref;...=src` takes each `ref` as member `k`
        and every member of `src`; `fn:f` is the function f plus whatever `Object.assign(f, src)` merged into it."""
        key = (path, caller, typ)
        if key in self._shapes:
            return self._shapes[key]
        self._shapes[key] = None  # re-entry (`api = { ...api }`) sees nothing
        sd = Def(path=path, qname=f"{caller}.<object>#{len(self._shapes)}", name="<object>", kind="object", line=0, end_line=0)
        members, srcs = {}, []
        if typ.startswith("fn:"):
            hit = self.resolve_name(path, caller, typ[3:])
            if hit is None or hit[1] == "name-unique":
                return None
            if hit[0].kind in CLASSY:  # `return Foo`: the class object, whose static members are its members
                self._shapes[key] = hit[0]
                return hit[0]
            self._callable[sd.id] = hit[0]
            assigned = self._var_type(path, caller, "assign:" + typ[3:])
            srcs = assigned.split(";") if assigned else []
        else:
            for entry in typ[4:].split(";"):
                k, _, ref = entry.partition("=")
                if k == "...":
                    srcs.append(ref)
                    continue
                hit = self.resolve_name(path, caller, ref) if "()" not in ref else None
                if hit is not None and hit[1] != "name-unique":
                    members[k] = hit[0]
                elif "." not in ref and self._var_type(path, caller, ref):
                    sd.types[k] = self._var_type(path, caller, ref)  # `{ store: api }`: an attribute typed like api
        self._shape_bases[sd.id] = [t for t in (self.type_of(path, caller, s, 0) for s in srcs) if t is not None]
        self.members[sd.id] = members
        self._shapes[key] = sd
        return sd

    def callable_var(self, path: str, caller: str, name: str, depth: int = 0) -> Def | None:
        """`const useBoundStore = create(...); useBoundStore()`: a variable holding a function a factory returned.
        Also a callback parameter bound to a function (`set` -> setState) and an imported such variable."""
        typ = self._var_type(path, caller, name)
        if not typ:
            imp = self._import_var(path, name)
            path, caller, typ = (imp[0], MODULE, imp[1]) if imp else (path, caller, "")
        if not typ or typ.startswith(("iter:", "item:", "part:")) or depth > 4:
            return None
        if typ.startswith("prop:"):  # const { getState } = create(…)
            base, _, attr = typ[5:].rpartition(".")
            cls = self.type_of(path, caller, base, 1)
            m = self.member(cls, attr) if cls is not None else None
            return m if m is not None and m.kind in ("function", "method") else None
        if typ.startswith("cb:"):
            b = self._cb_binding(path, caller, typ)
            if b is None:
                return None
            hit = self.resolve_name(b[0], b[1], b[2])
            if hit is not None and hit[1] != "name-unique" and hit[0].kind in ("function", "method"):
                return hit[0]
            return self.callable_var(b[0], b[1], b[2], depth + 1) if "." not in b[2] else None
        sd = self._type_def(path, caller, typ, 0)
        return self._callable.get(sd.id) if sd is not None else None

    def _cb_binding(self, path: str, caller: str, typ: str) -> tuple[str, str, str] | None:
        """`cb:create#0#0` -> where the value of that callback parameter comes from, as (path, scope, expression):
        the argument the callee (followed through curried factories and parameters it hands on) calls it with."""
        head, *outer = typ[3:].split("@")
        callee, i, j = head.rsplit("#", 2)
        b = self._bind_arg(path, caller, callee, int(i), int(j))
        while b is not None:
            # The middleware called it with a parameter of the function it returns (`fn(set, get, api)`): that
            # value comes from whoever calls the middleware's result, the next call out.
            fn = self.defs[b[0]].get(b[1])
            ret = fn.types.get("retparams", "").split(",") if fn is not None else []
            if b[2].startswith("..."):  # (...args) => create(...args): position `off` of the rest
                root, _, off = b[2].rpartition("#")
                dot = rest = ""
                if not outer or root not in ret:
                    return None
                pos = ret.index(root) + int(off)
            else:
                root, dot, rest = b[2].partition(".")
                if not outer or root not in ret:
                    return b
                pos = ret.index(root)
            c2, _, k = outer.pop(0).rpartition("#")
            b2 = self._bind_arg(path, caller, c2, int(k), pos)
            b = (b2[0], b2[1], b2[2] + dot + rest) if b2 else None
        return None

    def _bind_arg(self, path: str, caller: str, callee: str, i: int, j: int) -> tuple[str, str, str] | None:
        curried = callee.endswith("()")  # create<T>()(cb): the curried factory's target takes cb
        hit = self.resolve_name(path, caller, callee.removesuffix("()"))
        if hit is None or hit[1] == "name-unique":
            return None
        fn = self._curried(hit[0]) if curried else hit[0]
        return self._param_use(fn, i, j, 0) if fn is not None else None

    def _curried(self, d: Def) -> Def | None:
        if not d.ret_hint.startswith("curry:") or d.returns:
            return None
        hit = self.resolve_name(d.path, d.qname, d.ret_hint[6:])
        return hit[0] if hit is not None and hit[1] != "name-unique" else None

    def _param_use(self, fn: Def, i: int, j: int, hops: int) -> tuple[str, str, str] | None:
        if hops > 5 or i >= len(fn.params):
            return None
        p = fn.params[i]
        args = fn.types.get("pcall:" + p)
        if args is not None:
            refs = args.split(",")
            spread = next((k for k, r in enumerate(refs) if r.startswith("...")), None)
            if spread is not None and j >= spread:
                return fn.path, fn.qname, f"{refs[spread]}#{j - spread}"
            return (fn.path, fn.qname, refs[j]) if j < len(refs) and refs[j] else None
        fwd = fn.types.get("pfwd:" + p)
        nxt: Def | None = None
        if fwd:
            g, _, k = fwd.rpartition("#")
            hit = self.resolve_name(fn.path, fn.qname, g)
            nxt, i = (hit[0], int(k)) if hit is not None and hit[1] != "name-unique" else (None, i)
        if nxt is None:
            nxt = self._curried(fn)  # createStore(cb) evaluates as createStoreImpl(cb)
        return self._param_use(nxt, i, j, hops + 1) if nxt is not None else None

    # ---- provably external calls -----------------------------------------------------------------------------------
    def is_external(self, path: str, caller: str, recv: str | None, name: str) -> bool:
        """Whether an unresolved call provably leaves the repo: a library import, a builtin or library type, a
        literal, or a JS global. These are counted apart from unresolved calls, which are the graph's blind spots."""
        f = self.files[path]
        if recv is None:
            if name in self.foreign.get(path, ()):
                return True
            typ = self._var_type(path, caller, name)
            if typ:  # const [n, setN] = useState(): a part of a library result
                return self._external_type(path, caller, typ, 0)
            if name in self.binds.get(path, {}):
                return self._reexports_foreign(path, name)
            return name in (JS_GLOBAL_FUNCS if f.lang in JSLIKE else _PY_EXTERNAL if f.lang == "python" else ())
        return self._external_recv(path, caller, recv, 0)

    def _reexports_foreign(self, path: str, name: str, seen: frozenset[str] = frozenset()) -> bool:
        """`import { cn } from "@/lib/utils"` where utils.ts is `export { cn } from "cn"`: the name is a library's."""
        b = self.binds.get(path, {}).get(name)
        if b is None or not b.symbol or "." in b.symbol:
            return False
        for p in b.paths:
            if p in seen or b.symbol in self.top.get(p, {}):
                continue
            if b.symbol in self.foreign.get(p, ()) or self._reexports_foreign(p, b.symbol, seen | {path}):
                return True
        return False

    def _external_recv(self, path: str, caller: str, recv: str, depth: int) -> bool:
        if recv.startswith("<expr>:"):  # a method of a literal: ", ".join(xs)
            return True
        if depth > 4 or "<expr>" in recv:
            return False
        f = self.files[path]
        head, _, last = recv.rpartition(".")
        if head and re.fullmatch(r"\w+(\(\))?", last):  # result.output.splitlines(): output is declared `-> str`
            cls = self.type_of(path, caller, head)
            if cls is not None:
                name = last.removesuffix("()")
                if last.endswith("()"):
                    m = self.member(cls, name)
                    return m is not None and bool(m.returns) and self._external_type(m.path, m.qname, m.returns, depth + 1)
                w = self._declared_attr(cls, name)
                return w is not None and self._external_type(*w, depth + 1)
        root = re.split(r"[.(\[]", recv, maxsplit=1)[0]
        if root in ("self", "this"):
            segs = recv.split(".")
            cls = self.enclosing_class(path, caller)
            if cls is None or len(segs) < 2 or not re.fullmatch(r"\w+", segs[1]):
                return False
            for c in (cls, *self.bases(cls)):
                if c.types.get(segs[1]):
                    return self._external_type(c.path, c.qname, c.types[segs[1]], depth)
            return False
        typ = self._var_type(path, caller, root)
        if typ:
            return self._external_type(path, caller, typ, depth)
        if root in self.foreign.get(path, ()) or self._reexports_foreign(path, root):
            return True
        imp = self._import_var(path, root)
        if imp is not None:
            return self._external_type(imp[0], MODULE, imp[1], depth + 1)
        if f.lang == "python" and re.fullmatch(r"\w+", root):  # client.get().json(): all of a library object is library
            owner = self.defs[path].get(caller)
            raw = next((p for p in owner.params if re.split(r"[:=\s]", p.lstrip("*"), maxsplit=1)[0] == root), None) if owner else None
            if raw is not None and raw.startswith("*"):
                return True  # *args / **kwargs: a tuple / dict
            fx = self._fixture(path, caller, root)
            if fx is not None:
                t = fx.returns or fx.ret_hint.removeprefix("yield:")
                return bool(t) and self._external_type(fx.path, fx.qname, t, depth + 1)
            if raw is not None and root in PYTEST_FIXTURES and self.files[path].is_test:
                return True
        if root in self.binds.get(path, {}) or root in self.module_aliases.get(path, {}) or root in self.top.get(path, {}):
            return False
        if f.lang in JSLIKE:
            return root in JS_GLOBALS or (root in JS_GLOBAL_FUNCS and recv.startswith(root + "("))
        if f.lang == "python":
            return recv.startswith(root + "(") and root in _PY_EXTERNAL  # str(x).lower()
        return False

    def _external_type(self, path: str, caller: str, typ: str, depth: int) -> bool:
        if typ.startswith("call:"):
            return self._external_recv(path, caller, typ[5:] + "()", depth + 1)
        if typ.startswith(("part:", "prop:")):
            base = typ[5:] if typ.startswith("part:") else typ[5:].rpartition(".")[0]
            return self._external_recv(path, caller, base, depth + 1)
        if typ.startswith("cb:"):  # app.get("/", (req, res) => …): a callback a library calls gets library values
            callee = typ[3:].split("@")[0].rsplit("#", 2)[0].removesuffix("()")
            recv, _, name = callee.rpartition(".")
            return (self.resolve_name(path, caller, callee) is None
                    and self.is_external(path, caller, recv or None, name))
        if typ.startswith("with:"):  # with TestClient(app) as c: what a library's context manager yields is library
            return self._external_type(path, caller, typ[5:], depth + 1)
        if typ.startswith(("iter:", "item:", "alias:", "obj:", "fn:")):
            return False
        head = re.split(r"[\s\[<|]", typ.strip().lstrip("*&"), maxsplit=1)[0]
        if head in BUILTIN_TYPES:
            return True
        if head in self.foreign.get(path, ()) or self._reexports_foreign(path, head):  # from tree_sitter import Node
            return head not in self.top.get(path, {})
        pkg = head.split(".")[0]
        return "." in head and pkg in self.foreign.get(path, ()) and pkg not in self.module_aliases.get(path, {})

    def enclosing_class(self, path: str, caller: str) -> Def | None:
        defs = self.defs[path]
        q = caller
        while "." in q:
            q = q.rpartition(".")[0]
            d = defs.get(q)
            if d is not None and d.kind in CLASSY:
                return d
            if d is None:  # Go / Rust: Type.method where Type lives in another file of the package
                for p in self.dir_files.get(posixpath.dirname(path), []):
                    d = self.defs[p].get(q)
                    if d is not None and d.kind in CLASSY:
                        return d
        return None

    # ---- driver --------------------------------------------------------------------------------------------------
    def run(self) -> Resolution:
        for f in self.files.values():
            self.bind_file(f)
        edges: dict[tuple[str, str, str], Edge] = {}
        unresolved: dict[str, int] = defaultdict(int)
        external: dict[str, int] = defaultdict(int)
        ambiguous: dict[str, int] = defaultdict(int)
        for path in sorted(self.files):
            f = self.files[path]
            for c in f.calls:
                if f.lang == "python" and c.receiver is None and c.name in _PY_BUILTINS:
                    continue
                if c.kind == "ref":
                    # An identifier passed as a value is usually a variable; bind it only when scoping or imports
                    # prove it names a function/class, and never count a miss as an unresolved call.
                    owner = self.defs[path].get(c.caller)
                    if owner is not None and (c.name in owner.types or c.name in _param_names(owner)):
                        continue
                    hit = (self.resolve_name(path, c.caller, c.name, kinds=REFERABLE) if c.receiver is None
                           else self.resolve_attr(path, c.caller, c.receiver, c.name, kinds=REFERABLE))
                    if hit is None or hit[1] not in REF_HOW:
                        continue
                elif c.receiver is None:
                    hit = self.resolve_name(path, c.caller, c.name)
                    if hit is None and c.kind == "call":
                        fn = self.callable_var(path, c.caller, c.name)
                        hit = (fn, "inferred") if fn is not None else None
                else:
                    hit = self.resolve_attr(path, c.caller, c.receiver, c.name)
                if hit is None:
                    if c.kind == "jsx":  # an unresolved <Foo/> is almost always a library component
                        continue
                    if self.is_external(path, c.caller, c.receiver, c.name):
                        external[path] += 1
                    elif c.kind != "ref":
                        unresolved[path] += 1
                    continue
                d, how = hit
                src = sym_id(path, c.caller)
                if d.id == src:
                    continue  # direct recursion adds nothing to impact
                kind = c.kind if c.kind in ("ref", "jsx") else "new" if c.kind == "new" or d.kind in CLASSY else "call"
                key = (src, d.id, "CALLS")
                e = edges.get(key)
                if e is None:
                    e = edges[key] = Edge(src, d.id, "CALLS", how, CONFIDENCE[how], kind=kind)
                elif CONFIDENCE[how] > e.confidence:
                    e.how, e.confidence = how, CONFIDENCE[how]
                e.lines.append(c.line)
                e.args.append(c.args)
            for d in f.defs:
                if not d.bases:
                    continue
                for raw in d.bases:
                    hit = self.resolve_name(path, MODULE, raw, kinds=CLASSY)
                    if hit is None or hit[0].id == d.id:
                        continue
                    t = "IMPLEMENTS" if hit[0].kind in ("interface", "trait") else "INHERITS"
                    edges.setdefault((d.id, hit[0].id, t), Edge(d.id, hit[0].id, t, hit[1], CONFIDENCE[hit[1]], lines=[d.line]))
            for ty, trait in f.impls:
                own = self.resolve_name(path, MODULE, ty, kinds=CLASSY)
                tr = self.resolve_name(path, MODULE, trait, kinds=CLASSY)
                if own and tr:
                    edges.setdefault((own[0].id, tr[0].id, "IMPLEMENTS"),
                                     Edge(own[0].id, tr[0].id, "IMPLEMENTS", tr[1], CONFIDENCE[tr[1]]))
        # Go interfaces are satisfied structurally: a struct implements an interface when it has every method.
        self._go_structural(edges)
        self._overrides(edges)
        return Resolution(edges=sorted(edges.values(), key=lambda e: (e.src, e.dst, e.type)),
                          file_links=sorted(self.file_links.values(), key=lambda fl: (fl.src, fl.dst)),
                          externals=dict(self.externals), unresolved=dict(unresolved), ambiguous=dict(ambiguous),
                          external=dict(external))

    def _go_structural(self, edges: dict[tuple[str, str, str], Edge]) -> None:
        ifaces: list[tuple[Def, set[str]]] = []
        structs: dict[str, tuple[Def, set[str]]] = {}
        for f in self.files.values():
            if f.lang != "go":
                continue
            for d in f.defs:
                if d.kind == "interface":
                    ms = set(self.members.get(d.id, {}))
                    if ms:
                        ifaces.append((d, ms))
                elif d.kind == "struct":
                    structs[d.id] = (d, set())
        for f in self.files.values():
            if f.lang != "go":
                continue
            pkg_dir = posixpath.dirname(f.path)
            for d in f.defs:
                if d.kind == "method" and "." in d.qname and self.defs[f.path].get(d.qname.split(".")[0]) is None:
                    for p in self.dir_files.get(pkg_dir, []):
                        owner = sym_id(p, d.qname.split(".")[0])
                        if owner in structs:
                            structs[owner][1].add(d.name)
                elif d.kind == "method" and "." in d.qname:
                    owner = sym_id(f.path, d.qname.split(".")[0])
                    if owner in structs:
                        structs[owner][1].add(d.name)
        for sd, have in structs.values():
            for iface, need in ifaces:
                if need <= have:
                    edges.setdefault((sd.id, iface.id, "IMPLEMENTS"), Edge(sd.id, iface.id, "IMPLEMENTS", "structural", 0.8))


    def _overrides(self, edges: dict[tuple[str, str, str], Edge]) -> None:
        """(Child.m)-[:OVERRIDES]->(Base.m) for each method that redefines the nearest inherited one. A call bound to
        Base.m can run Child.m, and Child.m has to keep a compatible signature. Constructors are not overrides: they
        are reached through explicit super() calls, which are already CALLS edges."""
        by_id = {d.id: d for f in self.files.values() for d in f.defs}
        for (src, dst, t), e in list(edges.items()):
            if t not in ("INHERITS", "IMPLEMENTS") or src not in by_id or dst not in by_id:
                continue
            owners = [src, *self._types_named(by_id[src])]
            for name in sorted({n for o in owners for n in self.members.get(o, {})}):
                if name in CTOR_NAMES or (name.startswith("__") and not name.endswith("__")):  # mangled: private
                    continue
                m = next(self.members[o][name] for o in owners if name in self.members.get(o, {}))
                base = self.member(by_id[dst], name)
                if m.kind != "method" or base is None or base.kind != "method" or base.id == m.id:
                    continue
                edges.setdefault((m.id, base.id, "OVERRIDES"),
                                 Edge(m.id, base.id, "OVERRIDES", e.how, e.confidence, lines=[m.line]))


CONFIDENCE["structural"] = 0.8

_WRAPPERS = {
    "Optional", "Box", "Rc", "Arc", "RefCell", "Mutex", "RwLock", "Promise", "Awaitable", "Option", "Result",
    "Readonly", "Partial", "Required", "Annotated", "Final", "ClassVar", "Coroutine", "Cow",
}
_CONTAINERS = {
    "list", "List", "dict", "Dict", "set", "Set", "frozenset", "tuple", "Tuple", "Vec", "HashMap", "BTreeMap",
    "HashSet", "Map", "Array", "ReadonlyArray", "Sequence", "Iterable", "Iterator", "Generator", "AsyncIterator",
    "AsyncGenerator", "Record", "Mapping", "Callable", "type", "Type", "Any", "object", "unknown", "any",
}
_NONE = {"None", "null", "undefined", "nil", "void", "", "never"}
_SEQS = {
    "list", "List", "Sequence", "MutableSequence", "Iterable", "Iterator", "Collection", "Reversible", "set", "Set",
    "frozenset", "FrozenSet", "AbstractSet", "MutableSet", "deque", "Deque", "KeysView", "ValuesView", "Generator",
    "AsyncIterator", "AsyncIterable", "AsyncGenerator", "Array", "ReadonlyArray", "ReadonlySet", "IterableIterator",
    "Vec", "VecDeque", "HashSet", "BTreeSet", "LinkedList", "ArrayList", "Stream",
}
_MAPS = {
    "dict", "Dict", "Mapping", "MutableMapping", "defaultdict", "DefaultDict", "OrderedDict", "ChainMap", "Map",
    "ReadonlyMap", "WeakMap", "Record", "HashMap", "BTreeMap", "IndexMap", "TreeMap", "LinkedHashMap",
}


def _split_top(s: str, sep: str) -> list[str]:
    """Split on `sep` outside brackets: "dict[str, list[A]], B" -> ["dict[str, list[A]]", " B"]."""
    out, depth, cur = [], 0, ""
    for ch in s.replace("=>", "\u2192"):  # an arrow's `>` closes nothing
        depth += ch in "[<(" and 1 or (ch in "]>)" and -1 or 0)
        if ch == sep and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    return [*out, cur]


def _element(t: str, which: str) -> str:
    """The element type of a written container type. `iter` is what iterating yields (a mapping's key), `item` what
    subscripting yields (a mapping's value): list[A] -> A, A[] -> A, []A -> A, dict[K, V] -> K / V, Map<K, V> -> - / V."""
    parts = [x.strip().removesuffix("?") for x in _split_top(t.strip().strip("'\""), "|")]
    parts = [x for x in parts if x not in _NONE]
    if len(parts) != 1:
        return ""
    t = parts[0]
    if t.endswith("[]"):
        return t[:-2]
    if t.startswith("[]"):  # Go slice
        return t[2:]
    m = re.match(r"map\[([^\]]+)\](.+)$", t)  # Go map
    if m:
        return m.group(2) if which == "item" else m.group(1)
    m = re.match(r"([A-Za-z_][\w.:]*)\s*[\[<](.*)[\]>]$", t)
    if not m:
        return ""
    base, args = m.group(1).replace("::", ".").rsplit(".", 1)[-1], [a.strip() for a in _split_top(m.group(2), ",")]
    if base in _WRAPPERS:
        return _element(args[0], which)
    if base in _SEQS:
        return args[0]
    if base in ("tuple", "Tuple"):  # tuple[A, ...] or tuple[A, A]
        return args[0] if len(set(args) - {"..."}) == 1 else ""
    if base in _MAPS and len(args) == 2:
        return args[1] if which == "item" else "" if base in ("Map", "ReadonlyMap", "WeakMap", "Record") else args[0]
    return ""


def _is_fixture(d: Def) -> bool:
    return any(x.rsplit(".", 1)[-1] == "fixture" for x in d.decorators)


def _type_name(t: str) -> str:
    """The class name a written type refers to: Optional[Graph] -> Graph, *pkg.Svc -> pkg.Svc, Vec<T> -> ''."""
    t = t.strip().strip("'\"").replace("&", "").replace("*", "").replace("mut ", "").replace("dyn ", "").replace("impl ", "")
    if t.startswith("(") and t.endswith(")") and "=>" not in t:  # Go: (*S, error) -> the first result
        t = t[1:-1].split(",")[0].strip()
    for part in re.split(r"\s*\|\s*", t):
        part = part.strip().removesuffix("?")
        if part in _NONE:
            continue
        if part.endswith("[]"):
            return ""
        m = re.match(r"([A-Za-z_][\w.:]*)\s*(?:[\[<](.*)[\]>])?$", part)
        if not m:
            return ""
        head, inner = m.group(1).replace("::", "."), m.group(2)
        base = head.rsplit(".", 1)[-1]
        if base in _WRAPPERS and inner:
            return _type_name(inner.split(",")[0])
        if base in _CONTAINERS or base in _NONE:
            return ""
        return head
    return ""

# Types whose methods are never repo code: a receiver declared or assigned as one is a builtin call.
BUILTIN_TYPES = {
    "str", "bytes", "bytearray", "int", "float", "complex", "bool", "list", "dict", "set", "frozenset", "tuple",
    "List", "Dict", "Set", "FrozenSet", "Tuple", "string", "number", "boolean", "bigint", "Array", "ReadonlyArray",
    "Map", "ReadonlyMap", "Record", "RegExp", "Date", "String", "Number", "Boolean", "Uint8Array", "ArrayBuffer",
}
JS_GLOBALS = {
    "Math", "Object", "JSON", "Date", "Array", "Number", "String", "Boolean", "Promise", "Reflect", "Symbol", "Intl",
    "console", "window", "document", "navigator", "localStorage", "sessionStorage", "performance", "globalThis",
    "process", "Buffer", "crypto", "location", "history", "URL", "URLSearchParams", "Error", "BigInt", "Proxy",
    "Atomics", "WebAssembly", "Response", "Request", "Headers",
}
JS_GLOBAL_FUNCS = {
    "parseInt", "parseFloat", "isNaN", "isFinite", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask", "structuredClone", "fetch", "require",
    "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI", "atob", "btoa", "String", "Number",
    "Boolean", "Array", "Symbol", "BigInt", "Date", "Error", "TypeError", "RangeError", "Promise", "Map", "Set",
    "WeakMap", "WeakSet", "RegExp", "URL", "URLSearchParams", "alert", "confirm", "getComputedStyle",
}

_PY_EXTERNAL = frozenset(n for n in dir(builtins) if not n.startswith("_"))  # incl. exceptions; never shadowed here
# pytest's own fixtures: an untyped test parameter with one of these names is a library object
PROPERTY_DECOS = {"property", "cached_property", "cached"}
PYTEST_FIXTURES = {"monkeypatch", "capsys", "capfd", "capsysbinary", "capfdbinary", "caplog", "tmp_path", "tmpdir",
                   "tmp_path_factory", "tmpdir_factory", "request", "recwarn", "pytestconfig", "record_property",
                   "mocker", "doctest_namespace", "cache"}
_PY_BUILTINS = {
    "print", "len", "range", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "isinstance", "getattr",
    "setattr", "hasattr", "super", "type", "open", "sorted", "min", "max", "sum", "any", "all", "enumerate", "zip",
    "map", "filter", "repr", "iter", "next", "abs", "round", "id", "hash", "vars", "object", "Exception",
    "ValueError", "TypeError", "KeyError", "RuntimeError", "NotImplementedError", "frozenset", "bytes", "format",
    "issubclass", "callable", "divmod", "pow", "reversed", "slice", "property", "staticmethod", "classmethod",
}


def resolve(files: list[FileFacts], cfg: RepoConfig | None = None) -> Resolution:
    return Resolver(files, cfg).run()
