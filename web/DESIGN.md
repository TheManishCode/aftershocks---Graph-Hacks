# Aftershock UI — design system

The live version of this document is the app itself, at **`/design`**. Every token and
primitive on that page renders from the same source the product uses, so it cannot
drift. Read this file for the *rules*; open `/design` to see the result.

The visual language is **Aether Node** (`aether-node-dashboard-DESIGN.md`): black ground,
one inverted surface per viewport, hairline separation, mono-first type, and no hue
anywhere in the chrome.

---

## 1. What the interface is for

Aftershock answers one question — **"what breaks if I change this?"** — and the answer is
only worth anything if the reader can check it. So the interface has one organising
principle, and every rule below follows from it:

> **An answer is always shown with its evidence.**

Concretely: every page shows its receipts (how many graph queries, how long); every
edge shows how it was resolved and how confident the resolver is; every score shows the
numbers it was computed from; every list that truncates says how many it is hiding; and
anything a tool or a model produced is framed and monospaced rather than passed off as
prose the product wrote.

A corollary: **a number with no provenance is not shown at all.** If the backend cannot
say where a value came from, the right move is to leave it out, not to display it bare.

---

## 2. Colour

Three tiers, all in `app/globals.css`. Components only ever touch tier 2.

| Tier | Example | Who uses it |
| --- | --- | --- |
| 1 — raw palette | `--p-zinc-975`, `--p-orange-500` | only tier 2 |
| 2 — semantic | `--color-surface`, `--color-ink-muted`, `--color-sev-high` | **components** |
| 3 — shadcn | `--primary`, `--card`, `--border` | the vendored `ui/*` components |

Re-skinning the product is an edit to tier 1. Nothing outside `globals.css` names a hex
value or a raw palette token.

### The one colour rule that matters

**The chrome is achromatic. The severity ramp is the only hue in the product.**

- **Chrome** — white, `#E5E5E5` and black: primary buttons, active navigation, links,
  focus rings, selection, the logo mark. `--color-brand` still exists as the name for
  "the application speaking", but it now resolves to white. If it has no colour, it is
  part of the application, not part of the answer.
- **Severity** — `sev-none` → `sev-low` → `sev-medium` → `sev-high` → `sev-critical`
  (ink-muted → lime → amber → orange → red): risk, likelihood, impact tiers.

This is stronger than the old "cool accent, warm data" split. A chrome with no hue at
all cannot borrow from the ramp even by accident, and a reader never has to ask whether
a coloured thing is a finding or a button.

Three supporting roles exist so that status does not dilute the thermal ramp:
`pass` / `fail` / `warn` / `info` carry test and tool outcomes. A failing test is
`fail`, not `sev-critical` — it is an observed fact, not a risk estimate.

`data-1` … `data-6` are categorical hues for charts and graph groups. They encode
identity, never magnitude.

### Surfaces, inversion, and ink

The source gives `surface: #E5E5E5` and `text-primary: #FFFFFF`, which cannot describe
the same box — that pair is 1.1:1. They are **two roles, not one**:

- **Ordinary surfaces** are near-black, separated by `#27272A` hairlines, in a strict
  ladder: `ground` → `base` → `surface` → `surface-raised` → `surface-overlay`.
  **Depth is one rung up the ladder plus a hairline, never a drop shadow.**
- **The inverted surface** (`bg-invert`, `#E5E5E5`, carrying `invert-ink` black) is the
  focal object. **One per viewport.** `Panel tone="focal"`, the logo mark, the active
  segment of a `Segmented`, and the skip link are the sanctioned uses. Anything you
  *read* at length does not go on it.

Lines come in three weights (`line`, `line-strong`, `line-loud`). Ink has four steps:
`ink-strong`, `ink`, `ink-muted`, `ink-faint`. `ink-muted` is 7.4:1 on ground and is the
floor for real text — anything dimmer is decoration. **Never put `text-white` on an
inverted fill**; that pairing is how the retired palette's violet rules failed when the
fill went light. Use `text-invert-ink`.

---

## 3. Type

Two faces, and the split is inverted from the usual arrangement on purpose:

- **JetBrains Mono** (`font-mono`) — **the default, including body prose.** Almost every
  string in Aftershock is a path, a symbol id, a count or a duration, so the machine
  face is the baseline.
- **Inter** (`font-display`, 400/500/600) — the display step and page titles. It marks
  the handful of places where *a person wrote the words* rather than a parser emitting
  them. A reader can tell the product's voice from the graph's output without reading
  either.

