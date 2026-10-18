"""Tree-sitter extraction: one source file in, `FileFacts` out. No I/O, no graph, no cross-file knowledge.

One generic walker plus per-language tables. It records definitions (with a normalized-body digest and a separate
signature digest, after Tessera's AST fingerprints), call sites (with argument counts, so a signature change can be
checked against every caller), and imports as written. Resolution happens later in `resolve.py`.

Fingerprints: a definition's digest hashes its leaf tokens with comments, the docstring and its own name left out,
and every nested definition replaced by a placeholder (so editing a method changes the method, not its class). Body
edits change `digest` only; parameter/return/decorator edits change `sig_digest`. Same digest + different name is a
rename.
"""

from __future__ import annotations

import hashlib
import re
import sys
from collections.abc import Iterator
from functools import cache

from tree_sitter import Node, Parser
from tree_sitter_language_pack import get_parser

from .model import MODULE, Call, Def, FileFacts, Import

PARSER_VERSION = "13"  # bump whenever extraction output changes; it is folded into every file's freshness key

EXTENSIONS = {
    ".py": "python", ".pyi": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
    ".go": "go", ".java": "java", ".rs": "rust",
}
LANGS = sorted(set(EXTENSIONS.values()))
JSLIKE = {"javascript", "typescript", "tsx"}
CASTS = {"as_expression", "satisfies_expression", "non_null_expression", "parenthesized_expression"}
CLASSLIKE = {"class", "interface", "struct", "trait", "enum", "impl", "suite"}

MAX_BYTES = 1_000_000  # bigger files are almost always generated or vendored
COMMENTS = {"comment", "line_comment", "block_comment"}
# Nodes that open a new function body: a `return` belongs to the nearest one, which may be an anonymous callback.
FUNC_NODES = {
    "function_definition", "lambda", "function_declaration", "function_expression", "arrow_function", "function",
    "method_definition", "generator_function_declaration", "generator_function", "method_declaration", "func_literal",
    "function_item", "closure_expression", "lambda_expression", "constructor_declaration",
}
NULLISH = {"None", "null", "undefined", "nil"}
# Literals whose type is a builtin; calls on them never reach repo code
LITERALS = {
    **{("python", t): ty for t, ty in (("list", "list"), ("list_comprehension", "list"), ("dictionary", "dict"),
                                       ("dictionary_comprehension", "dict"), ("set", "set"), ("set_comprehension", "set"),
                                       ("string", "str"), ("concatenated_string", "str"), ("integer", "int"),
                                       ("float", "float"), ("tuple", "tuple"))},
    **{(lang, t): ty for lang in ("javascript", "typescript", "tsx")
       for t, ty in (("array", "Array"), ("string", "string"), ("template_string", "string"), ("number", "number"),
                     ("regex", "RegExp"))},
}
# Array methods whose callback's first parameter is an element of the receiver: xs.forEach((x) => x.m())
ELEMENT_CALLBACKS = {"forEach", "map", "filter", "find", "findLast", "some", "every", "flatMap", "findIndex"}
# Calls that iterate their argument's elements unchanged: for x in sorted(xs) / for x in xs.iter()
SAME_ELEMENTS = {"sorted", "reversed", "list", "tuple", "set", "frozenset", "iter", "iter_mut", "into_iter", "copy"}

# Definition node type -> kind. A variable_declarator only counts when its value is a function (see _def_info).
DEFS: dict[str, dict[str, str]] = {
    "python": {"function_definition": "function", "class_definition": "class"},
    "javascript": {
        "function_declaration": "function", "generator_function_declaration": "function",
        "class_declaration": "class", "method_definition": "method", "variable_declarator": "function",
    },
    "go": {"function_declaration": "function", "method_declaration": "method", "type_spec": "type", "method_elem": "method"},
    "java": {
        "class_declaration": "class", "interface_declaration": "interface", "enum_declaration": "enum",
        "record_declaration": "class", "method_declaration": "method", "constructor_declaration": "method",
    },
    "rust": {
        "function_item": "function", "function_signature_item": "method", "struct_item": "struct",
        "enum_item": "enum", "trait_item": "trait", "mod_item": "module", "type_item": "type",
    },
}
DEFS["typescript"] = DEFS["tsx"] = {
    **DEFS["javascript"],
    "abstract_class_declaration": "class", "interface_declaration": "interface", "enum_declaration": "enum",
    "type_alias_declaration": "type", "method_signature": "method", "abstract_method_signature": "method",
}

# Nodes that add a decision point (cyclomatic complexity = 1 + count). Operator tokens count too.
BRANCHES: dict[str, set[str]] = {
    "python": {
        "if_statement", "elif_clause", "for_statement", "while_statement", "except_clause", "with_statement",
        "conditional_expression", "list_comprehension", "dictionary_comprehension", "set_comprehension",
        "generator_expression", "case_clause", "and", "or",
    },
    "javascript": {
        "if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "catch_clause",
        "ternary_expression", "switch_case", "&&", "||", "??",
    },
    "go": {"if_statement", "for_statement", "expression_case", "type_case", "communication_case", "&&", "||"},
    "java": {
        "if_statement", "for_statement", "enhanced_for_statement", "while_statement", "do_statement",
        "catch_clause", "ternary_expression", "switch_label", "&&", "||",
    },
    "rust": {"if_expression", "for_expression", "while_expression", "loop_expression", "match_arm", "&&", "||", "?"},
}
BRANCHES["typescript"] = BRANCHES["tsx"] = BRANCHES["javascript"]

OPTIONAL_PARAMS = {
    "default_parameter", "typed_default_parameter", "optional_parameter", "assignment_pattern",
}
VARIADIC_PARAMS = {
    "list_splat_pattern", "dictionary_splat_pattern", "rest_pattern", "variadic_parameter_declaration",
    "spread_parameter", "variadic_parameter",
}
RECEIVER_PARAMS = {"self_parameter"}

GO_TEST = re.compile(r"^(Test|Benchmark|Fuzz|Example)")
JS_TEST_CALLS = {"it", "test", "describe", "suite", "context", "specify"}
JAVA_TEST_ANN = {"Test", "ParameterizedTest", "RepeatedTest", "TestFactory", "TestTemplate"}
RUST_TEST_ATTR = {"test", "tokio::test", "rstest", "async_std::test", "test_case"}


def lang_for(path: str) -> str | None:
    dot = path.rfind(".")
    return EXTENSIONS.get(path[dot:].lower()) if dot >= 0 else None


def is_test_path(path: str, lang: str) -> bool:
    parts = path.lower().split("/")
    name, dirs = parts[-1], set(parts[:-1])
    if lang == "python":
        return name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py" or bool(dirs & {"tests", "test"})
    if lang in JSLIKE:
        return ".test." in name or ".spec." in name or bool(dirs & {"__tests__", "test", "tests", "e2e", "__mocks__"})
    if lang == "go":
        return name.endswith("_test.go")
    if lang == "java":
        return "src/test/" in path.lower() or bool(re.search(r"(test|tests|it)\.java$", name))
    if lang == "rust":
        return parts[0] == "tests" or "tests" in dirs
    return False


def file_sha(data: bytes) -> str:
    return hashlib.blake2b(data, digest_size=16).hexdigest()


def _digest(parts: list[str]) -> str:
    return hashlib.blake2b("\x1f".join(parts).encode(), digest_size=10).hexdigest()


@cache
def _parser(lang: str) -> Parser:
    return get_parser(lang)  # type: ignore[arg-type]


