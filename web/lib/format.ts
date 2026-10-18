/** Display helpers shared by every screen. */

export const pct = (x: number | null | undefined, digits = 0) =>
  x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`;

export const num = (x: number | null | undefined) => (x === null || x === undefined ? "—" : Math.round(x).toLocaleString());

/** Epoch seconds (what the graph stores) → "3h ago". */
export function relTime(epoch: number | null | undefined): string {
  if (!epoch) return "—";
  const s = Date.now() / 1000 - epoch;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = new Date(epoch * 1000);
  return s < 365 * 86400 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : d.getFullYear().toString();
}

export const ms = (x: number) => (x < 1000 ? `${x.toFixed(x < 10 ? 1 : 0)} ms` : `${(x / 1000).toFixed(2)} s`);

/** `api/graph.py::EnvGraph.ro` → `["api/graph.py", "EnvGraph.ro"]`. */
export function splitId(id: string): [string, string] {
  const i = id.indexOf("::");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 2)];
}

/** A test's graph id as a pytest node id: `tests/t.py::TestA.test_b` -> `tests/t.py::TestA::test_b` (mirrors the server). */
export function pytestNode(id: string): string {
  const [file, q] = splitId(id);
  if (!q || q === "<module>") return file;
  return `${file}::${symName(q).replaceAll(".", "::")}`;
}

/** A symbol's display name: drops the `#2`/`#3` that keeps same-scope redefinitions (overloads) apart in ids. */
export const symName = (qname: string) => qname.replace(/#\d+(?=$|\.)/g, "");

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** A stable hue per name (FNV-1a), so a subsystem or file has the same colour on every screen. */
export function hue(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 360;
}
export const tint = (s: string, alpha = 1) => `oklch(0.72 0.09 ${hue(s)} / ${alpha})`; // quiet hues: colour is for status

/*
 * Risk colour used to live here, as four maps keyed by the API's own strings.
 * It now lives in `@/components/ds/severity` as one ramp with `fromLevel`,
 * `fromTier`, `fromScore` and `fromProbability` adapting the API's vocabularies
 * onto it — so there is a single answer to "what colour is a high risk", and
 * changing it is one edit rather than four.
 */

/** How an edge was resolved, in words (aftershock/ingest/resolve.py). */
export const HOW: Record<string, string> = {
  local: "same file",
  import: "explicit import",
  "module-attr": "module.attr",
  self: "self / this",
  inferred: "inferred receiver",
  "method-unique": "unique method name",
  "name-unique": "unique name",
  jsx: "JSX element",
  new: "constructor",
  coverage: "recorded test run",
};
