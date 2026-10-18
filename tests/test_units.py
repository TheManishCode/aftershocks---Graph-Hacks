"""Pure functions: no graph needed."""

from __future__ import annotations

from aftershock import cli
from aftershock.analysis import report
from aftershock.analysis.impact import tier
from aftershock.mcp_server import _compact


def test_tiers_are_monotonic():
    order = ["possible", "likely", "definite"]
    seen = [order.index(tier(p / 100)) for p in range(5, 101, 5)]
    assert seen == sorted(seen)


def _result(**over):
    base = {
        "seeds": [{"id": "a.py::f", "name": "f", "file": "a.py", "line": 3, "change": "signature"}],
        "impacted": [{"id": "b.py::g", "name": "g", "file": "b.py", "line": 9, "p": 0.8, "tier": "likely", "hop": 1,
                      "path": [{"from": "b.py::g", "to": "a.py::f", "type": "CALLS", "how": "import"}],
                      "verdict": "arity mismatch"}],
        "tests": [{"id": "t.py::test_g", "name": "test_g", "file": "t.py", "line": 1, "p": 0.6, "hop": 2}],
        "untested_seeds": [], "hidden_coupling": [], "owners": [{"name": "Dev", "email": "d@x", "commits": 12.0}],
        "counts": {"impacted": 1, "tests": 1, "files": 2, "definite": 0, "likely": 1, "possible": 0},
        "risk": {"score": 64, "level": "high", "components": {"expected_breakages": 0.8, "seed_centrality": 0.1}},
        "hops": 3, "note": "static analysis",
    }
    return {**base, **over}


def test_report_renders_core_sections():
    md = report.render(_result())
    assert md.startswith(report.MARKER)
    assert "high risk (64/100)" in md
    assert "`g`" in md and "```\nt.py\n```" in md  # test files listed in a copyable block
    assert "Dev (12 commits)" in md  # commit counts are weighted floats; they render as ints
    assert "**arity mismatch**" in md
    assert "12.0" not in md


def test_report_escapes_table_breaking_names():
    r = _result()
    r["impacted"][0]["name"] = "a|b"
    assert "a\\|b" in report.render(r)


def test_compact_caps_lists_and_drops_logs():
    out = _compact({"rows": list(range(100)), "receipts": {"log": [1, 2]}, "x": 0.123456789})
    assert len(out["rows"]) == 41 and out["rows"][-1] == "... 60 more"
    assert "log" not in out["receipts"] and out["x"] == 0.1235


def test_cli_gate():
    imp = {"risk": {"score": 85, "level": "critical"}}
    assert cli._gate(imp, None) == 0
    assert cli._gate(imp, "high") == 3
    assert cli._gate({"risk": {"score": 20, "level": "low"}}, "medium") == 0


def test_cli_parses_json_after_subcommand():
    a = cli.parser().parse_args(["impact", "repo", "f", "--change", "delete", "--json"])
    assert a.json and a.change == "delete" and a.targets == ["f"]


def test_tsconfig_paths_follow_typescript_semantics():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import RepoConfig, Resolver

    # zustand's real shape: a block comment, `pkg/*` and a later `**/*` glob that once read as one long comment
    cfg = RepoConfig.load({"tsconfig.json": b"""{"compilerOptions": {"skipLibCheck": true /* FIXME */, "paths": {
        // a package that imports itself by name, as zustand's tests do
        "pkg": ["./src/index.ts"], "pkg/*": ["./src/*.ts"], "@/*": ["./src/*"],}},
        "include": ["src/**/*", "tests/**/*"]}"""})
    files = [parse_file(p, b"export const x = 1\n") for p in ("src/index.ts", "src/vanilla.ts", "src/lib/api.ts")]
    r = Resolver(files, cfg)
    assert r.js_module("tests/a.test.ts", "pkg") == "src/index.ts"
    assert r.js_module("tests/a.test.ts", "pkg/vanilla") == "src/vanilla.ts"  # not swallowed by the exact "pkg"
    assert r.js_module("tests/a.test.ts", "@/lib/api") == "src/lib/api.ts"
    assert r.js_module("tests/a.test.ts", "pkgx") is None


