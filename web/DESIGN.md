# Aftershock UI — design system (GROUNDTRUTH)

The UI reads like an instrument: slate ground, ink type, one acid "mark" colour for the
live reading, hairline rules, numbered sheets. A neo-grotesk (Inter) for what a person
says; a mono (JetBrains Mono) for what the instrument reads out.

## Where things live

- `app/globals.css` — tokens (`void`, `sheet`, `deep`, `slate`, `ink*`, `line*`, `mark`,
  `pass`/`fail`/`warn`/`info`/`hot`) and the `gt-*` classes (`gt-row`, `gt-field`,
  `gt-label`, `gt-scroll`, `gt-links`, `gt-f`).
- `components/gt.tsx` — every primitive: `Page`, `Head`, `Sheet`, `Cols`, `Stack`, `Spec`,
  `Figure`, `Chip`, `Mono`, `Label`, `Meter`, `Seg`, `Range`, `Steps`, `Measuring`,
  `Skeleton`, `Empty`, `ErrorNote`, `Callout`, `CodeBlock`, `RiskGauge`.
- `components/shell/` — the top bar, repo switcher, numbered nav, command palette.
- `components/motion.tsx` — entrances. Hidden start states only apply under
  `html[data-anim="on"]` (set inline in `app/layout.tsx`), so a page never renders blank
  if scripts fail; `app/motion-safety.test.ts` enforces it.

## Rules

- Pages are numbered in nav order: 01 Overview, 02 Impact, 03 Diff, 04 Culprit, 05 Path,
  06 Tests, 07 Explore, 08 Ask, 09 Cypher. Sheets inside a page are numbered too.
- Colour is data. `mark` is the current reading or primary action; `pass`/`fail`/`warn`
  are outcomes. Nothing decorative is coloured.
- `gt-*` classes are unlayered CSS and beat Tailwind utilities. Never give a `gt-*` class
  a `display` if it is used with responsive `hidden`/`md:flex`; set display in the markup.
- Every answer shows its receipts (queries, ms) and every list has an empty state.
- Layout must hold at 390 px with no horizontal scroll.
