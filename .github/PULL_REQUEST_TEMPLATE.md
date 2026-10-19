## What and why

<!-- One concern per PR. Say why; the diff already says what. Link the issue if there is one. -->

## How it was verified

- [ ] `ruff check aftershock tests` and `pytest -q` pass
- [ ] Web: `npm run lint`, `npm test`, `npm run build` (if `web/` changed)
- [ ] A test that fails without this change
- [ ] `aftershock testlab` (if parsing, resolution, impact, selection or culprit changed)

## Numbers

<!-- If this changes what Aftershock predicts: before → after on the affected benchmark, including if it got worse. Otherwise delete this section. -->

## Screenshots

<!-- UI changes: before and after, desktop and phone width. Otherwise delete this section. -->

## Checklist

- [ ] Docs match the code (README, docs/, `CHANGELOG.md`; a `DECISIONS.md` entry for a design choice)
- [ ] Anything that runs repo code stays behind the run gate ([SECURITY.md](../SECURITY.md))
- [ ] Added myself to `CONTRIBUTORS.md` (optional, encouraged)
