"""Facts one file yields, before any cross-file resolution. Pure data: the parser fills them, `resolve` links them.

Ids follow Tessera's node key: `<repo-relative path>::<qualname>`, and every file has a `<module>` pseudo-symbol that
owns top-level statements (calls made at import time, a test file's `describe/it` callbacks, Go `init`).
"""

from __future__ import annotations

from dataclasses import dataclass, field

MODULE = "<module>"


def sym_id(path: str, qname: str) -> str:
    return f"{path}::{qname}"


@dataclass(slots=True)
class Def:
    path: str
    qname: str  # Class.method, outer.inner, <module>
    name: str
    kind: str  # module, function, method, class, interface, struct, enum, trait, type
    line: int
    end_line: int
    params: list[str] = field(default_factory=list)
    signature: str = ""
    digest: str = ""  # normalized body: comments, whitespace and positions excluded (Tessera fingerprint)
    sig_digest: str = ""  # name + parameters + return type + decorators: the contract callers see
    complexity: int = 1
    doc: str = ""
    exported: bool = True
    is_test: bool = False
    bases: list[str] = field(default_factory=list)  # raw names of superclasses / implemented interfaces
    decorators: list[str] = field(default_factory=list)
    min_args: int = 0  # required positional arguments a caller must pass (self/receiver excluded)
    max_args: int = 0  # -1 when variadic
    returns: str = ""  # declared return type as written
    # Light type facts for receiver resolution. Functions: local/param name -> type text or "call:<callee>".
    # Classes: attribute name -> the same (self.x = Foo(), field declarations, TS constructor parameter properties).
    types: dict[str, str] = field(default_factory=dict)
    # What calls to it evaluate to when no return type is declared, read from the body: the one type every `return`
    # agrees on ("Self" for `return self`), "" when they disagree or any is unknown. Generators: "yield:<type or ''>".
    ret_hint: str = ""
    # Modules only: top-level value name -> digest of the statements that bind it (`TIMEOUT = 5`, `export const
    # LIMITS = {...}`). A changed value seeds the module, and code that reads the name depends on it (CALLS kind read).
    values: dict[str, str] = field(default_factory=dict)

    @property
    def id(self) -> str:
        return sym_id(self.path, self.qname)

    @property
    def parent(self) -> str | None:
        return self.qname.rsplit(".", 1)[0] if "." in self.qname and self.qname != MODULE else None

    @property
    def loc(self) -> int:
        return self.end_line - self.line + 1


@dataclass(slots=True)
class Call:
    caller: str  # qname of the innermost enclosing definition (or <module>)
    name: str  # the called name: `bar` in foo.bar(), Bar in new Bar()
    receiver: str | None  # `foo` in foo.bar(); `self`/`this` for method calls on the instance; dotted for a.b.c()
    line: int
    # call | new | ref (a function passed as a value) | jsx | read (a module-level value read by name) |
    # dunder (`len(x)`, `x[i]`, `a + b`, `with x`, `for _ in x`: a protocol method the syntax runs) | prop (`x.attr` read)
    kind: str = "call"
    # Positional argument count at the call site; -1 when it contains a spread / unknown. A Python call that also passes
    # keywords is stored as -(positional + 2): keywords can fill required slots, so only the upper bound is checkable.
    args: int = -1


@dataclass(slots=True)
class Import:
    module: str  # as written: `pkg.mod`, `./util`, `github.com/x/y`, `crate::a::b`
    names: list[tuple[str, str]] = field(default_factory=list)  # (imported name, local alias); ("*", "*") for a star
    alias: str | None = None  # local name bound to the module itself (`import x as y`, `import * as ns`)
    level: int = 0  # Python relative-import dots
    line: int = 0


@dataclass(slots=True)
class FileFacts:
    path: str
    lang: str
    sha: str
    loc: int
    is_test: bool
    defs: list[Def] = field(default_factory=list)
    calls: list[Call] = field(default_factory=list)
    imports: list[Import] = field(default_factory=list)
    impls: list[tuple[str, str]] = field(default_factory=list)  # (type name, trait/interface) from Rust `impl T for X`
    package: str = ""  # Go package / Java package declared in the file
    error: str | None = None  # set when the parser gave up; the file still gets a node and its sha
