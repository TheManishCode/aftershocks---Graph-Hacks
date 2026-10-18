# Aftershock UI — design system

The live version of this document is the app itself, at **`/design`**. Every token and
primitive on that page renders from the same source the product uses, so it cannot
drift. Read this file for the *rules*; open `/design` to see the result.

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
| 1 — raw palette | `--p-violet-500`, `--p-orange-500` | only tier 2 |
| 2 — semantic | `--color-surface`, `--color-ink-muted`, `--color-sev-high` | **components** |
| 3 — shadcn | `--primary`, `--card`, `--border` | the vendored `ui/*` components |

Re-skinning the product is an edit to tier 1. Nothing outside `globals.css` names a hex
value or a raw palette token.

### The one colour rule that matters

**Brand (violet) is chrome. The severity ramp is data. They never swap.**

- **Brand** — `--color-brand`: primary buttons, active navigation, links, focus rings,
  selection. If it is violet, it is part of the application, not part of the answer.
- **Severity** — `sev-none` → `sev-low` → `sev-medium` → `sev-high` → `sev-critical`
  (ink-low → lime → amber → orange → red): risk, likelihood, impact tiers. Nothing else
  in the product is orange or red.

The accent is deliberately cool so the warm end of the spectrum stays reserved. A blast
radius tool where the chrome is also orange has thrown away its loudest signal.

Three supporting roles exist so that status does not dilute the thermal ramp:
`pass` / `fail` / `warn` / `info` carry test and tool outcomes. A failing test is
`fail`, not `sev-critical` — it is an observed fact, not a risk estimate.

`data-1` … `data-6` are categorical hues for charts and graph groups. They encode
identity, never magnitude.

### Surfaces and ink

Surfaces are a strict ladder: `ground` → `base` → `surface` → `surface-raised` →
`surface-overlay`. **Depth is one rung up the ladder plus a hairline, never a drop
shadow.** Lines come in three weights (`line`, `line-strong`, `line-loud`).

Ink has four steps: `ink-strong`, `ink`, `ink-muted`, `ink-faint`. `ink-muted` is
6.6:1 on ground and is the floor for real text — anything dimmer is decoration.

---

## 3. Type

Three faces, each with exactly one job:

- **Barlow Condensed** (`font-display`) — headlines and large metric readouts. Chosen so
  a six-digit count stays on one line.
- **Inter** (default) — everything read as prose or UI.
- **JetBrains Mono** (`font-mono`) — code, ids, paths, numbers, technical labels. **If a
  machine produced the string, it is monospaced.** That is the fastest signal in the
  product for "this is data, not our words".

Scale: `micro` 11 · `caption` 12 · `code` 12.5 · `body-sm` 13 · `body` 15 ·
`body-lg` 18 · `subheading` 22 · `heading` 30 · `display` and `display-xl` (both
clamped, so no media queries are needed).

`code` sits between `caption` and `body-sm` on purpose: JetBrains Mono runs large for
its point size, so 12.5px beside 13px prose reads as the same size.

**Weights stop at 600.** Emphasis comes from colour and size, not from mass.

---

## 4. Shape and layout

Four radii, each bound to a role, so a glance tells you what a box is:
`control` 8px (buttons, inputs, chips) · `panel` 10px (data) · `bento` 18px (navigation
cards) · pill (switches, meters).

Three containers, and no more:

- **`Panel`** — a titled data container. Dense, nestable, scroll-safe. The default for
  anything you read. Takes `note=` for the sentence that explains what the panel is
  showing; use it instead of a tooltip.
- **`Bento`** — 18px radius, hover lift. For choosing where to go, not for reading.
- **`Slab`** — a titled band grouping several panels.

`Grid` takes `cols={1..6}` or the two asymmetric presets `"main-aside"` /
`"aside-main"`. `Stack` and `Toolbar` cover the rest. Pages do not write raw
`grid-template-columns`.

---

## 5. Accessibility rules that are actually enforced

These are not aspirations; the rebuild removed concrete violations of each.

1. **One `<main>` per page.** The shell owns `<main id="content">`. `Page` is a `<div>`.
   Every route was checked for exactly one `<main>` in its SSR output.
2. **`title=` is not an accessible name.** A tooltip that disagrees with the visible
   label gives a screen reader a different control from the one on screen. The only
   legitimate `title=` left in the app is on truncated table cells in Cypher and on the
   `file:line` of an Explore suggestion chip — both cases where the attribute carries
   *the full value of truncated text*, not a second description of a control. Everywhere
   else the name is in the label, with `sr-only` text where a glyph carries the meaning.
3. **Glyphs are never the only channel.** `12✗ 3✓` is `aria-hidden` with an `sr-only`
   "12 failing and 3 passing tests reach it" beside it.
4. **Decorative icons carry `aria-hidden`.** An icon that is the only content of a
   control gets an `aria-label` instead.
5. **Streaming regions are `aria-live="polite"`** — the heal timeline and the Ask trace.
6. **Loading does not blank the screen.** A re-run dims the previous result
   (`opacity-60`) rather than replacing it, so a new depth can be compared against the
   old one.

---

## 6. Component inventory

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

components/kit.tsx
  Receipts     what the answer cost, from the API's own numbers
  CopyButton   with a toast when the browser denies the clipboard
  SymLink      a symbol, linked to its Explore page
  FileLink     a file, linked to its Explore page
```

`components/kit.tsx` previously also re-exported page furniture (`Page`, `PageHeader`,
`Tile`, `Stat`, `Spinner`, `Empty`, `ErrorNote`, `Meter`, `Kbd`) as a shim while the
screens were rebuilt. That shim is gone. There is now exactly one `Panel`, one `Metric`
and one `Spinner` in the codebase, so a re-skin cannot miss half the app.

---

## 7. Why this will not become a bottleneck

The stated requirement was that the UI must not constrain the product later. Four
properties buy that:

1. **One file re-skins everything.** Every colour, size, radius and duration is a CSS
   variable in `globals.css`, and no component hard-codes a value. A new palette is one
   edit; it does not touch a single `.tsx` file.
2. **Appearance and meaning are separated.** `ds/` knows nothing about repos, symbols or
   receipts; `kit.tsx` knows nothing about pixels. Either can be replaced alone.
3. **The API's vocabulary is adapted, not spread.** The backend speaks in `level`
   strings, `tier` strings, probabilities and 0–100 scores. Each gets one adapter
   (`fromLevel`, `fromTier`, `fromProbability`, `fromScore`) onto a single severity
   ramp. When the backend grows a fifth vocabulary, that is one new function, not a new
   colour map in every page.
4. **The style guide is a route, not a document.** `/design` ships with the app and
   renders from live source, so a primitive that drifts is visible immediately. The rule
   is: **a component that is not on `/design` is a component nobody else on the team
   knows exists.**

---

## 8. Conventions for new screens

- Import presentation from `@/components/ds`, product vocabulary from
  `@/components/kit`. Never reach into `components/ds/<file>` directly.
- Put the page's reasoning in a header docblock — *why* this layout, not what it renders.
  Every rebuilt page has one; they are the handoff.
- Show receipts in the `PageHeader`.
- State goes in the URL when a result is worth sharing (Impact, Diff, Path, Culprit all
  do this — a link reproduces the analysis exactly).
- Empty states say what to do next. "No results" alone is a bug.
- Truncating is fine; truncating silently is not. Say "and 14 more".
- Add the primitive to `/design` in the same commit that adds it to `ds/`.