def test_cast_and_parenthesized_arrow_exports_are_functions():
    from aftershock.ingest.parse import parse_file

    src = b"""export const create = (<T,>(init: T, opts?: object) => init) as Create
export const shallow = ((a: unknown) => a) satisfies Eq
export const config = { a: 1 } as const
"""
    defs = {d.name: d for d in parse_file("src/react.ts", src).defs}
    assert defs["create"].kind == "function" and (defs["create"].min_args, defs["create"].max_args) == (1, 2)
    assert defs["shallow"].kind == "function"
    assert "config" not in defs  # a cast object literal is still not a function


def test_lookup_follows_star_reexports():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import Resolver

    files = [
        parse_file("pkg/__init__.py", b"from ._models import *\n"),
        parse_file("pkg/_models.py", b"class Response:\n    pass\n"),
        parse_file("tests/test_a.py", b"import pkg\n\ndef test_x():\n    pkg.Response()\n"),
        parse_file("src/index.ts", b"export * from './vanilla.ts'\n"),
        parse_file("src/vanilla.ts", b"export function createStore() {}\n"),
        parse_file("src/loop.ts", b"export * from './loop.ts'\n"),
    ]
    r = Resolver(files)
    for f in files:
        r.bind_file(f)
    assert r.resolve_attr("tests/test_a.py", "test_x", "pkg", "Response")[0].id == "pkg/_models.py::Response"
    assert r.lookup(["src/index.ts"], "createStore").id == "src/vanilla.ts::createStore"
    assert r.lookup(["src/loop.ts"], "nothing") is None  # a self-referencing star export terminates


def test_overrides_link_redefined_methods_but_not_constructors_or_private_names():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    files = [
        parse_file("a.py", b"class Base:\n    def __init__(self): pass\n    def run(self): pass\n    def __hide(self): pass\n"
                           b"    def keep(self): pass\n"),
        parse_file("b.py", b"from a import Base\n\nclass Mid(Base):\n    pass\n\nclass Leaf(Mid):\n"
                           b"    def __init__(self): pass\n    def run(self, x): pass\n    def __hide(self): pass\n"),
        parse_file("c.ts", b"export class A { m(): void {} }\nexport class B extends A { constructor() { super() } m(): void {} }\n"),
    ]
    ov = {(e.src, e.dst) for e in resolve(files).edges if e.type == "OVERRIDES"}
    assert ov == {("b.py::Leaf.run", "a.py::Base.run"), ("c.ts::B.m", "c.ts::A.m")}  # found through Mid


def test_overrides_cover_java_subclasses_and_rust_trait_impls():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    files = [
        parse_file("A.java", b"class A { void m() {} }\nclass B extends A { void m() {} }\nclass U { void f(A a) { a.m(); } }\n"),
        parse_file("y.rs", b"trait T { fn run(&self); }\nstruct S;\nimpl T for S { fn run(&self) {} }\n"),
    ]
    edges = {(e.type, e.src, e.dst) for e in resolve(files).edges}
    assert ("OVERRIDES", "A.java::B.m", "A.java::A.m") in edges
    assert ("OVERRIDES", "y.rs::S.run", "y.rs::T.run") in edges
    assert ("CALLS", "A.java::U.f", "A.java::A.m") in edges  # the call that dispatch widens to B.m


