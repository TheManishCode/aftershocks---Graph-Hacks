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
  ground: "#070a08",
  base: "#0b0e0c",
  surface: "#111613",
  "surface-raised": "#171f1a",
  "surface-overlay": "#1e2822",
  line: "#243029",
  "line-strong": "#2e3c34",
  "line-loud": "#3c4d43",
  ink: "#c6d1ca",
  "ink-strong": "#f4f8f5",
  "ink-muted": "#93a199",
  "ink-faint": "#45514b",
  brand: "#9b87ff",
  "brand-solid": "#7c5cff",
  "sev-none": "#93a199",
  "sev-low": "#8be06e",
  "sev-medium": "#e8b339",
  "sev-high": "#ff5a1f",
  "sev-critical": "#ff4747",
  pass: "#8be06e",
  fail: "#ff4747",
  warn: "#e8b339",
  info: "#22c9db",
  "data-1": "#9b87ff",
  "data-2": "#22c9db",
  "data-3": "#e8b339",
  "data-4": "#52b6ff",
  "data-5": "#e879c7",
  "data-6": "#8be06e",
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
  fast: 120,
  base: 220,
  slow: 420,
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
