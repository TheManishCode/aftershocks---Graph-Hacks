# Decisions

Short records of choices that are not obvious from the code.

## D1. Every edge says how it was resolved

Static call resolution is partial: 29% of call sites resolve on Epicenter. Each `CALLS` edge records `how` and
`confidence`, and impact weights edges by those. An answer can then show *why* it believes a dependency, instead of
presenting a guess as fact.

## D2. Impact is probabilistic, and the tiers are priors

Noisy-OR over edge weights from `weights.json` gives a ranking, not a verdict. The tiers (definite ≥ 0.9, likely
≥ 0.5) are documented as priors.

`aftershock eval` exists so the tiers can be checked against a repo's own history. On click, httpx and zustand the
definite tier never fired. Read the tiers as a ranking.

## D3. Import-only dependents are a separate list, not folded into the probabilities

The miss diagnosis on click found many co-changed files that import the anchor but have no resolved call edge to the
change. Adding them as low-probability impact nodes would blur what a probability means. They are listed separately
as "imports a changed file, no resolved call", capped at 30, and not scored.

The eval's `+importers` variant measures exactly this product output. It raises recall on all three repos, and on
click it beats the directory baseline on F1.

## D4. The eval is honest about its own bias

- The indexed HEAD stands in for every past state.
- Co-change coupling is excluded from the scoring because it is mined from the same history.
- A trivial same-directory baseline is always reported next to the simulator, and it wins on httpx and zustand. That
  result is in the README rather than hidden.

## D5. tsconfig `paths` follow TypeScript's matching rules

- An exact pattern wins over a wildcard.
- Among wildcards, the longest prefix wins.
- `*` is substituted anywhere in the target, as in `./src/*.ts`.
- JSONC comments are stripped string-aware, so `"pkg/*"` is not read as a comment opener.

All of these were real bugs found on zustand.

## D6. One tool surface

The CLI, REST, MCP and the Ask agent all call `tools.py`, so the agent cannot do anything a user cannot, and security
checks live in one place.

## D7. The API key never reaches the browser

The web app proxies `/api/v1/*` server-side and adds the key there.

## D8. Overrides are stored; dispatch is derived at query time

- **Only `OVERRIDES` is stored.** A stored `Child.run → Base.run` edge is a fact the resolver can prove. The
  alternative was adding a `CALLS` edge from every caller of `Base.run` to every override. That would multiply
  edges, blur resolved calls into guesses, and inflate fan-in and PageRank.
- **Dispatch is computed when asked.** The `dispatch_callers` query walks `OVERRIDES*1..3` and then `CALLS` back
  to the callers. The hop is labelled `DISPATCH` with a separate weight (0.6) and keeps the base method as `via`, so
  the UI can say why it is there.
- **Directional queries keep their meaning.** `dependents` and `dependencies` stay as they are, so culprit and path
  results do not change silently. Culprit adds dispatch explicitly.
- **Body changes to a base method do not reach overrides.** An override replaces the body; it does not run it. The
  exception is a `super()` call, which already resolves as an ordinary `CALLS` edge. Contract changes (signature,
  rename, delete) do reach overrides, because a renamed or removed base method leaves the override overriding
  nothing.

## D9. Return types are inferred only when every return agrees

- **One shared type or nothing.** A function with no declared return type gets a hint only if every non-null
  `return` evaluates to the same known type. One unknown or different return voids it. A wrong receiver type
  creates a confident wrong edge, which is worse than an unresolved call.
- **What does not count:**
  - Returns inside nested callbacks belong to the callback.
  - A generator's call result is the generator, so `yield` values are kept apart and used only for fixtures.
- **Declared types win.** A declared return type always beats the hint. The hint is stored apart from `returns`, so
  the signature digest and the "signature changed" verdict still describe only the written contract.