def test_return_hints_need_every_return_to_agree():
    from aftershock.ingest.parse import parse_file

    py = parse_file("m.py", b"""class Store:
    def me(self):
        return self
    @classmethod
    def make(cls):
        return cls()
def opened(p):
    if not p:
        return None
    s = Store()
    return s
def mixed(x):
    if x:
        return Store()
    return x.other()
def gen():
    yield Store()
def typed() -> int:
    return Store()
""")
    ts = parse_file("a.ts", b"""export class Repo {}
export const make = () => new Repo()
export function build() { [1].map(() => { return 5 }); return new Repo() }
""")
    go = parse_file("x.go", b"package x\ntype S struct{}\nfunc New() (*S, error) { return &S{}, nil }\n")
    hints = {d.qname: d.ret_hint for f in (py, ts, go) for d in f.defs if d.kind in ("function", "method")}
    assert hints == {
        "Store.me": "Self", "Store.make": "Self", "opened": "call:Store", "mixed": "", "gen": "yield:call:Store",
        "typed": "",  # a declared return type wins; no hint is recorded
        "make": "Repo", "build": "Repo",  # the callback's `return 5` belongs to the callback
        "New": "",  # Go always declares its results
    }
    from aftershock.ingest.resolve import resolve

    go2 = parse_file("x.go", b"package x\ntype S struct{}\nfunc (s *S) Run() {}\nfunc New() (*S, error) { return &S{}, nil }\n"
                             b"func Use() { New().Run() }\n")
    assert ("x.go::Use", "x.go::S.Run") in {(e.src, e.dst) for e in resolve([go2]).edges}  # first of (*S, error)


def test_receivers_typed_by_returns_with_blocks_and_pytest_fixtures():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    files = [
        parse_file("pkg/core.py", b"""class Client:
    def __enter__(self):
        return self
    def get(self): pass
class Store:
    def save(self): pass
def open_store(p):
    return Store()
def gen():
    yield Store()
def mixed(x):
    if x:
        return Store()
    return Client()
"""),
        parse_file("tests/conftest.py", b"""import pytest
from pkg.core import Client
@pytest.fixture
def client():
    with Client() as c:
        yield c
"""),
        parse_file("tests/unit/test_x.py", b"""import pytest
from pkg.core import Store, open_store, gen, mixed
def test_a(client):
    client.get()
    open_store(1).save()
    gen().save()
    mixed(1).save()
class TestS:
    @pytest.fixture
    def store(self):
        return Store()
    def test_b(self, store):
        store.save()
def test_c(store):
    store.save()
"""),
    ]
    sites = {(e.src.split("::")[1], e.dst.split("::")[1], ln) for e in resolve(files).edges if e.how == "inferred"
             for ln in e.lines}
    assert sites == {
        ("test_a", "Client.get", 4),  # conftest fixture one directory up, yielding a `with` binding
        ("test_a", "Store.save", 5),  # undeclared return read from the body
        ("TestS.test_b", "Store.save", 13),  # fixture defined on the test class
    }  # not: a generator's result (6), disagreeing returns (7), a class fixture outside its class (15)


def test_element_types_follow_loops_subscripts_and_callbacks():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    def inferred(files):
        return {(e.dst.split("::")[1], ln) for e in resolve(files).edges if e.how == "inferred" for ln in e.lines}

    py = parse_file("app.py", b"""from typing import Iterator, Optional
class Job:
    def run(self): pass
class Queue:
    jobs: list[Job]
    by_id: dict[str, Job]
    def each(self) -> Iterator[Job]: ...
    def go(self, extra: Optional[list[Job]], names: list[str]):
        for j in self.jobs:
            j.run()
        for k, v in self.by_id.items():
            v.run()
        for i, j2 in enumerate(sorted(self.jobs)):
            j2.run()
        self.jobs[0].run()
        first = self.by_id["a"]
        first.run()
        [x.run() for x in self.each()]
        for e in extra:
            e.run()
        for k2 in self.by_id:
            k2.run()
        for n in names:
            n.run()
        self.jobs[1:].run()
""")
    assert inferred([py]) == {("Job.run", ln) for ln in (10, 12, 14, 15, 17, 18, 20)}  # not: dict keys, str, a slice

    ts = parse_file("q.ts", b"""class Job { run() {} }
class Queue {
  jobs: Job[] = [];
  byId: Map<string, Job> = new Map();
  go(list: Array<Job>) {
    for (const j of this.jobs) { j.run(); }
    for (const [k, v] of this.byId.entries()) { v.run(); }
    list.forEach((x) => x.run());
    this.jobs.map(y => y.run());
    this.byId.get("a");
    for (const key in this.jobs) { key.run(); }
  }
}
""")
    assert inferred([ts]) == {("Job.run", ln) for ln in (6, 7, 8, 9)}  # not: `for … in` yields keys

    go = parse_file("q.go", b"""package q
type Job struct{}
func (j *Job) Run() {}
func Drain(jobs []*Job, byID map[string]Job) {
	for _, j := range jobs { j.Run() }
	for _, v := range byID { v.Run() }
	for i := range jobs { i.Run() }
	jobs[0].Run()
}
""")
    assert {ln for d, ln in inferred([go]) if d == "Job.Run"} >= {5, 6, 8}
    assert ("Job.Run", 7) not in inferred([go])

    rs = parse_file("q.rs", b"""struct Job {}
impl Job { fn run(&self) {} }
fn drain(jobs: Vec<Job>) {
    for j in jobs.iter() { j.run(); }
}
""")
    java = parse_file("Q.java", b"""class Job { void run() {} }
class Q { void go(java.util.List<Job> jobs) { for (var j : jobs) { j.run(); } } }
""")
    assert ("Job.run", 4) in inferred([rs])
    assert ("Job.run", 2) in inferred([java])