Scale: `micro` 10 · `label` 12/600/0.06em uppercase · `caption` 12 · `code` 12.5 ·
`body-sm` 13 · `body` 16 · `body-lg` 18 · `subheading` 22 · `heading` (clamped to 36) ·
`display` (clamped to 64) · `display-xl` (clamped to 112).

`label` is a real step, not a utility soup: every control label — buttons included — is
mono 12/600/0.06em uppercase. The `link` button variant opts back out, because a link
inside prose is prose.

**`display` (64px) belongs to the hero and only the hero.** `PageHeader` uses `heading`.
If every tool page opens at the same size as the landing page, the size stops meaning
anything.

**Weights stop at 600.** Emphasis comes from inversion and size, not from mass.

---

## 4. Shape, spacing and layout

Radii are bound to roles, so a glance tells you what a box is:
`card` 24px (panels, cards, dialogs, popovers) · `control` 20px (buttons, inputs,
chips) · pill (switches, meters, dots). Nested boxes use `nested` 16px or `inner` 12px
so corners stay concentric — reusing the 24px card radius inside a card is the single
most common way this language is made to look wrong.

Spacing has four declared steps and layout never invents a fifth: `8` / `16` / `24` /
`80` (`--space-base`, `--space-gap`, `--space-card`, `--space-section`).

Three containers, and no more:

- **`Panel`** — a titled data container. Dense, nestable, scroll-safe. The default for
  anything you read. Tones: `default` · `raised` · `recessed` · `focal` · `emphasis` ·
  `bare`. Takes `note=` for the sentence that explains what the panel is showing; use it
  instead of a tooltip.
- **`Bento`** — card radius, hover lift. For choosing where to go, not for reading.
- **`Slab`** — a titled band grouping several panels.

`tone="emphasis"` is what `tone="brand"` used to be: attention without a hue, a louder
border on a lifted surface. It was renamed because a token called "brand" would now be
lying about what it draws.

`Grid` takes `cols={1..6}` or the two asymmetric presets `"main-aside"` /
`"aside-main"`. `Stack` and `Toolbar` cover the rest. Pages do not write raw
`grid-template-columns`.

---

## 5. Motion, and the failure mode it can cause

Four cues: masked reveal, staggered entrance, scroll-triggered transition, hover lift.
Two are pure CSS (`.as-lift`, `.as-stagger`); the two that need an IntersectionObserver
live in `components/motion.tsx`, and **there is exactly one observer implementation in
the product**. Tokens: `--ease-out-quint` for entrances, `--ease-in-out-quart` for
symmetric moves, `--dur-fast|base|slow|ambient`.

Reduced motion is handled in CSS, not in the components: `[data-enter]`/`[data-reveal]`
collapse to their final state under `prefers-reduced-motion` and under
`data-motion="reduced"`.

**The rule that is not negotiable.** An entrance animation hides its own content until
an observer fires. Anything that stops the observer firing — scripting off, a blocked
bundle, a hydration error, a tab restored in the background — is a blank page that
still returns HTTP 200, still has all its text in the DOM, and still reads correctly to
a screen reader. No status code and no DOM assertion can see it.

Three things prevent it, and all three are load-bearing:

1. **The `html[data-anim="on"]` gate.** Every `opacity: 0` resting state is scoped
   behind it. The attribute is set by the inline script in `app/layout.tsx`, *before and
   outside* its `try/catch`, so a throwing `localStorage` cannot arm the animations
   without arming the gate. No script, no hidden state, content simply visible.
2. **The resolved states are scoped to the same gate**, so `html[data-anim="on"]
   [data-enter="in"]` matches the start state's specificity. A bare `[data-enter="in"]`
   is (0,1,0) and would silently lose.
3. **`useEnter`'s threshold defaults to 0.** `intersectionRatio` is visible area over
   *total* area, so an element taller than `1/threshold` viewports can never reach a
   fractional threshold. At the old 0.15, anything over ~6.7 screens tall stayed hidden
   forever. Depth tuning belongs in `rootMargin`.

`app/motion-safety.test.ts` asserts all three against the source. Treat any new
`opacity: 0` resting state as belonging inside the gate.

---

## 6. Accessibility rules that are actually enforced

1. **One `<main>` per page.** The shell owns `<main id="content">`. `Page` is a `<div>`.
   Every route was checked for exactly one `<main>` in its SSR output.
