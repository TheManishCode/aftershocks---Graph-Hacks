# Changelog

## Unreleased (2026-10-18)

### Added

- **Reference graphs are hidden, not listed** (D13). Graphs named in the Redis set `aftershock:lab` (click, httpx,
  zustand, code-graph-rag, epicenter, epitest) no longer appear on the home page, in `/repos`, MCP or the CLI list.
  `aftershock lab <name> [--off]` toggles membership, `aftershock repos --all` and `GET /repos?lab=1` include them.
  Nothing was deleted; direct URLs still work.
- **Overloads bind to the implementation** (D14, `PARSER_VERSION` 13). `@overload` stubs keep their `#N` ids, but calls,
  members and method lookups bind to the last non-stub definition. Lookup expands a symbol to its whole overload
  family, and stubs never appear as "untested". Test selection for click `Context.invoke` went from 0 to 350 tests.
- **More resolution:** names a module re-exports from a library count as external (`export { cn } from "cn"`),
  pathlib `Path / "x"` types as `Path`, and rest-spread forwarding (`(...args) => f(...args)`) binds through forwarders.
- **Friendlier UI:** three onboarding steps on the home page; Explore shows clickable suggestions (most central
  symbols, hotspot files) instead of an empty box; `#N` overload counters are stripped from every label
  (`symName`); subsystems sharing a directory are named by their telling files (`src · middleware, vanilla +2`).
- **Ask** labels module-level code as `<module>`; the impact page accepts `?targets=` as an alias of `?t=`.
- `scripts/smoke.mjs` (headless page smoke across widths) and `scripts/gaps.py` (blind call sites by pattern).

### Fixed (2026-10-18, later)

- Dead-code "unused exports" no longer lists `.d.ts` declarations or interfaces.
- An overload refactor briefly dropped nested defs under numbered parents (`prompt#3.prompt_func`); caught by an
  edge diff and fixed before any graph shipped (click back to 2693 edges).

- **Callback parameters, destructuring, properties and more externals** (`PARSER_VERSION` 12).
  - A callback's parameters bind to what the callee passes them: `create((set, get) => …)` reaches the `setState` and
    `getState` that `createStoreImpl` calls `createState` with. The parser records how each function calls
    (`pcall:`) or hands on (`pfwd:`) its parameters; the resolver follows up to 5 hops, through curried factories and
    through middleware that returns an arrow taking the same parameters (`create()(devtools(immer((set) => …)))`).
  - Destructuring: `const { getState, setState: put } = store` and `[a, b] = f()` positions.
  - Imported module-level variables carry their type (`import { store } from './s'`; `store.getState()`).
  - `@property`/`cached_property` return types type attribute chains (`response.url.copy_with`).
  - More calls are classified as external rather than blind: methods on literals (`", ".join`), every Python builtin
    name, `*args`/`**kwargs`, standard pytest fixtures, values a library context manager yields
    (`with TestClient(app) as c`) and every chain off them (`client.get().json()`), and builtin-typed attributes
    (`result.output.splitlines()`).
  - Fixed: a JS test labelled like a function (`it('devtools', …)`) shadowed the imported `devtools`.
  - Blind call sites: zustand 606 → 454, click 797 → 385, httpx 559 → 310, Epicenter 1905 → 1201. Repo-bound rate:
    zustand 66.0 → 74.1%, click 63.2 → 70.1%, httpx 61.0 → 66.2%, Epicenter 44.4 → 51.4%. Edges: zustand +85, httpx
    +21, Epicenter +7, code-graph-rag +88, click unchanged. Eval F1 within ±.002 (zustand .072, httpx .116, click .149).
- **Factory-returned objects** (`PARSER_VERSION` 10, then 11).
  - An object literal evaluates to a *shape* whose members are the definitions it names: shorthand (`{ getState }`),
    `key: ref`, object methods and `...spread`. A function returning one (`return api as any`) types its callers'
    results. Inline arrow values have no definition and are not members.
  - `return useBoundStore` (a nested function) plus `Object.assign(useBoundStore, api)` gives a callable shape:
    `useBoundStore.getState()` reaches api's members, and `useBoundStore()` reaches the nested function.
  - Curried factories (`init ? impl(init) : impl`) type both `create(init)` and `create<T>()(init)`.
  - Shapes are synthetic and never written to the graph; every edge still lands on a real symbol (D11).
  - Fixed: `const f: Handler = () => …` recorded `Handler` as f's *return* type, which also blocked the body hint.
  - zustand call-site resolution 19.6% → 29.7%, repo-bound 43.5% → 66.0%. Eval F1 .068 → .073 (+ import-only
    .141 → .142). click, httpx, Epicenter and code-graph-rag edges are unchanged.