def test_type_aliases_and_dotted_imports_bind_like_python():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    files = [
        parse_file("pkg/__init__.py", b"from .utils import echo\n"),
        parse_file("pkg/utils.py", b"def echo(x): pass\n"),
        parse_file("pkg/graph.py", b"""from typing import Annotated
class EnvGraph:
    def ro(self): pass
Env = Annotated[EnvGraph, Depends(make)]
MaybeEnv = Env | None
Loop = Loop
"""),
        parse_file("api/routes.py", b"""import pkg.graph
from pkg.graph import Env, MaybeEnv, Loop
def get(env: Env, other: MaybeEnv, bad: Loop):
    env.ro()
    other.ro()
    bad.ro()
    pkg.echo(1)
"""),
    ]
    got = {(e.dst.split("::")[1], e.how, ln) for e in resolve(files).edges if e.src.startswith("api/") for ln in e.lines}
    assert ("EnvGraph.ro", "inferred", 4) in got  # through an imported alias
    assert ("EnvGraph.ro", "inferred", 5) in got  # an alias of an alias, with `| None`
    assert not any(ln == 6 and how == "inferred" for _, how, ln in got)  # a self-referencing alias resolves to nothing
    assert ("echo", "module-attr", 7) in got  # `import pkg.graph` also binds `pkg`


def test_const_value_aliases_reach_the_aliased_function():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    files = [
        parse_file("src/devtools.ts", b"""const devtoolsImpl = (fn: any) => fn
export const devtools = devtoolsImpl as unknown as Devtools
export const persist = (devtoolsImpl satisfies Fn)
export const loop = loop as any
"""),
        parse_file("src/index.ts", b"export * from './devtools'\n"),
        parse_file("test/a.test.ts", b"""import { devtools, persist, loop } from '../src/index'
devtools(1)
persist(2)
loop(3)
"""),
    ]
    got = {(e.dst.split("::")[1], ln) for e in resolve(files).edges if e.src.startswith("test/") for ln in e.lines}
    assert ("devtoolsImpl", 2) in got  # through `as unknown as T` and a star re-export
    assert ("devtoolsImpl", 3) in got  # through `satisfies` and parens
    assert not any(ln == 4 for _, ln in got)  # a self-alias resolves to nothing


