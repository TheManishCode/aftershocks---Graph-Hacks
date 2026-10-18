/**
 * The design tokens, in TypeScript.
 *
 * Canvas, SVG-gradient and third-party-chart code cannot always resolve a CSS
 * custom property, so this file is the one sanctioned bridge. Values are read
 * from the stylesheet at runtime when a document exists and fall back to the
 * literals below during SSR and in tests.
 *
 * RULE: nothing outside this file may contain a hex colour. If you need a
 * colour in TS, add it here with a `--color-*` name that exists in globals.css.
 */

/** Semantic colour names that exist as `--color-<name>` in globals.css. */
export type ColorToken =
  | "ground"
  | "base"
  | "surface"
  | "surface-raised"
  | "surface-overlay"
  | "invert"
  | "invert-strong"
  | "invert-ink"
  | "line"
  | "line-strong"
  | "line-loud"
  | "ink"
  | "ink-strong"
  | "ink-muted"
  | "ink-faint"
  | "brand"
  | "brand-solid"
  | "sev-none"
  | "sev-low"
  | "sev-medium"
  | "sev-high"
  | "sev-critical"
  | "pass"
  | "fail"
  | "warn"
  | "info"
  | "data-1"
  | "data-2"
  | "data-3"
  | "data-4"
  | "data-5"
  | "data-6";

/** SSR / test fallbacks. Kept in sync with the tier-1 palette in globals.css. */
const FALLBACK: Record<ColorToken, string> = {
  ground: "#000000",
  base: "#09090b",
  surface: "#0e0e11",
  "surface-raised": "#18181b",
  "surface-overlay": "#1f1f23",
  invert: "#e5e5e5",
  "invert-strong": "#ffffff",
  "invert-ink": "#000000",
  line: "#27272a",
  "line-strong": "#3f3f46",
  "line-loud": "#52525b",
  ink: "#d4d4d8",
  "ink-strong": "#ffffff",
  "ink-muted": "#a1a1aa",
  "ink-faint": "#71717a",
  brand: "#ffffff",
  "brand-solid": "#e5e5e5",
  "sev-none": "#a1a1aa",
  "sev-low": "#a3e635",
  "sev-medium": "#fbbf24",
  "sev-high": "#f97316",
  "sev-critical": "#ef4444",
  pass: "#a3e635",
  fail: "#f87171",
  warn: "#fbbf24",
  info: "#22d3ee",
  "data-1": "#e5e5e5",
  "data-2": "#22d3ee",
  "data-3": "#fbbf24",
  "data-4": "#38bdf8",
  "data-5": "#e879f9",
  "data-6": "#a3e635",
};

const cache = new Map<ColorToken, string>();

/** Resolve a token to a concrete colour. Theme-aware: the cache clears on theme change. */
export function color(token: ColorToken): string {
  const hit = cache.get(token);
  if (hit) return hit;
  let value = FALLBACK[token];
  if (typeof window !== "undefined" && typeof getComputedStyle === "function") {
    const read = getComputedStyle(document.documentElement).getPropertyValue(`--color-${token}`).trim();
    if (read) value = read;
  }
  cache.set(token, value);
  return value;
}

/** Call after switching theme so canvas colours re-resolve on the next paint. */
export const clearColorCache = () => cache.clear();

/** The categorical ramp, in the order a chart should consume it. */
export const DATA_SERIES: ColorToken[] = ["data-1", "data-2", "data-3", "data-4", "data-5", "data-6"];

/** The thermal ramp, low → critical. Index with a severity level. */
export const SEVERITY_SCALE = ["sev-none", "sev-low", "sev-medium", "sev-high", "sev-critical"] as const;

export const MOTION = {
  fast: 140,
  base: 260,
  slow: 560,
  easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
  easeInOut: "cubic-bezier(0.76, 0, 0.24, 1)",
} as const;

/** True when the user (or the OS) asked for reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  const forced = document.documentElement.getAttribute("data-motion");
  if (forced === "reduced") return true;
  if (forced === "full") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