- **Element types, aliases and external-call accounting** (`PARSER_VERSION` 8, then 9).
  - Loop variables are typed by the element type of what they iterate. This covers Python `for`/comprehensions, JS
    `for…of`, Go `range`, Rust `for`, Java enhanced `for`, `enumerate`/`.items()`/`Object.entries` pairs, and the
    first parameter of `forEach`/`map`/`filter`-style callbacks. Subscripts (`xs[0]`, `d[k]`) take the element or
    value type, and `list[Foo]`, `dict[K, Foo]`, `Foo[]`, `Array<Foo>`, `Map<K, Foo>` and Go `[]Foo`/`map[K]Foo` are
    unwrapped. Literals type their locals (`[]` → list, `""` → str).
  - Python module-level type aliases (`Env = Annotated[Graph, …]`, `X = Y | None`, 3.12 `type X = …`) are followed,
    including through imports. `import a.b.c` also binds `a`.
  - Value aliases: `export const devtools = devtoolsImpl as unknown as Devtools` (also `satisfies`, parens, `!`, a
    plain identifier) resolves calls to the aliased definition.
  - **External calls are counted apart.** A call that provably leaves the repo is classified as external rather than
    unresolved. That includes a library import, a builtin, a method on a builtin or library type, a literal, or a JS
    global. The repo node carries `external_sites` and `repo_resolution_rate` (resolved ÷ call sites that are not
    external). `index` and the overview page show both rates (D10).
  - Call-site resolution: click 49.0% → 49.8%, Epicenter 30.5% → 31.2%, zustand 14.3% → 19.6%. httpx is
    unchanged; code-graph-rag (46.3%) has no before figure. Repo-bound rate: click 63%, httpx 61%, zustand 44%, Epicenter 44%, code-graph-rag
    56%.
  - Eval F1, all tiers: zustand .040 → .068 (+ import-only .124 → .141), click .148 → .149, httpx unchanged (.117).
- **`aftershock eval`** (`analysis/evaluate.py`) replays non-merge commits and scores impact predictions against the
  files each commit actually co-changed.
  - Scores are broken down by tier, change kind and test vs code files.
  - Reported alongside: the import-only variant and a same-directory baseline.
- **Import-only dependents** in impact results (`import_only`): files that import a changed file but have no resolved
  call to the change.
  - Shown in the markdown report (collapsed) and as a tile in the web impact view.
  - New query `importers_of`.
- **Return-type, `with` and fixture inference** for receiver types.
  - The parser records `ret_hint`: the type every `return` in a function agrees on when it declares none. `return
    self` and `return cls()` count as `Self`. A `return` inside a nested callback is not counted, and generators are
    marked `yield:`. It also records `with X() as x` bindings.
  - The resolver uses these hints for `f().m()` and `x = f(); x.m()`. `with` bindings resolve through `__enter__`.
    An untyped parameter of a test function is typed by the pytest fixture of that name (test class, file, then
    `conftest.py` upwards). Iterator and Generator return annotations are unwrapped.
  - Go result tuples such as `(*S, error)` now type the first result.
  - Call-site resolution: click 41% → 49%, httpx 47% → 50%, Epicenter 29% → 31%. zustand and code-graph-rag are
    unchanged.
  - Eval F1: httpx .113 → .117. click .157 → .148, because correct links to about 350 fixture-driven tests are
    scored against co-change (README → *Measured accuracy*).
  - `PARSER_VERSION` 6 forces a re-parse.
- **Override and dispatch edges.**
  - The resolver emits `OVERRIDES` from a method to the inherited method it redefines. It walks base classes
    transitively and Go/Rust impl types, and skips constructors and name-mangled privates. It covers Python, TS/JS,
    Java and Rust.
  - Impact follows overrides both ways:
    - A contract change (signature/rename/delete) to a base method reaches its overrides, using a new
      `weights.json` `override` block. A signature change also gets an arity verdict.
    - A change to an override reaches callers of the base method through a `DISPATCH` step that records `via`.
  - Culprit reachability and test selection follow dispatch too.
  - Dead-code no longer reports overriders.
  - The UI and agent explain the hops ("calls X, which can dispatch to Y").
  - Eval F1 rose from .153 to .157 on click and from .102 to .113 on httpx.
  - Nothing needs a forced re-parse: outgoing-edge digests relink the affected files.
- Tests for overrides and dispatch (fixture `run_job`, arity verdicts, culprit reach, Python/TS/Java/Rust resolver
  cases), return hints and fixture/`with` resolution, including what must not resolve (84 tests).
- Tests for the node-cap fix, tsconfig `paths` semantics, cast/parenthesized arrow exports, star re-exports and
  import-only dependents (76 tests).

### Fixed

- **Overview crashed on any repo with an import cycle** (`e.map is not a function`). The API returns cycles as
  `{files, size, example}`, but the page still treated each one as a list of files. It now draws the example loop and
  the cycle's size. Found by the headless smoke run on click.
- **Impact truncation:** when a hop overflowed `max_nodes`, the whole hop was dropped. Now its strongest nodes fill
  the remaining budget.
- **tsconfig `paths`:**
  - An exact pattern (`"pkg"`) swallowed `pkg/sub` imports.
  - `*` in the middle of a target (`./src/*.ts`) was not substituted.
- **JSONC stripping:** it treated `/*` inside strings such as `"pkg/*"` as a comment opener and dropped the rest of
  tsconfig.
- **Star re-exports:** symbol lookup did not follow Python `from x import *` or TS `export * from`. It now does, with a
  cycle guard.
- **TS functions:** `export const f = (() => …) as T`, `satisfies` and `!` wrappers are now recognized as functions.
  `PARSER_VERSION` 5 forces a re-parse.

### Removed

- The README claim that method overrides are invisible to impact.
- Unused web UI primitives: `badge`, `card`, `scroll-area`, `separator`, `skeleton`, `tabs`. Nothing imported them.