def test_factory_returned_objects_type_their_members():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    files = [
        parse_file("src/vanilla.ts", b"""type CreateStoreImpl = (init: any) => any
const createStoreImpl: CreateStoreImpl = (createState) => {
  const setState: Api['setState'] = (partial) => {}
  const getState = () => state
  const subscribe = (listener) => listener
  const api = { setState, getState, subscribe, reset() {}, inline: () => 1 }
  return api as any
}
export const createStore = ((createState) => createState ? createStoreImpl(createState) : createStoreImpl) as CreateStore
"""),
        parse_file("src/react.ts", b"""import { createStore } from './vanilla'
const createImpl = (createState) => {
  const api = createStore(createState)
  const useBoundStore: any = (selector?: any) => selector
  Object.assign(useBoundStore, api)
  return useBoundStore
}
export const create = ((createState) => createState ? createImpl(createState) : createImpl) as Create
"""),
        parse_file("test/basic.test.ts", b"""import { create } from '../src/react'
import { createStore } from '../src/vanilla'
const useBoundStore = create(() => ({}))
useBoundStore.getState()
useBoundStore.setState({})
useBoundStore()
const api = createStore(() => ({}))
api.reset()
api.inline()
const plain = { getState: 1 }
plain.getState()
const useTyped = create<State>()(() => ({}))
useTyped.subscribe()
useTyped()
"""),
    ]
    got = {(e.dst.split("::")[1], ln) for e in resolve(files).edges if e.src.startswith("test/") for ln in e.lines}
    assert ("createStoreImpl.getState", 4) in got  # create() -> createImpl -> Object.assign(useBoundStore, api)
    assert ("createStoreImpl.setState", 5) in got  # a typed arrow const: its annotation is not its return type
    assert ("createImpl.useBoundStore", 6) in got  # calling the function the factory returned
    assert ("createStoreImpl.reset", 8) in got  # a method in the returned object literal
    assert ("createImpl.useBoundStore", 14) in got and ("createStoreImpl.subscribe", 13) in got  # create<T>()(init)
    assert not any(ln in (9, 11) for _, ln in got)  # an inline arrow has no definition; an unrelated literal
    typed = parse_file("src/f.ts", b"const f: Handler = () => new Foo()\n").defs[1]
    assert (typed.returns, typed.ret_hint) == ("", "Foo")


def test_provably_external_calls_are_counted_apart_from_blind_spots():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    py = parse_file("app.py", b"""import numpy as np
from mylib import Thing
class Svc:
    client: np.Client
    def go(self, name: str, other):
        bits = []
        bits.append(1)
        name.lower()
        np.zeros(3)
        arr = np.ones(2)
        arr.sum()
        self.client.send()
        str(other).strip()
        Thing().run()
        other.frobnicate()
        mystery().run()
""")
    ts = parse_file("ui.ts", b"""import { Math as M2 } from "./local";
const Math2 = 1;
export function f(xs: string[], o: any) {
  Math.max(1, 2);
  Object.keys(o);
  xs.join(",");
  [1, 2].map((x) => x);
  setTimeout(() => 0, 1);
  o.whatever();
}
""")
    res = resolve([py, ts])
    # app.py: append, lower, zeros, ones, sum (np result), send (np-typed attr), strip, Thing(), Thing().run
    # ui.ts: Math.max, Object.keys, join (string[]), map on an array literal, setTimeout
    assert res.external == {"app.py": 9, "ui.ts": 5}
    # blind spots: frobnicate on an untyped param, mystery() and its result; a method on `any`
    assert res.unresolved == {"app.py": 3, "ui.ts": 1}


def test_callback_params_bind_to_what_the_callee_passes():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    files = [
        parse_file("src/vanilla.ts", b"""const createStoreImpl = (createState) => {
  const setState = (partial) => {}
  const getState = () => state
  const api = { setState, getState }
  const state = createState(setState, getState, api)
  return api
}
export const createStore = (createState) => createStoreImpl(createState)
export const store = createStore(() => ({}))
"""),
        parse_file("src/mw.ts", b"""export const logger = (config) => (set, get, api) => config((...a) => set(...a), get, api)
export const tag = (fn) => (set, get) => fn(set, get)
"""),
        parse_file("test/cb.test.ts", b"""import { createStore, store } from '../src/vanilla'
import { tag } from '../src/mw'
createStore((set, get) => {
  set({})
  get()
  return {}
})
createStore(tag((set, get) => ({ go: () => get() })))
const { getState, setState: put } = store
getState()
put({})
it('createStore', () => createStore(() => ({})))
"""),
    ]
    got = {(e.dst.split("::")[1], ln) for e in resolve(files).edges if e.src.startswith("test/") for ln in e.lines}
    assert ("createStoreImpl.setState", 4) in got and ("createStoreImpl.getState", 5) in got  # createState(set, get)
    assert ("createStoreImpl.getState", 8) in got  # through a middleware that hands its params on (retparams)
    assert ("createStoreImpl.getState", 10) in got and ("createStoreImpl.setState", 11) in got  # destructured import
    assert ("createStore", 12) in got  # a test labelled like a function does not shadow the import