def _squash(s: str, limit: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _strip_generics(s: str) -> str:
    return s.split("<", 1)[0].split("[", 1)[0].strip()


def _deco_name(raw: str) -> str:
    s = raw.strip().lstrip("@").removeprefix("#[").removesuffix("]").strip()
    return s.split("(", 1)[0].strip()


def _agree(vals: list[str], types: dict[str, str], inner: set[str] = frozenset()) -> str:  # type: ignore[assignment]
    """The one type every non-null return agrees on, or "" (any unknown return makes the whole thing unknown).
    Returning a nested function (`return useBoundStore`) is `fn:<name>`: the function value itself."""
    seen = {types.get(v[1:], f"fn:{v[1:]}" if v[1:] in inner else "?") if v.startswith("@") else v for v in vals if v}
    return seen.pop() if len(seen) == 1 and "?" not in seen else ""


def parse_file(path: str, data: bytes, lang: str | None = None) -> FileFacts:
    lang = lang or lang_for(path) or ""
    facts = FileFacts(path=path, lang=lang, sha=file_sha(data), loc=data.count(b"\n") + (0 if data.endswith(b"\n") else 1),
                      is_test=is_test_path(path, lang))
    if lang not in DEFS:
        facts.error = "unsupported language"
        return facts
    if len(data) > MAX_BYTES:
        facts.error = f"skipped: larger than {MAX_BYTES} bytes"
        return facts
    if lang in JSLIKE and facts.loc and len(data) / facts.loc > 400:
        facts.error = "skipped: looks minified"
        return facts
    try:
        tree = _parser(lang).parse(data)
        _Extractor(facts, data, tree.root_node).run()
    except RecursionError:
        facts.defs, facts.calls, facts.imports = [], [], []
        facts.error = "skipped: syntax tree too deep"
    return facts


class _Extractor:
    def __init__(self, facts: FileFacts, src: bytes, root: Node):
        self.f = facts
        self.lang = facts.lang
        self.src = src
        self.root = root
        self.defs = DEFS[self.lang]
        self.branches = BRANCHES[self.lang]
        self.scope: list[tuple[str, str]] = []  # (qname, kind), innermost last; <module> is implicit
        self.def_stack: list[Def | None] = []  # parallel to scope; None for a Rust impl block
        self.ret_stack: list[tuple[Node | None, list[str], list[str]]] = []  # per def: (function node, returns, yields)
        self.seen: dict[str, int] = {}
        self.exporting = False
        self.saw_export = False
        self.export_names: set[str] = set()

    # ---- helpers -------------------------------------------------------------------------------------------------
    def text(self, n: Node | None) -> str:
        return self.src[n.start_byte : n.end_byte].decode("utf-8", "replace") if n is not None else ""

    @property
    def caller(self) -> str:
        return self.scope[-1][0] if self.scope else MODULE

    def receiver(self, n: Node | None) -> str | None:
        if n is None:
            return None
        s = self.chain(n)
        return s if len(s) <= 120 else "<expr>"

    def chain(self, n: Node, depth: int = 0) -> str:
        """A receiver as a resolvable chain: `self.repo`, `get_graph().env()`, `Foo.new()`; anything else is <expr>."""
        t = n.type
        if depth > 8:
            return "<expr>"
        if t in ("identifier", "this", "self", "super", "type_identifier", "field_identifier", "property_identifier",
                 "package_identifier", "crate"):
            return self.text(n)
        if t in ("attribute", "member_expression", "selector_expression", "field_expression", "field_access"):
            obj = n.child_by_field_name("object") or n.child_by_field_name("operand") or n.child_by_field_name("value")
            prop = (n.child_by_field_name("attribute") or n.child_by_field_name("property") or n.child_by_field_name("field"))
            if obj is None or prop is None:
                return "<expr>"
            return f"{self.chain(obj, depth + 1)}.{self.text(prop)}"
        if t == "scoped_identifier":
            return self.text(n).replace("::", ".")
        if (self.lang, t) in LITERALS:  # ", ".join(xs): a builtin value, so the call provably leaves the repo
            return "<expr>:" + LITERALS[(self.lang, t)]
        if t in ("call", "call_expression"):
            fn = n.child_by_field_name("function")
            return f"{self.chain(fn, depth + 1)}()" if fn is not None else "<expr>"
        if t == "method_invocation":
            obj = n.child_by_field_name("object")
            name = self.text(n.child_by_field_name("name"))
            return f"{self.chain(obj, depth + 1)}.{name}()" if obj is not None else f"{name}()"
        if t in ("await_expression", "parenthesized_expression", "non_null_expression", "try_expression",
                 "reference_expression", "as_expression"):
            inner = n.named_children[0] if n.named_children else None
            return self.chain(inner, depth + 1) if inner is not None else "<expr>"
        if t in ("subscript", "subscript_expression", "index_expression"):  # xs[0] / m[key]: an element, marked `[]`
            obj = (n.child_by_field_name("value") or n.child_by_field_name("object") or n.child_by_field_name("operand")
                   or (n.named_children[0] if n.named_children else None))
            if obj is None:
                return "<expr>"
            sub = n.child_by_field_name("subscript")
            if sub is not None and sub.type == "slice":  # xs[1:] is still a list
                return self.chain(obj, depth + 1)
            return f"{self.chain(obj, depth + 1)}[]"
        if t == "binary_operator" and self.lang == "python":  # (root / "x").write_text(): Path / str is a Path
            op = n.child_by_field_name("operator")
            left = n.child_by_field_name("left")
            if op is not None and op.type == "/" and left is not None:
                return self.chain(left, depth + 1)
        return "<expr>"

    def value_type(self, v: Node | None) -> str:
        """What an assignment's right-hand side tells us about the variable's type ("" when nothing)."""
        if v is None:
            return ""
        t = v.type
        if t in ("call", "call_expression", "method_invocation"):
            c = self.chain(v)
            return f"call:{c.removesuffix('()')}" if "<expr>" not in c else ""
        if t == "new_expression":
            return _strip_generics(self.text(v.child_by_field_name("constructor")))
        if t in ("composite_literal", "object_creation_expression"):
            return _strip_generics(self.text(v.child_by_field_name("type")))
        if t == "struct_expression":
            return _strip_generics(self.text(v.child_by_field_name("name")))
        if t in ("await_expression", "unary_expression", "reference_expression", "parenthesized_expression", "try_expression"):
            inner = v.child_by_field_name("operand") or v.child_by_field_name("value") or (v.named_children[0] if v.named_children else None)
            return self.value_type(inner)
        if t in ("subscript", "subscript_expression", "index_expression"):
            c = self.chain(v)
            return f"item:{c[:-2]}" if "<expr>" not in c else ""
        if t == "object" and self.lang in JSLIKE:
            return self.object_shape(v)
        if t in CASTS:
            inner, cast = self.cast(v)
            return cast or self.value_type(inner)
        return LITERALS.get((self.lang, t), "")  # `bits = []`: calls on it are list methods, not repo code

    def cast(self, v: Node) -> tuple[Node | None, str]:
        """`x as T` / `x satisfies T` / `(x)` / `x!` as (x, T); T is "" for a cast that says nothing (any, const)."""
        inner = v.named_children[0] if v.named_children else None
        if v.type in ("as_expression", "satisfies_expression") and len(v.named_children) > 1:
            t = _strip_generics(self.text(v.named_children[-1]))
            if re.fullmatch(r"[A-Z][\w.]*", t):
                return inner, t
        return inner, ""

    def arms(self, v: Node) -> tuple[Node | None, Node | None]:
        if v.type == "ternary_expression":
            return v.child_by_field_name("consequence"), v.child_by_field_name("alternative")
        kids = v.named_children  # Python: a if cond else b
        return (kids[0], kids[2]) if len(kids) == 3 else (None, None)

    def object_shape(self, v: Node) -> str:
        """A JS object literal as `obj:` entries the resolver turns into members: `{ getState, inc() {}, set: s,
        ...api }` -> `obj:getState=getState;inc=inc;set=s;...=api`. Inline arrow values have no definition to point at."""
        out = []
        for c in v.named_children:
            if c.type == "shorthand_property_identifier":
                out.append(f"{self.text(c)}={self.text(c)}")
            elif c.type == "method_definition":
                nm = self.text(c.child_by_field_name("name"))
                out.append(f"{nm}={nm}")
            elif c.type == "pair":
                key, val = c.child_by_field_name("key"), c.child_by_field_name("value")
                ch = self.chain(val) if val is not None and val.type in ("identifier", "member_expression") else "<expr>"
                if key is not None and key.type == "property_identifier" and "<expr>" not in ch:
                    out.append(f"{self.text(key)}={ch}")
            elif c.type == "spread_element" and c.named_children:
                ch = self.chain(c.named_children[0])
                if "<expr>" not in ch:
                    out.append(f"...={ch}")
        return "obj:" + ";".join(out) if out else ""

    def iter_type(self, v: Node | None) -> str:
        """What one element of an iterated expression is: `iter:xs` (a sequence element or a mapping key), `item:m`
        for `m.values()` (a mapping value); "" when unknown. The resolver reads the container's written type."""
        while v is not None and v.type in ("reference_expression", "parenthesized_expression", "await_expression"):
            v = v.named_children[0] if v.named_children else None
        if v is None:
            return ""
        if v.type in ("call", "call_expression", "method_invocation"):
            fn = v.child_by_field_name("function")
            args = v.child_by_field_name("arguments")
            first = args.named_children[0] if args is not None and args.named_children else None
            if fn is not None and fn.type == "identifier" and self.text(fn) in SAME_ELEMENTS:
                return self.iter_type(first)
            obj = fn.child_by_field_name("object") or fn.child_by_field_name("value") if fn is not None else None
            prop = (fn.child_by_field_name("attribute") or fn.child_by_field_name("property")
                    or fn.child_by_field_name("field")) if fn is not None else None
            if obj is not None and prop is not None:
                c = self.chain(obj)
                if self.text(prop) in SAME_ELEMENTS and "<expr>" not in c:
                    return f"iter:{c}"
                if self.text(prop) == "values" and "<expr>" not in c:
                    return f"item:{c}"
        c = self.chain(v)
        return f"iter:{c}" if "<expr>" not in c else ""

    def pair_type(self, v: Node | None) -> str:
        """The second name of `for k, v in m.items()` / `for i, x in enumerate(xs)` / `[k, v] of m.entries()`."""
        if v is None or v.type not in ("call", "call_expression"):
            return ""
        fn = v.child_by_field_name("function")
        args = v.child_by_field_name("arguments")
        first = args.named_children[0] if args is not None and args.named_children else None
        if fn is not None and fn.type == "identifier" and self.text(fn) == "enumerate":
            return self.iter_type(first)
        if fn is not None and self.text(fn) == "Object.entries" and first is not None:
            c = self.chain(first)
            return f"item:{c}" if "<expr>" not in c else ""
        obj = fn.child_by_field_name("object") if fn is not None else None
        prop = fn.child_by_field_name("attribute") or fn.child_by_field_name("property") if fn is not None else None
        if obj is not None and prop is not None and self.text(prop) in ("items", "entries"):
            c = self.chain(obj)
            return f"item:{c}" if "<expr>" not in c else ""
        return ""

    def loop_targets(self, left: Node | None, right: Node | None) -> None:
        if left is None:
            return
        if left.type == "identifier":
            self.note_type(self.text(left), self.iter_type(right))
            return
        names = [c for c in left.named_children if c.type == "identifier"]
        if left.type in ("pattern_list", "tuple_pattern", "array_pattern") and len(names) == 2 == len(left.named_children):
            self.note_type(self.text(names[1]), self.pair_type(right))

    def note_type(self, name: str, typ: str, on_class: bool = False) -> None:
        if not name or not typ:
            return
        target = self.current_class() if on_class else self.current_def()
        if target is not None:
            target.types.setdefault(name, typ)

    def current_def(self) -> Def | None:
        return self.def_stack[-1] if self.def_stack else None

    def current_class(self) -> Def | None:
        for d in reversed(self.def_stack):
            if d is not None and d.kind in ("class", "struct", "interface", "trait", "enum"):
                return d
        return None

    def arg_count(self, args: Node | None) -> int:
        if args is None:
            return -1
        named = [c for c in args.named_children if c.type not in COMMENTS]
        if any(c.type in ("spread_element", "list_splat", "dictionary_splat", "variadic_argument") for c in named):
            return -1
        if self.lang == "python":
            named = [c for c in named if c.type != "keyword_argument"]  # keywords can fill any slot: count positional
        return len(named)

    # ---- driver --------------------------------------------------------------------------------------------------
    def run(self) -> None:
        sys.setrecursionlimit(max(sys.getrecursionlimit(), 20_000))
        digest, cx = self.fingerprint(self.root, skip=None)
        mod = Def(path=self.f.path, qname=MODULE, name=self.f.path.rsplit("/", 1)[-1], kind="module", line=1,
                  end_line=max(1, self.root.end_point[0] + 1), digest=digest, sig_digest="", complexity=cx,
                  is_test=self.f.is_test)
        self.f.defs.append(mod)
        self.def_stack.append(mod)  # module-level assignments record their types on <module>
        if self.lang == "python":
            mod.doc = self.py_docstring(self.root)[0]
        self.visit_children(self.root)
        if self.lang in JSLIKE and not self.saw_export:  # no ESM exports: CommonJS / script, assume visible
            for d in self.f.defs:
                if "." not in d.qname and d.kind not in ("test", "suite", "module"):
                    d.exported = True
        elif self.export_names:  # `export { Card, CardHeader }` / `export default Card` after the definitions
            for d in self.f.defs:
                if "." not in d.qname and d.name in self.export_names:
                    d.exported = True
        self.f.defs.sort(key=lambda d: (d.line, d.qname))

    def visit_children(self, n: Node) -> None:
        pending: list[str] = []  # decorators / attributes that precede the next definition
        for c in n.children:
            t = c.type
            if t in ("decorator", "attribute_item"):
                pending.append(_deco_name(self.text(c)))
                continue
            if t in COMMENTS:
                continue
            self.visit(c, pending)
            pending = []

    def visit(self, n: Node, decorators: list[str] | None = None) -> None:
        info = self.def_info(n)
        if info:
            self.define(n, info[0], info[1], decorators or [])
            return
        handler = getattr(self, f"on_{n.type}", None)
        if handler is not None and handler(n) is False:
            return
        self.visit_children(n)

    # ---- definitions ---------------------------------------------------------------------------------------------
    def def_info(self, n: Node) -> tuple[str, str] | None:
        t = n.type
        if self.lang in JSLIKE and t == "call_expression":
            return self.js_test_case(n)
        kind = self.defs.get(t)
        if kind is None:
            return None
        if t == "variable_declarator":
            name = n.child_by_field_name("name")
            if self.fn_value(n) is None or name is None or name.type != "identifier":
                return None
            return "function", self.text(name)
        if t == "type_spec":
            inner = n.child_by_field_name("type")
            kind = {"struct_type": "struct", "interface_type": "interface"}.get(inner.type if inner else "", "type")
        if t == "constructor_declaration":
            return "method", "<init>"
        name = n.child_by_field_name("name")
        if name is None:
            return None
        return kind, self.text(name)

    def fn_value(self, n: Node) -> Node | None:
        """The function a declarator binds, seen through `(…)`, `as T`, `satisfies T` and `!`:
        `export const create = (<T>(init) => …) as Create` is how zustand and many TS libraries export."""
        v = n.child_by_field_name("value")
        for _ in range(4):
            if v is None or v.type in ("arrow_function", "function_expression", "function"):
                return v
            if v.type not in ("parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression"):
                return None
            v = v.named_children[0] if v.named_children else None
        return None

    def js_test_case(self, n: Node) -> tuple[str, str] | None:
        fn = n.child_by_field_name("function")
        if fn is None:
            return None
        base = self.text(fn.child_by_field_name("object")) if fn.type == "member_expression" else self.text(fn)
        if base not in JS_TEST_CALLS:
            return None
        args = n.child_by_field_name("arguments")
        first = args.named_children[0] if args is not None and args.named_children else None
        if first is None or first.type not in ("string", "template_string"):
            return None
        label = self.text(first).strip("'\"`").replace(".", "·")
        return ("suite" if base in ("describe", "suite", "context") else "test"), _squash(label, 120)

    def define(self, n: Node, kind: str, name: str, decorators: list[str]) -> None:
        lang = self.lang
        parent_q, parent_kind = self.scope[-1] if self.scope else (None, "module")
        qname = f"{parent_q}.{name}" if parent_q else name
        if lang == "go" and n.type == "method_declaration":
            recv = self.go_receiver_type(n)
            qname = f"{recv}.{name}" if recv else name
        if kind == "function" and parent_kind in CLASSLIKE - {"suite"}:
            kind = "method"
        if kind in ("test", "suite") and parent_kind not in ("suite", "module") and parent_q:
            qname = f"{parent_q}.{name}"
        n_seen = self.seen.get(qname, 0) + 1  # overloads and conditional redefinitions keep distinct ids
        self.seen[qname] = n_seen
        if n_seen > 1:
            qname = f"{qname}#{n_seen}"

        if lang == "java":
            decorators = decorators + self.java_annotations(n)
        body = self.body_of(n)
        params_node = self.params_of(n)
        params, min_args, max_args = self.params(params_node, is_method=kind == "method", decorators=decorators)
        signature = self.signature(n, body)
        ret = n.child_by_field_name("return_type") or n.child_by_field_name("result") or n.child_by_field_name("type") if kind in ("function", "method") else None
        if n.type == "variable_declarator":  # `const f: Handler = () => x`: Handler is f's own type, not what it returns
            fv = self.fn_value(n)
            ret = fv.child_by_field_name("return_type") if fv is not None else None
        name_node = n.child_by_field_name("name")
        digest, cx = self.fingerprint(n, skip=name_node)
        doc, _ = self.py_docstring(body) if lang == "python" else (self.leading_comment(n), None)

        d = Def(
            path=self.f.path, qname=qname, name=name, kind=kind,
            line=n.start_point[0] + 1, end_line=n.end_point[0] + 1,
            params=params, signature=signature, digest=digest,
            sig_digest=_digest([kind, _squash(self.text(params_node), 400), _squash(self.text(ret), 120), *sorted(decorators)]),
            complexity=cx, doc=doc, decorators=decorators, min_args=min_args, max_args=max_args,
        )
        d.exported = self.is_exported(n, d, parent_kind)
        d.is_test = self.is_test_def(d, parent_kind)
        d.bases = self.bases_of(n)
        if ret is not None:
            d.returns = _squash(self.text(ret).lstrip(":-> ").strip(), 120)
        self.note_params(params_node, d)
        self.f.defs.append(d)

        self.scope.append((qname, kind))
        self.def_stack.append(d)
        fn = self.fn_value(n) if n.type == "variable_declarator" else n
        self.ret_stack.append((fn, [], []))
        try:
            if n.type == "variable_declarator":
                self.visit_children(fn)  # type: ignore[arg-type]
                if body is not None and body.type != "statement_block":  # `() => new Foo()`
                    self.ret_stack[-1][1].append(self.ret_value(body))
            elif kind in ("test", "suite"):
                args = n.child_by_field_name("arguments")
                for a in (args.named_children[1:] if args is not None else []):
                    self.visit(a)
            else:
                self.visit_children(n)
        finally:
            self.scope.pop()
            self.def_stack.pop()
            _, rets, ylds = self.ret_stack.pop()
        if fn is not None and body is not None and body.type in ("arrow_function", "function_expression"):
            # middleware: `(fn) => (set, get, api) => fn(set, get, api)` returns a function whose parameters the
            # caller of the result binds; the resolver follows them outwards
            inner_ps = body.child_by_field_name("parameters") or body.child_by_field_name("parameter")
            d.types["retparams"] = ",".join(self.params(inner_ps, False, [])[0])
        if kind in ("function", "method") and not d.returns:
            inner = {x.name for x in self.f.defs if x.parent == qname}
            d.ret_hint = f"yield:{_agree(ylds, d.types)}" if ylds else _agree(rets, d.types, inner)

    def ret_value(self, v: Node | None) -> str:
        """A returned expression as a type hint: "" for nothing/null, "?" when unknown, "@x" for a local resolved later."""
        if v is not None and v.type == "expression_list":  # Go: return x, err
            v = v.named_children[0] if v.named_children else None
        if v is None or v.type in ("none", "null", "undefined", "nil") or self.text(v) in NULLISH:
            return ""
        if v.type in ("self", "this") or (v.type == "identifier" and self.text(v) in ("self", "this")):
            return "Self"
        if v.type == "identifier":
            return "@" + self.text(v)
        if v.type in CASTS:  # `return api as any`: a weak cast says nothing, so look through it
            inner, cast = self.cast(v)
            return cast or self.ret_value(inner)
        if v.type in ("ternary_expression", "conditional_expression"):
            a, b = self.arms(v)
            ra, rb = self.ret_value(a), self.ret_value(b)
            # `init ? createImpl(init) : createImpl`: a curried factory. f(init) and f()(init) both evaluate to what
            # createImpl(init) returns
            for x, y in ((ra, rb), (rb, ra)):
                if x.startswith("call:") and y == "@" + x[5:]:
                    return "curry:" + x[5:]
            return ra if ra == rb else "?"
        typ = self.value_type(v)
        return "Self" if typ == "call:cls" else typ or "?"

    def _owns(self, n: Node) -> bool:
        """Whether `n` sits directly in the innermost definition's body, not inside a nested callback."""
        if not self.ret_stack:
            return False
        fn = self.ret_stack[-1][0]
        p = n.parent
        while p is not None:
            if fn is not None and p.id == fn.id:
                return True
            if p.type in FUNC_NODES:
                return False
            p = p.parent
        return False

    def on_return_statement(self, n: Node) -> bool:
        if self._owns(n):
            v = n.named_children[0] if n.named_children else None
            self.ret_stack[-1][1].append(self.ret_value(v))
            while v is not None and v.type == "parenthesized_expression" and v.named_children:
                v = v.named_children[0]
            d = self.current_def()
            if v is not None and d is not None and self.lang in JSLIKE and v.type in ("arrow_function", "function_expression"):
                ps = v.child_by_field_name("parameters") or v.child_by_field_name("parameter")  # return (...args) => …
                d.types.setdefault("retparams", ",".join(self.params(ps, False, [])[0]))
        return True

    on_return_expression = on_return_statement  # Rust

    def on_yield(self, n: Node) -> bool:  # Python; a generator's call result is the generator, not what it yields
        if self._owns(n):
            self.ret_stack[-1][2].append(self.ret_value(n.named_children[0] if n.named_children else None))
        return True

    def note_params(self, p: Node | None, d: Def) -> None:
        if p is None or p.type == "identifier":
            return
        cls = self.current_class() if d.kind == "method" else None
        for c in p.named_children:
            t = c.child_by_field_name("type")
            if t is None:
                continue
            typ = self.text(t).lstrip(":").strip()
            for name in self.param_name(c).split(", "):
                name = name.lstrip("*&").removeprefix("mut ").strip()
                d.types.setdefault(name, typ)
                # TS `constructor(private repo: Repo)` declares a field too
                if cls is not None and any(x.type == "accessibility_modifier" for x in c.children):
                    cls.types.setdefault(name, typ)

    def body_of(self, n: Node) -> Node | None:
        if n.type == "variable_declarator":
            v = self.fn_value(n)
            return v.child_by_field_name("body") if v is not None else None
        return n.child_by_field_name("body")

    def params_of(self, n: Node) -> Node | None:
        if n.type == "variable_declarator":
            v = self.fn_value(n)
            if v is None:
                return None
            return v.child_by_field_name("parameters") or v.child_by_field_name("parameter")
        return n.child_by_field_name("parameters")

    def params(self, p: Node | None, is_method: bool, decorators: list[str]) -> tuple[list[str], int, int]:
        if p is None:
            return [], 0, 0
        if p.type == "identifier":  # JS arrow with one bare parameter: x => x + 1
            return [self.text(p)], 1, 1
        names: list[str] = []
        required = total = 0
        variadic = False
        for c in p.named_children:
            t = c.type
            if t in COMMENTS:
                continue
            if t in RECEIVER_PARAMS:
                continue
            if t in VARIADIC_PARAMS or (t == "parameter_declaration" and self.text(c).find("...") >= 0):
                variadic = True
                names.append(self.text(c)[:40])
                continue
            label = self.param_name(c)
            if t in ("keyword_separator", "positional_separator"):
                continue
            names.append(label)
            # Go `a, b int` declares two parameters in one node.
            count = len(c.children_by_field_name("name")) if self.lang == "go" else 1
            total += max(count, 1)
            if t not in OPTIONAL_PARAMS and not (t == "required_parameter" and c.child_by_field_name("value") is not None):
                required += max(count, 1)
        if self.lang == "python" and is_method and names and "staticmethod" not in decorators:
            first = names[0]
            if first in ("self", "cls"):
                names, required, total = names[1:], max(required - 1, 0), max(total - 1, 0)
        return names, required, (-1 if variadic else total)

    def param_name(self, c: Node) -> str:
        if c.type == "identifier":
            return self.text(c)
        for field in ("name", "pattern"):
            sub = c.children_by_field_name(field)
            if sub:
                return ", ".join(self.text(s) for s in sub)[:40]
        for sub in c.named_children:
            if sub.type == "identifier":
                return self.text(sub)
        return _squash(self.text(c), 40)

    def signature(self, n: Node, body: Node | None) -> str:
        end = body.start_byte if body is not None and body.start_byte > n.start_byte else n.end_byte
        # Comments inside the header (`def f(x):  # note`) are not part of the contract: cut them by AST range.
        cuts, stack = [], [n]
        while stack:
            c = stack.pop()
            if c.start_byte >= end:
                continue
            if c.type == "comment":
                cuts.append((c.start_byte, min(c.end_byte, end)))
            elif c is not body:
                stack.extend(c.children)
        raw, pos = b"", n.start_byte
        for a, b in sorted(cuts):
            raw += self.src[pos:a]
            pos = max(pos, b)
        raw = (raw + self.src[pos:end]).decode("utf-8", "replace")
        if body is None:
            raw = raw.split("\n", 1)[0]
        return _squash(raw.rstrip(" {:=>\n"), 240)

    def fingerprint(self, n: Node, skip: Node | None) -> tuple[str, int]:
        """Normalized digest + cyclomatic complexity of `n`, nested definitions replaced by placeholders."""
        parts: list[str] = []
        cx = 1
        doc = self.py_docstring(self.body_of(n) if n is not self.root else n)[1] if self.lang == "python" else None
        stack: list[Node] = [n]
        while stack:
            c = stack.pop()
            if c.type in COMMENTS or (skip is not None and c.id == skip.id) or (doc is not None and c.id == doc.id):
                continue
            if c is not n:
                info = self.def_info(c)
                if info:
                    parts.append(f"<{info[0]}:{info[1]}>")
                    continue
            if c.type in self.branches:
                cx += 1
            if c.child_count == 0:
                parts.append(self.text(c))
            else:
                stack.extend(reversed(c.children))
        return _digest(parts), cx

    def py_docstring(self, body: Node | None) -> tuple[str, Node | None]:
        if body is None:
            return "", None
        first = next((c for c in body.named_children if c.type not in COMMENTS), None)
        if first is None:
            return "", None
        # Newer grammars put the string straight in the block; older ones wrap it in an expression_statement.
        s = first.named_children[0] if first.type == "expression_statement" and first.named_children else first
        if s.type != "string":
            return "", None
        raw = self.text(s).strip("rRbBuUfF").strip("\"'").strip()
        if ">>>" in raw:  # doctests are executable: keep them in the digest
            return _squash(raw, 300), None
        return _squash(raw, 300), first

    def leading_comment(self, n: Node) -> str:
        target = n.parent if n.parent is not None and n.parent.type in ("export_statement", "lexical_declaration", "variable_declaration") else n
        if target.type == "lexical_declaration" and target.parent is not None and target.parent.type == "export_statement":
            target = target.parent
        lines: list[str] = []
        prev = target.prev_sibling
        row = target.start_point[0]
        while prev is not None and prev.type in COMMENTS | {"attribute_item", "decorator"} and prev.end_point[0] >= row - 1:
            if prev.type in COMMENTS:
                lines.insert(0, self.text(prev))
            row = prev.start_point[0]
            prev = prev.prev_sibling
        if not lines:
            return ""
        txt = "\n".join(lines)
        txt = re.sub(r"^\s*(/\*\*?|\*/|\*|///?|//!?)", "", txt, flags=re.MULTILINE).replace("*/", "")
        return _squash(txt, 300)

    def is_exported(self, n: Node, d: Def, parent_kind: str) -> bool:
        lang = self.lang
        if lang == "python":
            return not d.name.startswith("_") or (d.name.startswith("__") and d.name.endswith("__"))
        if lang == "go":
            base = d.qname.split(".")[-1]
            return base[:1].isupper()
        if lang == "java":
            mods = next((c for c in n.children if c.type == "modifiers"), None)
            return mods is None or "private" not in self.text(mods)
        if lang == "rust":
            return any(c.type == "visibility_modifier" for c in n.children) or parent_kind in ("trait", "impl")
        # JS/TS: methods follow their accessibility; top-level follows `export` (settled in run()).
        if d.kind in ("test", "suite"):
            return False
        if "." in d.qname:
            mod = next((c for c in n.children if c.type == "accessibility_modifier"), None)
            return d.name[:1] != "#" and (mod is None or self.text(mod) != "private")
        return self.exporting

    def is_test_def(self, d: Def, parent_kind: str) -> bool:
        if not self.f.is_test and d.kind != "test":
            if self.lang == "rust":
                return any(x in RUST_TEST_ATTR for x in d.decorators)
            if self.lang == "java":
                return any(x.rsplit(".", 1)[-1] in JAVA_TEST_ANN for x in d.decorators)
            return False
        lang = self.lang
        if lang == "python":
            return d.name.startswith("test") or (d.kind == "class" and d.name.startswith("Test"))
        if lang in JSLIKE:
            return d.kind in ("test", "suite")
        if lang == "go":
            return bool(GO_TEST.match(d.name))
        if lang == "java":
            return any(x.rsplit(".", 1)[-1] in JAVA_TEST_ANN for x in d.decorators) or (d.kind == "class" and d.name.endswith("Test"))
        if lang == "rust":
            return any(x in RUST_TEST_ATTR for x in d.decorators)
        return False

    def bases_of(self, n: Node) -> list[str]:
        out: list[str] = []
        lang = self.lang
        if lang == "python":
            sup = n.child_by_field_name("superclasses")
            for c in sup.named_children if sup is not None else []:
                if c.type in ("identifier", "attribute"):
                    out.append(self.text(c))
        elif lang in JSLIKE:
            her = next((c for c in n.children if c.type == "class_heritage"), None)
            for c in her.named_children if her is not None else []:
                if c.type in ("extends_clause", "implements_clause", "extends_type_clause"):
                    for v in c.named_children:
                        if v.type not in ("type_arguments", "arguments"):
                            out.append(_strip_generics(self.text(v)))
                else:
                    out.append(_strip_generics(self.text(c)))
            ext = next((c for c in n.children if c.type == "extends_type_clause"), None)  # interface X extends Y
            for v in ext.named_children if ext is not None else []:
                out.append(_strip_generics(self.text(v)))
        elif lang == "java":
            for field in ("superclass", "interfaces"):
                sub = n.child_by_field_name(field)
                if sub is not None:
                    for t in self._type_names(sub):
                        out.append(t)
            ext = next((c for c in n.children if c.type == "extends_interfaces"), None)
            if ext is not None:
                out.extend(self._type_names(ext))
        elif lang == "go" and n.type == "type_spec":
            inner = n.child_by_field_name("type")
            if inner is not None and inner.type == "struct_type":  # embedded fields behave like inheritance
                for fd in inner.named_children[0].named_children if inner.named_children else []:
                    if fd.type == "field_declaration" and fd.child_by_field_name("name") is None:
                        out.append(self.text(fd.child_by_field_name("type")).lstrip("*"))
            elif inner is not None and inner.type == "interface_type":
                for el in inner.named_children:
                    if el.type in ("type_elem", "constraint_elem"):
                        out.append(self.text(el))
        elif lang == "rust" and n.type == "trait_item":
            b = n.child_by_field_name("bounds")
            if b is not None:
                out.extend(_strip_generics(self.text(c)) for c in b.named_children)
        return [b for b in out if b]

    def _type_names(self, n: Node) -> Iterator[str]:
        for c in n.named_children:
            if c.type in ("type_identifier", "scoped_type_identifier", "generic_type"):
                yield _strip_generics(self.text(c))
            elif c.type == "type_list":
                yield from self._type_names(c)

    def java_annotations(self, n: Node) -> list[str]:
        mods = next((c for c in n.children if c.type == "modifiers"), None)
        if mods is None:
            return []
        return [_deco_name(self.text(c)) for c in mods.named_children if c.type in ("marker_annotation", "annotation")]

    def go_receiver_type(self, n: Node) -> str:
        recv = n.child_by_field_name("receiver")
        if recv is None:
            return ""
        for p in recv.named_children:
            t = p.child_by_field_name("type")
            if t is not None:
                return _strip_generics(self.text(t).lstrip("*"))
        return ""

    # ---- per-node handlers (return False to stop descending) -----------------------------------------------------
    def on_export_statement(self, n: Node) -> bool:
        self.saw_export = True
        src = n.child_by_field_name("source")
        if src is not None:  # export { a as b } from './x'  /  export * from './x'
            names: list[tuple[str, str]] = []
            clause = next((c for c in n.named_children if c.type == "export_clause"), None)
            for spec in clause.named_children if clause is not None else []:
                if spec.type == "export_specifier":
                    nm = self.text(spec.child_by_field_name("name"))
                    names.append((nm, self.text(spec.child_by_field_name("alias")) or nm))
            self.f.imports.append(Import(module=self.text(src).strip("'\"`"), names=names or [("*", "*")], line=n.start_point[0] + 1))
            return False
        for c in n.named_children:
            if c.type == "export_clause":
                self.export_names.update(self.text(s.child_by_field_name("name")) for s in c.named_children
                                         if s.type == "export_specifier")
            elif c.type == "identifier":  # export default Foo
                self.export_names.add(self.text(c))
        prev, self.exporting = self.exporting, True
        try:
            self.visit_children(n)
        finally:
            self.exporting = prev
        return False

    def object_assign(self, n: Node, fn: Node, args: Node | None) -> None:
        """`Object.assign(useBoundStore, api)`: the target gains api's members. Recorded as `assign:<target>`."""
        if self.text(fn) != "Object.assign" or args is None or len(args.named_children) < 2:
            return
        target, *srcs = args.named_children
        d = self.current_def()
        if target.type != "identifier" or d is None:
            return
        chains = [c for c in (self.chain(s) for s in srcs if s.type in ("identifier", "member_expression", "call_expression")) if "<expr>" not in c]
        key = "assign:" + self.text(target)
        if chains:
            d.types[key] = ";".join(filter(None, [d.types.get(key, ""), *chains]))

    def call_facts(self, callee: str, args: Node | None) -> None:
        """How callbacks are wired, for the resolver to join (JS/TS). `create((set) => …)` types `set` as
        `cb:create#0#0`: parameter 0 of the function passed as argument 0. Inside a function, calling a parameter
        records what it receives (`pcall:fn` = `setState,getState,api`) and passing one on records where it goes
        (`pfwd:fn` = `createStore#0`)."""
        d = self.current_def()
        if self.lang not in JSLIKE or args is None or d is None or "<expr>" in callee:
            return
        pos = []
        for a in args.named_children:
            if a.type == "spread_element":
                break
            if a.type not in COMMENTS:
                pos.append(a)
        params = set(d.params)
        outer, node = [], args.parent  # devtools((set) => …) inside create()(…): where the middleware's result goes
        while node is not None and len(outer) < 5 and node.parent is not None and node.parent.type == "arguments":
            up = node.parent.parent
            fn = up.child_by_field_name("function") if up is not None else None
            if fn is None or "<expr>" in self.chain(fn):
                break
            outer.append(f"@{self.chain(fn)}#{[x.id for x in node.parent.named_children].index(node.id)}")
            node = up
        if callee in params:
            refs = [self.chain(a) if a.type in ("identifier", "member_expression") else self.forwarder(a) for a in pos]
            rest = args.named_children[len(pos)] if len(pos) < len(args.named_children) else None
            if rest is not None and rest.type == "spread_element" and rest.named_children \
                    and rest.named_children[0].type == "identifier":  # create(...args): every remaining position
                refs.append("..." + self.text(rest.named_children[0]))
            d.types.setdefault("pcall:" + callee, ",".join("" if "<expr>" in r else r for r in refs))
        for i, a in enumerate(pos):
            if a.type == "identifier" and self.text(a) in params:
                d.types.setdefault("pfwd:" + self.text(a), f"{callee}#{i}")
            elif a.type in ("arrow_function", "function_expression"):
                ps = a.child_by_field_name("parameters")
                one = a.child_by_field_name("parameter")
                for j, p in enumerate([one] if one is not None else ps.named_children if ps is not None else []):
                    if p.type == "required_parameter" and p.child_by_field_name("type") is None:
                        p = p.child_by_field_name("pattern")
                    if p is not None and p.type == "identifier":
                        self.note_type(self.text(p), f"cb:{callee}#{i}#{j}" + "".join(outer))

    def forwarder(self, a: Node) -> str:
        """`(...a) => { set(...a); save() }` passes its arguments straight on to `set`: as a value it stands for `set`
        (persist hands this wrapper to the store initializer). "" for any other expression."""
        if a.type not in ("arrow_function", "function_expression"):
            return ""
        ps = a.child_by_field_name("parameters")
        one = a.child_by_field_name("parameter")
        names = [self.text(one)] if one is not None else self.params(ps, False, [])[0] if ps is not None else []
        if not names:
            return ""
        body = a.child_by_field_name("body")
        calls = [body] if body is not None and body.type == "call_expression" else [
            x.named_children[0] for x in (body.named_children if body is not None and body.type == "statement_block" else [])
            if x.type == "expression_statement" and x.named_children and x.named_children[0].type == "call_expression"]
        for c in calls:
            fn, cargs = c.child_by_field_name("function"), c.child_by_field_name("arguments")
            if fn is None or cargs is None:
                continue
            got = [("..." + self.chain(x.named_children[0])) if x.type == "spread_element" and x.named_children
                   else self.chain(x) for x in cargs.named_children if x.type not in COMMENTS]  # ...(args as P)
            if got == names:
                c = self.chain(fn)
                return "" if "<expr>" in c else c
        return ""

    def destructured(self, left: Node | None, right: Node | None) -> None:
        """`const { getState } = create(…)` names a member of the result: `prop:create().getState`. Positional parts
        (`const [x, setX] = useState()`, `a, b = f()`) are `part:`, never typed; a part of a library call is a library
        value, so calls on it count as external."""
        if left is None or right is None or right.type not in ("call", "call_expression", "await_expression", "identifier", "member_expression"):
            return
        c = self.chain(right.named_children[0] if right.type == "await_expression" and right.named_children else right)
        if "<expr>" in c:
            return
        for x in left.named_children:
            key = x
            if x.type == "pair_pattern":
                key, x = x.child_by_field_name("key"), x.child_by_field_name("value")
            if x is None or x.type not in ("identifier", "shorthand_property_identifier_pattern"):
                continue
            if left.type == "object_pattern" and key is not None and key.type in ("property_identifier", "shorthand_property_identifier_pattern"):
                self.note_type(self.text(x), f"prop:{c}.{self.text(key)}")
            elif right.type not in ("identifier", "member_expression"):
                self.note_type(self.text(x), "part:" + c)

    def on_lexical_declaration(self, n: Node) -> bool:
        return True

    # Python
    def on_import_statement(self, n: Node) -> bool:
        line = n.start_point[0] + 1
        if self.lang == "python":
            for c in n.named_children:
                if c.type == "dotted_name":
                    self.f.imports.append(Import(module=self.text(c), line=line))
                elif c.type == "aliased_import":
                    self.f.imports.append(Import(module=self.text(c.child_by_field_name("name")),
                                                 alias=self.text(c.child_by_field_name("alias")), line=line))
            return False
        if self.lang in JSLIKE:
            src = n.child_by_field_name("source")
            imp = Import(module=self.text(src).strip("'\"`"), line=line)
            clause = next((c for c in n.named_children if c.type == "import_clause"), None)
            for c in clause.named_children if clause is not None else []:
                if c.type == "identifier":
                    imp.names.append(("default", self.text(c)))
                elif c.type == "namespace_import":
                    imp.alias = self.text(next((x for x in c.named_children if x.type == "identifier"), None))
                elif c.type == "named_imports":
                    for spec in c.named_children:
                        if spec.type == "import_specifier":
                            nm = self.text(spec.child_by_field_name("name"))
                            imp.names.append((nm, self.text(spec.child_by_field_name("alias")) or nm))
            self.f.imports.append(imp)
            return False
        return True

    def on_import_from_statement(self, n: Node) -> bool:
        mod = n.child_by_field_name("module_name")
        level, module = 0, self.text(mod)
        if mod is not None and mod.type == "relative_import":
            prefix = next((c for c in mod.children if c.type == "import_prefix"), None)
            level = len(self.text(prefix))
            dotted = next((c for c in mod.named_children if c.type == "dotted_name"), None)
            module = self.text(dotted)
        imp = Import(module=module, level=level, line=n.start_point[0] + 1)
        for c in n.children_by_field_name("name"):
            if c.type == "dotted_name":
                imp.names.append((self.text(c), self.text(c)))
            elif c.type == "aliased_import":
                imp.names.append((self.text(c.child_by_field_name("name")), self.text(c.child_by_field_name("alias"))))
        if any(c.type == "wildcard_import" for c in n.children):
            imp.names.append(("*", "*"))
        self.f.imports.append(imp)
        return False

    def on_call(self, n: Node) -> bool:  # Python
        fn = n.child_by_field_name("function")
        args = n.child_by_field_name("arguments")
        if fn is not None and fn.type == "identifier":
            self.add_call(self.text(fn), None, n, args)
        elif fn is not None and fn.type == "attribute":
            self.add_call(self.text(fn.child_by_field_name("attribute")), self.receiver(fn.child_by_field_name("object")), n, args)
        return True

    # JS / TS / Go / Rust share `call_expression`
    def on_call_expression(self, n: Node) -> bool:
        fn = n.child_by_field_name("function")
        args = n.child_by_field_name("arguments")
        if fn is None:
            return True
        t = fn.type
        if t == "generic_function":  # Rust: parse::<T>(x)
            fn = fn.child_by_field_name("function") or fn
            t = fn.type
        if self.lang in JSLIKE and t == "identifier" and self.text(fn) == "require":
            self.js_require(n, args)
            return False
        if self.lang in JSLIKE and t == "import":
            first = args.named_children[0] if args is not None and args.named_children else None
            if first is not None and first.type == "string":
                self.f.imports.append(Import(module=self.text(first).strip("'\"`"), line=n.start_point[0] + 1))
            return True
        if t == "identifier":
            self.add_call(self.text(fn), None, n, args)
            self.call_facts(self.text(fn), args)
        elif t == "member_expression":
            self.element_callback(n)
            self.object_assign(n, fn, args)
            self.add_call(self.text(fn.child_by_field_name("property")), self.receiver(fn.child_by_field_name("object")), n, args)
            self.call_facts(self.chain(fn), args)
        elif t == "call_expression" and self.lang in JSLIKE:  # create<T>()((set) => …)
            self.call_facts(self.chain(fn), args)
        elif t in ("parenthesized_expression", "as_expression", "non_null_expression") and self.lang in JSLIKE:
            self.call_facts(self.chain(fn), args)  # (create as any)(...args)
        elif t == "selector_expression":
            self.add_call(self.text(fn.child_by_field_name("field")), self.receiver(fn.child_by_field_name("operand")), n, args)
        elif t == "field_expression":
            self.add_call(self.text(fn.child_by_field_name("field")), self.receiver(fn.child_by_field_name("value")), n, args)
        elif t == "scoped_identifier":
            path = fn.child_by_field_name("path")
            self.add_call(self.text(fn.child_by_field_name("name")), self.receiver(path) if path is not None else None, n, args)
        elif t == "super":
            self.add_call("constructor", "super", n, args)
        return True

    def on_new_expression(self, n: Node) -> bool:
        ctor = n.child_by_field_name("constructor")
        args = n.child_by_field_name("arguments")
        if ctor is not None and ctor.type == "identifier":
            self.add_call(self.text(ctor), None, n, args, kind="new")
        elif ctor is not None and ctor.type == "member_expression":
            self.add_call(self.text(ctor.child_by_field_name("property")), self.receiver(ctor.child_by_field_name("object")), n, args, kind="new")
        return True

    def on_method_invocation(self, n: Node) -> bool:  # Java
        obj = n.child_by_field_name("object")
        self.add_call(self.text(n.child_by_field_name("name")), self.receiver(obj) if obj is not None else None, n,
                      n.child_by_field_name("arguments"))
        return True

    def on_object_creation_expression(self, n: Node) -> bool:  # Java
        t = n.child_by_field_name("type")
        name = _strip_generics(self.text(t))
        recv, _, base = name.rpartition(".")
        self.add_call(base, recv or None, n, n.child_by_field_name("arguments"), kind="new")
        return True

    def on_composite_literal(self, n: Node) -> bool:  # Go: Foo{...} / pkg.Foo{...}
        t = n.child_by_field_name("type")
        if t is not None and t.type == "type_identifier":
            self.add_call(self.text(t), None, n, None, kind="new")
        elif t is not None and t.type == "qualified_type":
            self.add_call(self.text(t.child_by_field_name("name")), self.text(t.child_by_field_name("package")), n, None, kind="new")
        return True

    def on_struct_expression(self, n: Node) -> bool:  # Rust: Foo { .. }
        name = n.child_by_field_name("name")
        if name is not None:
            raw = _strip_generics(self.text(name)).replace("::", ".")
            recv, _, base = raw.rpartition(".")
            self.add_call(base, recv or None, n, None, kind="new")
        return True

    def on_package_clause(self, n: Node) -> bool:  # Go
        ident = next((c for c in n.named_children if c.type == "package_identifier"), None)
        self.f.package = self.text(ident)
        return False

    def on_package_declaration(self, n: Node) -> bool:  # Java
        ident = next((c for c in n.named_children if c.type in ("scoped_identifier", "identifier")), None)
        self.f.package = self.text(ident)
        return False

    def on_import_declaration(self, n: Node) -> bool:  # Go and Java
        line = n.start_point[0] + 1
        if self.lang == "go":
            for spec in self._descend(n, "import_spec"):
                path = self.text(spec.child_by_field_name("path")).strip('"`')
                name = spec.child_by_field_name("name")
                alias = self.text(name) if name is not None else path.rsplit("/", 1)[-1]
                self.f.imports.append(Import(module=path, alias=alias, line=spec.start_point[0] + 1))
            return False
        target = next((c for c in n.named_children if c.type in ("scoped_identifier", "identifier")), None)
        full = self.text(target)
        if any(c.type == "asterisk" for c in n.children):
            self.f.imports.append(Import(module=full, names=[("*", "*")], line=line))
        else:
            mod, _, last = full.rpartition(".")
            self.f.imports.append(Import(module=mod, names=[(last, last)], line=line))
        return False

    def on_use_declaration(self, n: Node) -> bool:  # Rust
        line = n.start_point[0] + 1
        for path, alias in self._flatten_use(n.child_by_field_name("argument"), ""):
            mod, _, last = path.rpartition("::")
            if last == "self":
                mod, _, last = mod.rpartition("::")
            self.f.imports.append(Import(module=mod, names=[(last, alias or last)], line=line))
        return False

    def on_impl_item(self, n: Node) -> bool:  # Rust: methods live under the implementing type's name
        ty = _strip_generics(self.text(n.child_by_field_name("type")))
        trait = n.child_by_field_name("trait")
        if trait is not None:
            self.f.impls.append((ty, _strip_generics(self.text(trait))))
        body = n.child_by_field_name("body")
        self.scope.append((ty, "impl"))
        self.def_stack.append(None)
        try:
            if body is not None:
                self.visit_children(body)
        finally:
            self.scope.pop()
            self.def_stack.pop()
        return False

    # ---- type facts (feed receiver resolution) -------------------------------------------------------------------
    def _assign(self, left: Node | None, typ: str) -> None:
        if left is None or not typ:
            return
        lt = left.type
        if lt == "identifier":
            self.note_type(self.text(left), typ)
        elif lt in ("attribute", "member_expression", "field_expression", "selector_expression", "field_access"):
            obj = left.child_by_field_name("object") or left.child_by_field_name("value") or left.child_by_field_name("operand")
            prop = left.child_by_field_name("attribute") or left.child_by_field_name("property") or left.child_by_field_name("field")
            if obj is not None and prop is not None and self.text(obj) in ("self", "this"):
                self.note_type(self.text(prop), typ, on_class=True)

    def on_assignment(self, n: Node) -> bool:  # Python: x = Foo(), x: Foo = ..., self.x = Foo()
        left = n.child_by_field_name("left")
        ann = n.child_by_field_name("type")
        right = n.child_by_field_name("right")
        typ = self.text(ann) if ann is not None else self.value_type(right)
        if (not self.scope and ann is None and left is not None and left.type == "identifier" and right is not None
                and self.text(left)[:1].isupper() and right.type in ("subscript", "attribute", "identifier", "binary_operator")
                and "<expr>" not in self.chain(right if right.type != "binary_operator" else right.named_children[0])):
            typ = "alias:" + _squash(self.text(right), 200)  # Env = Annotated[EnvGraph, Depends(…)] / Url = str | URL
        if left is not None and left.type in ("pattern_list", "tuple_pattern"):
            self.destructured(left, right)
        elif left is not None and left.type == "identifier" and self.scope and self.scope[-1][1] == "class":
            self.note_type(self.text(left), typ, on_class=True)  # class-level `x: Foo`
        else:
            self._assign(left, typ)
        return True

    def on_type_alias_statement(self, n: Node) -> bool:  # Python 3.12: type Env = Annotated[...]
        kids = [c for c in n.named_children if c.type == "type"]
        if len(kids) == 2 and not self.scope:
            self.note_type(self.text(kids[0]), "alias:" + _squash(self.text(kids[1]), 200))
        return True

    def on_with_item(self, n: Node) -> bool:  # Python: with Client() as c (the resolver looks at __enter__)
        v = n.child_by_field_name("value")
        if v is not None and v.type == "as_pattern" and v.named_children:
            alias = v.child_by_field_name("alias")
            target = alias.named_children[0] if alias is not None and alias.named_children else None
            typ = self.value_type(v.named_children[0])
            if target is not None and target.type == "identifier" and typ:
                self.note_type(self.text(target), f"with:{typ}")
        return True

    def on_for_statement(self, n: Node) -> bool:  # Python `for x in xs`; Go `for _, v := range xs`
        rc = next((c for c in n.named_children if c.type == "range_clause"), None)
        if rc is not None:
            left, right = rc.child_by_field_name("left"), rc.child_by_field_name("right")
            ids = left.named_children if left is not None else []
            c = self.chain(right) if right is not None else "<expr>"
            if len(ids) == 2 and ids[1].type == "identifier" and "<expr>" not in c:
                self.note_type(self.text(ids[1]), f"item:{c}")  # slice element or map value
            return True
        self.loop_targets(n.child_by_field_name("left"), n.child_by_field_name("right"))
        return True

    on_for_in_clause = on_for_statement  # Python comprehensions

    def on_for_in_statement(self, n: Node) -> bool:  # JS/TS: only `for … of` yields elements
        if any(c.type == "of" for c in n.children):
            self.loop_targets(n.child_by_field_name("left"), n.child_by_field_name("right"))
        return True

    def on_for_expression(self, n: Node) -> bool:  # Rust: for x in xs.iter()
        self.loop_targets(n.child_by_field_name("pattern"), n.child_by_field_name("value"))
        return True

    def on_enhanced_for_statement(self, n: Node) -> bool:  # Java: for (Foo x : xs) / for (var x : xs)
        t, name = n.child_by_field_name("type"), n.child_by_field_name("name")
        if name is not None:
            typ = _strip_generics(self.text(t)) if t is not None and self.text(t) != "var" else self.iter_type(n.child_by_field_name("value"))
            self.note_type(self.text(name), typ)
        return True

    def element_callback(self, n: Node) -> None:
        """xs.forEach((x) => x.m()): the callback's first parameter is an element of xs."""
        fn = n.child_by_field_name("function")
        args = n.child_by_field_name("arguments")
        if fn is None or fn.type != "member_expression" or args is None or not args.named_children:
            return
        prop, obj = fn.child_by_field_name("property"), fn.child_by_field_name("object")
        cb = args.named_children[0]
        if prop is None or obj is None or self.text(prop) not in ELEMENT_CALLBACKS or cb.type not in ("arrow_function", "function_expression"):
            return
        ps = cb.child_by_field_name("parameters")
        first = ps.named_children[0] if ps is not None and ps.named_children else cb.child_by_field_name("parameter")
        if first is not None and first.type == "required_parameter" and first.child_by_field_name("type") is None:
            first = first.child_by_field_name("pattern")
        c = self.chain(obj)
        if first is not None and first.type == "identifier" and "<expr>" not in c:
            self.note_type(self.text(first), f"iter:{c}")

    def on_assignment_expression(self, n: Node) -> bool:  # JS: this.x = new Foo()
        self._assign(n.child_by_field_name("left"), self.value_type(n.child_by_field_name("right")))
        return True

    def on_variable_declarator(self, n: Node) -> bool:  # JS/TS (non-function values) and Java declarators
        name = n.child_by_field_name("name")
        if name is not None and name.type in ("array_pattern", "object_pattern"):
            self.destructured(name, n.child_by_field_name("value"))
            return True
        if name is None or name.type != "identifier":
            return True
        t = n.child_by_field_name("type")
        typ = self.text(t).lstrip(":").strip() if t is not None else self.value_type(n.child_by_field_name("value"))
        if not typ and n.parent is not None and n.parent.type in ("local_variable_declaration", "field_declaration"):
            pt = n.parent.child_by_field_name("type")
            typ = _strip_generics(self.text(pt)) if pt is not None and self.text(pt) != "var" else self.value_type(n.child_by_field_name("value"))
        on_class = n.parent is not None and n.parent.type == "field_declaration"
        v = n.child_by_field_name("value")
        while v is not None and v.type in ("as_expression", "satisfies_expression", "parenthesized_expression", "non_null_expression"):
            v = v.named_children[0] if v.named_children else None
        if not self.scope and self.lang in JSLIKE and v is not None and v.type == "identifier":
            # export const devtools = devtoolsImpl as unknown as Devtools: kept beside the type, which may be Devtools
            self.note_type("ref:" + self.text(name), self.text(v))
        self.note_type(self.text(name), typ, on_class=on_class)
        return True

    def on_public_field_definition(self, n: Node) -> bool:  # TS class field: repo: Repo = new Repo()
        name = n.child_by_field_name("name")
        t = n.child_by_field_name("type")
        typ = self.text(t).lstrip(":").strip() if t is not None else self.value_type(n.child_by_field_name("value"))
        self.note_type(self.text(name), typ, on_class=True)
        return True

    def on_short_var_declaration(self, n: Node) -> bool:  # Go: x := NewFoo() / x := &Foo{}
        left, right = n.child_by_field_name("left"), n.child_by_field_name("right")
        if left is not None and right is not None and left.named_children and right.named_children:
            self._assign(left.named_children[0], self.value_type(right.named_children[0]))
        return True

    def on_var_spec(self, n: Node) -> bool:  # Go: var x Foo
        t = n.child_by_field_name("type")
        for name in n.children_by_field_name("name"):
            self.note_type(self.text(name), self.text(t) if t is not None else "")
        return True

    def on_field_declaration(self, n: Node) -> bool:  # Go/Rust struct fields, Java class fields
        t = n.child_by_field_name("type")
        if self.lang == "java":
            return True  # declarators carry the names; on_variable_declarator handles them
        for name in n.children_by_field_name("name"):
            self.note_type(self.text(name), self.text(t) if t is not None else "", on_class=True)
        return True

    def on_let_declaration(self, n: Node) -> bool:  # Rust: let x: Foo = ... / let x = Foo::new()
        pat = n.child_by_field_name("pattern")
        t = n.child_by_field_name("type")
        typ = self.text(t) if t is not None else self.value_type(n.child_by_field_name("value"))
        if pat is not None and pat.type == "identifier":
            self.note_type(self.text(pat), typ)
        return True

    def on_mod_item(self, n: Node) -> bool:
        return True

    # ---- small utilities -----------------------------------------------------------------------------------------
    def add_call(self, name: str, receiver: str | None, n: Node, args: Node | None, kind: str = "call") -> None:
        if not name:
            return
        self.f.calls.append(Call(caller=self.caller, name=name, receiver=receiver, line=n.start_point[0] + 1,
                                 kind=kind, args=self.arg_count(args)))
        if args is not None:  # callbacks: sorted(xs, key=rank), re.sub(p, _bump, s), useEffect(load, [])
            for a in args.named_children:
                if a.type == "keyword_argument":
                    a = a.child_by_field_name("value")
                self.add_ref(a)

    def add_ref(self, a: Node | None) -> None:
        """A function used as a value. Recorded as a `ref` call; the resolver binds it only through imports/scopes."""
        if a is None:
            return
        if a.type == "identifier":
            self.f.calls.append(Call(self.caller, self.text(a), None, a.start_point[0] + 1, kind="ref"))
        elif a.type in ("member_expression", "attribute"):
            obj = a.child_by_field_name("object")
            prop = a.child_by_field_name("property") or a.child_by_field_name("attribute")
            if obj is not None and prop is not None and self.text(obj) in ("self", "this", "cls"):
                self.f.calls.append(Call(self.caller, self.text(prop), self.text(obj), a.start_point[0] + 1, kind="ref"))

    def on_jsx_opening_element(self, n: Node) -> bool:
        name = n.child_by_field_name("name") or (n.named_children[0] if n.named_children else None)
        if name is not None and name.type == "identifier" and self.text(name)[:1].isupper():
            self.f.calls.append(Call(self.caller, self.text(name), None, n.start_point[0] + 1, kind="jsx"))
        elif name is not None and name.type == "member_expression":  # <ui.Card/>
            prop = name.child_by_field_name("property")
            if prop is not None:
                self.f.calls.append(Call(self.caller, self.text(prop), self.receiver(name.child_by_field_name("object")),
                                         n.start_point[0] + 1, kind="jsx"))
        return True

    on_jsx_self_closing_element = on_jsx_opening_element

    def on_jsx_expression(self, n: Node) -> bool:  # onClick={handleClick}
        kids = n.named_children
        if len(kids) == 1:
            self.add_ref(kids[0])
        return True

    def js_require(self, n: Node, args: Node | None) -> None:
        first = args.named_children[0] if args is not None and args.named_children else None
        if first is None or first.type != "string":
            return
        imp = Import(module=self.text(first).strip("'\"`"), line=n.start_point[0] + 1)
        parent = n.parent
        if parent is not None and parent.type == "variable_declarator":
            target = parent.child_by_field_name("name")
            if target is not None and target.type == "identifier":
                imp.alias = self.text(target)
            elif target is not None and target.type == "object_pattern":
                for p in target.named_children:
                    if p.type == "shorthand_property_identifier_pattern":
                        imp.names.append((self.text(p), self.text(p)))
                    elif p.type == "pair_pattern":
                        imp.names.append((self.text(p.child_by_field_name("key")), self.text(p.child_by_field_name("value"))))
        self.f.imports.append(imp)

    def _descend(self, n: Node, t: str) -> Iterator[Node]:
        for c in n.named_children:
            if c.type == t:
                yield c
            else:
                yield from self._descend(c, t)

    def _flatten_use(self, n: Node | None, prefix: str) -> Iterator[tuple[str, str | None]]:
        if n is None:
            return
        t = n.type

        def join(s: str) -> str:
            return f"{prefix}::{s}" if prefix else s

        if t in ("identifier", "scoped_identifier", "crate", "self", "super", "metavariable"):
            yield join(self.text(n)), None
        elif t == "use_as_clause":
            yield join(self.text(n.child_by_field_name("path"))), self.text(n.child_by_field_name("alias"))
        elif t == "use_wildcard":
            yield join(self.text(n).removesuffix("*").rstrip(":")) + "::*", None
        elif t == "scoped_use_list":
            p = n.child_by_field_name("path")
            sub = join(self.text(p)) if p is not None else prefix
            yield from self._flatten_use(n.child_by_field_name("list"), sub)
        elif t == "use_list":
            for c in n.named_children:
                yield from self._flatten_use(c, prefix)