2. **`title=` is not an accessible name.** The only legitimate `title=` left in the app
   is on truncated table cells in Cypher and on the `file:line` of an Explore suggestion
   chip — both cases where the attribute carries *the full value of truncated text*, not
   a second description of a control.
3. **Glyphs are never the only channel.** `12✗ 3✓` is `aria-hidden` with an `sr-only`
   "12 failing and 3 passing tests reach it" beside it.
4. **Decorative icons carry `aria-hidden`.** An icon that is the only content of a
   control gets an `aria-label` instead.
5. **Streaming regions are `aria-live="polite"`** — the heal timeline and the Ask trace.
6. **Loading does not blank the screen.** A re-run dims the previous result
   (`opacity-60`) rather than replacing it.
7. **Contrast is checked against the fill that actually renders.** The inverted surface
   makes a light fill ordinary, which makes `text-white` on it an easy and invisible
   mistake; see §2.

---

## 7. Component inventory

`@/components/ds` is the only place to import presentation from. `@/components/kit`
holds the four components that carry *product meaning* and nothing else.

```
components/ds/
  page.tsx        Page, PageHeader, Empty, Spinner, ErrorNote
  panel.tsx       Panel, Bento, Slab, Toolbar, ToolbarSep, Grid, Stack
  primitives.tsx  Eyebrow, Chip, Mono, Code, Kbd, Meter, Distribution,
                  Sparkline, Segmented, Range, Skeleton, SkeletonRows,
                  Callout, Divider, Scroller
  metric.tsx      Metric, MetricRow, Delta
  severity.tsx    SEV_TEXT/BG/SOFT/BORDER, fromLevel, fromTier, fromScore,
                  fromProbability, SeverityChip, SeverityBar, RiskGauge,
                  SeverityLegend
  code-block.tsx  CodeBlock           (anything a tool or model emitted)
  trace.tsx       Trace, TraceLine, TraceIcon, TraceTitle, TraceSummary,
                  TraceReceipts, TraceCollapsible
  tokens.ts       the one sanctioned CSS-variable → TypeScript bridge, for
                  canvas/SVG-gradient code that cannot resolve a custom
                  property. Nothing outside it may contain a hex colour.

components/motion.tsx   useEnter, Enter, Reveal   (see §5)
components/ambient.tsx  the ground-layer canvas

components/kit.tsx
  Receipts     what the answer cost, from the API's own numbers
  CopyButton   with a toast when the browser denies the clipboard
  SymLink      a symbol, linked to its Explore page
  FileLink     a file, linked to its Explore page
```

There is exactly one `Panel`, one `Metric` and one `Spinner` in the codebase, so a
re-skin cannot miss half the app.

---

## 8. Why this will not become a bottleneck

1. **One file re-skins everything.** Every colour, size, radius and duration is a CSS
   variable in `globals.css`, and no component hard-codes a value. A new palette is one
   edit; it does not touch a single `.tsx` file. The Seismic → Aether change was almost
   entirely that edit — the components that needed touching were the handful that had
   assumed the chrome was dark.
2. **Appearance and meaning are separated.** `ds/` knows nothing about repos, symbols or
   receipts; `kit.tsx` knows nothing about pixels. Either can be replaced alone.
3. **The API's vocabulary is adapted, not spread.** The backend speaks in `level`
   strings, `tier` strings, probabilities and 0–100 scores. Each gets one adapter
   (`fromLevel`, `fromTier`, `fromProbability`, `fromScore`) onto a single severity
   ramp. When the backend grows a fifth vocabulary, that is one new function, not a new
   colour map in every page.
4. **The style guide is a route, not a document.** `/design` ships with the app and
   renders from live source. The rule is: **a component that is not on `/design` is a
   component nobody else on the team knows exists.**

---

## 9. Conventions for new screens

- Import presentation from `@/components/ds`, product vocabulary from
  `@/components/kit`. Never reach into `components/ds/<file>` directly.
- Put the page's reasoning in a header docblock — *why* this layout, not what it renders.
- Show receipts in the `PageHeader`.
- One inverted object per viewport, and never for running text.
- `display` type is the hero's alone.
- Any new `opacity: 0` resting state goes behind the `data-anim` gate (§5).
- State goes in the URL when a result is worth sharing (Impact, Diff, Path, Culprit all
  do this — a link reproduces the analysis exactly).
- Empty states say what to do next. "No results" alone is a bug.
- Truncating is fine; truncating silently is not. Say "and 14 more".
- Add the primitive to `/design` in the same commit that adds it to `ds/`.