def test_library_values_reach_through_properties_fixtures_and_literals():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    lib = parse_file("pkg/res.py", b"""class Result:
    @property
    def output(self) -> str:
        return ""
""")
    conf = parse_file("tests/conftest.py", b"""import pytest
@pytest.fixture
def client():
    from starlette.testclient import TestClient
    with TestClient(app) as c:
        yield c
""")
    t = parse_file("tests/test_x.py", b"""from pkg.res import Result
def test_a(client, monkeypatch, *args, **kw):
    r = client.get("/")
    r.json()
    client.post("/").json()
    Result().output.splitlines()
    monkeypatch.setattr(1, 2)
    kw.get("x")
    ", ".join([])
    print(len(args))
""")
    res = resolve([lib, conf, t])
    # get, json, post, json, splitlines, setattr, kw.get, join; builtins (print, len) are not counted at all
    assert res.external.get("tests/test_x.py") == 8
    assert res.unresolved.get("tests/test_x.py", 0) == 0


def test_rest_forwarding_wrappers_and_reexported_library_names():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    files = [
        parse_file("src/vanilla.ts", b"""const createStoreImpl = (createState) => {
  const setState = (partial) => {}
  const getState = () => state
  const state = createState(setState, getState)
  return { setState, getState }
}
export const createStore = (createState) => createStoreImpl(createState)
"""),
        parse_file("src/mw.ts", b"""export function combine(init, create) {
  return (...args) => Object.assign({}, init, (create as any)(...args))
}
export const persist = (config) => (set, get) => config((...a) => { save(); set(...(a as any)) }, get)
"""),
        parse_file("src/utils.ts", b'export { cn } from "cn"\n'),
        parse_file("test/m.test.ts", b"""import { createStore } from '../src/vanilla'
import { combine, persist } from '../src/mw'
import { cn } from '../src/utils'
createStore(combine({}, (set, get) => { set({}); return get() }))
createStore(persist((set) => { set({}); return {} }))
cn('a')
"""),
        parse_file("tool.py", b"""from pathlib import Path
from tree_sitter import Node
def f(root: Path, n: Node):
    (root / "x").write_text("")
    n.child_by_field_name("name")
"""),
    ]
    res = resolve(files)
    got = {(e.dst.split("::")[1], ln) for e in res.edges if e.src.startswith("test/") for ln in e.lines}
    assert ("createStoreImpl.setState", 4) in got and ("createStoreImpl.getState", 4) in got  # through (...args)
    assert ("createStoreImpl.setState", 5) in got  # persist hands on a wrapper that forwards to the real set
    assert res.unresolved.get("test/m.test.ts", 0) == 0  # cn is a library's, re-exported
    assert res.external.get("tool.py") == 2 and res.unresolved.get("tool.py", 0) == 0  # Path / str; imported type


def test_calls_bind_to_the_implementation_not_an_overload_stub():
    from aftershock.ingest.parse import parse_file
    from aftershock.ingest.resolve import resolve

    files = [
        parse_file("pkg/core.py", b"""import typing as t
class Command:
    @t.overload
    def main(self, a: int) -> int: ...
    @t.overload
    def main(self, a: str) -> str: ...
    def main(self, a):
        return self.run(a)
    def run(self, a):
        return a
@t.overload
def make(x: int) -> Command: ...
def make(x):
    def inner():  # a nested def of the implementation must not take its place
        return 1
    return Command()
def use(c: Command):
    c.main(1)
    make(1).run(2)
"""),
    ]
    res = resolve(files)
    dst = {e.dst.split("::")[1] for e in res.edges if e.src.endswith("::use")}
    assert dst == {"Command.main#3", "make#2", "Command.run"}, dst


def test_subsystems_sharing_a_directory_are_named_by_their_files():
    from aftershock.analysis.architecture import _hint, _name

    assert _name(["src/click/core.py", "tests/test_a.py", "tests/test_b.py", "tests/test_c.py"]) == "src/click"

    assert _hint(["src/middleware/persist.ts", "src/middleware/devtools.ts", "src/index.ts"]) == "devtools, persist +1"