- **Fixtures resolve by pytest's own lookup:** the test class, then the file, then each `conftest.py` up to the
  root. The definition must carry a `fixture` decorator, so an imported helper that happens to share the name is not
  used. Edges are still tagged `inferred`. Fixture binding follows pytest's rules, but the type behind it is still
  inferred.
- **Accepted cost.** Fixtures link every test to shared harness code (`CliRunner.invoke` on click). That makes test
  selection more complete but lowers precision against the co-change proxy. We report the drop instead of
  down-weighting correct edges to please the metric.

## D10. External calls are counted apart; the headline rate is unchanged

- **Two numbers.** `resolution_rate` is resolved ÷ all call sites, as before. `repo_resolution_rate` is resolved ÷
  call sites that are not provably external. "Provably" means one of: an imported library name, an unshadowed builtin
  or JS global, a method on a builtin or library type, or a literal receiver. A call we merely failed to resolve stays
  in the denominator.
- **Why keep the old rate.** It is comparable across versions and does not depend on how good the classifier is. The
  new one tells a user how much of the code *inside the repo* the graph sees, which is what impact analysis depends
  on.
- **Shadowing wins.** A local def, import or binding with a builtin's name is not external, so a repo that defines
  its own `open` or `fetch` is not flattered.

## D11. Runtime-built objects are synthetic shapes, never graph nodes

- **What a shape is.** An object literal, or a function value plus what `Object.assign` merged into it, becomes an
  in-memory `Def` of kind `object`. Its members are the real definitions it names. Spreads and assign sources act as
  its bases. Shapes are cached per (file, scope, literal) and never emitted, so impact, culprit and the UI only ever
  see real symbols.
- **Only named definitions count.** `{ inc: () => … }` gives no member. The arrow's calls already belong to the
  enclosing function, and inventing a symbol for it would add nodes no user wrote.
- **Curried factories are a named rule, not general higher-order inference.** A function whose return is
  `x ? g(x) : g` types both `f(a)` and `f()(a)` as `g(a)`. Other `f()()` chains stay unresolved.
- **Known imprecision.** Members reassigned later (`api.subscribe = wrapper` in middleware) are not tracked, so the
  edge lands on the original member. The original is still on the runtime path, because wrappers call it.

## D12. Callback parameters bind to what the callee passes; library values stay library

- **Binding by use, not by declared type.** `create((set, get) => …)` is resolved by reading how the callee uses its
  parameter (`createState(setState, getState, api)`), not by reading `StateCreator`'s type. The use is in the repo and
  names real definitions; a declared function type would only give another type to chase, and JS has none.
- **Bounded.** At most 5 hops through parameter hand-offs, curried targets and returned arrows, and at most 3 levels of
  nested call arguments. Spread arguments stop binding, because positions are unknown after them.
- **Anything rooted in a library value is external.** A fixture or context manager that yields a library object makes
  every call chain off it external (`client.get().json()`). This could hide a repo function returned through a
  library call, which we judged rarer than the false "blind" count it removes. Shadowing still wins (D10).

## D13. Reference repositories are hidden as "lab" graphs, not deleted

- The eval clones and reference projects (click, httpx, zustand, code-graph-rag, epicenter, epitest) exist to measure
  and improve Aftershock, not to show users. They sit in the Redis set `aftershock:lab` and are left out of every
  listing (web, API, MCP, CLI) unless asked for (`repos --all`, `?lab=1`).
- Hiding instead of dropping keeps `aftershock eval` and regression diffs working without re-indexing, and graph
  deletion needs the owner's say-so. Direct URLs still resolve, so nothing is secret; it is a listing choice only.

## D14. Overloads bind to the implementation; lookup expands the family

- Python `@overload` stubs are real definitions with `#N` ids, but they never run. Calls, member tables and method
  lookups bind to the last same-scope definition that is not a stub, which is what Python executes.
- A user naming `Context.invoke` means the whole family, so lookup returns the base id plus every `#N` variant. Stubs
  are flagged in impact and never reported as untested. The `#N` counter is stripped from every label shown to users.
