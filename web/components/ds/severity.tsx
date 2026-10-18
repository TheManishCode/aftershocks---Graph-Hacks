/**
 * Severity — the single source of truth for "how bad is this?".
 *
 * The product has several risk vocabularies (risk levels, impact tiers,
 * confidence, pass/fail). They all map onto ONE five-step thermal ramp so a
 * reader learns the colour language once:
 *
 *   none → low → medium → high → critical
 *   grey   lime   amber    orange   red
 *
 * Nothing else in the product is allowed to be orange or red. If a new feature
 * needs a severity, map it to `Severity` here rather than picking a colour.
 *
 * Colour is never the only channel: every component here also carries a word,
 * a shape or a position, so the UI survives colour-blindness and greyscale print.
 */

import * as React from "react";

import { cn } from "@/lib/utils";
import { Chip, Meter } from "./primitives";

export type Severity = "none" | "low" | "medium" | "high" | "critical";

/** Text colour per step. */
export const SEV_TEXT: Record<Severity, string> = {
  none: "text-sev-none",
  low: "text-sev-low",
  medium: "text-sev-medium",
  high: "text-sev-high",
  critical: "text-sev-critical",
};

/** Solid fill per step — pair with dark text. */
export const SEV_BG: Record<Severity, string> = {
  none: "bg-sev-none",
  low: "bg-sev-low",
  medium: "bg-sev-medium",
  high: "bg-sev-high",
  critical: "bg-sev-critical",
};

/** Tinted surface + border per step, for chips and rows. */
export const SEV_SOFT: Record<Severity, string> = {
  none: "border-line-strong bg-surface text-ink-muted",
  low: "border-sev-low/35 bg-sev-low/10 text-sev-low",
  medium: "border-sev-medium/35 bg-sev-medium/10 text-sev-medium",
  high: "border-sev-high/35 bg-sev-high/10 text-sev-high",
  critical: "border-sev-critical/40 bg-sev-critical/12 text-sev-critical",
};

export const SEV_BORDER: Record<Severity, string> = {
  none: "border-line-strong",
  low: "border-sev-low/50",
  medium: "border-sev-medium/50",
  high: "border-sev-high/50",
  critical: "border-sev-critical/60",
};

const ORDER: Severity[] = ["none", "low", "medium", "high", "critical"];

/* ---------------------------- domain mappings ---------------------------- */

/** API risk level → severity. */
export const fromLevel = (level: "low" | "medium" | "high" | "critical" | undefined): Severity => level ?? "none";

/** Impact tier → severity. A `definite` breakage is the worst thing on screen. */
export const fromTier = (tier: "definite" | "likely" | "possible" | undefined): Severity =>
  tier === "definite" ? "critical" : tier === "likely" ? "high" : tier === "possible" ? "medium" : "none";

/** A 0..1 risk-ish probability → severity. Thresholds live here, not in pages. */
export function fromProbability(p: number): Severity {
  if (p >= 0.75) return "critical";
  if (p >= 0.5) return "high";
  if (p >= 0.25) return "medium";
  if (p > 0) return "low";
  return "none";
}

/** A 0..100 score → severity, matching the API's own banding. */
export function fromScore(score: number): Severity {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

/* -------------------------------------------------------------------------- */
/* SeverityChip — the labelled token. Word + colour, never colour alone.       */
/* -------------------------------------------------------------------------- */

export function SeverityChip({
  severity,
  children,
  className,
  dot = true,
  ...rest
}: React.ComponentProps<"span"> & { severity: Severity; dot?: boolean }) {
  return (
    <Chip
      className={cn(SEV_SOFT[severity], className)}
      /* `tone` is overridden by SEV_SOFT; pass `bare` so cva adds no competing colour. */
      tone="bare"
      dot={dot}
      {...rest}
    >
      {children ?? severity}
    </Chip>
  );
}

/* -------------------------------------------------------------------------- */
/* SeverityBar — a meter that colours itself from its own value.               */
/* -------------------------------------------------------------------------- */

export function SeverityBar({
  value,
  severity,
  className,
  label,
}: {
  /** 0..1 */
  value: number;
  /** Defaults to the band the value falls in. */
  severity?: Severity;
  className?: string;
  label?: string;
}) {
  const s = severity ?? fromProbability(value);
  return <Meter value={value} label={label} className={className} barClassName={SEV_BG[s]} />;
}

/* -------------------------------------------------------------------------- */
/* RiskGauge — the headline readout for a 0–100 score.                         */
/*                                                                            */
/* A segmented arc rather than a smooth dial: the five segments are the five   */
/* severity steps, so the shape itself tells you which band you are in even    */
/* in greyscale. (Apex Kinetix's instrument readout, reduced to one shape.)    */
/* -------------------------------------------------------------------------- */

export function RiskGauge({
  score,
  level,
  className,
  size = 132,
  caption,
}: {
  /** 0–100 */
  score: number;
  level?: Severity;
  className?: string;
  size?: number;
  caption?: React.ReactNode;
}) {
  const s = Math.max(0, Math.min(100, score));
  const sev = level ?? fromScore(s);
  const idx = ORDER.indexOf(sev);
  // 240° arc, 5 segments with a 4° gap.
  const SEGMENTS = 5;
  const sweep = 240;
  const gap = 4;
  const seg = (sweep - gap * (SEGMENTS - 1)) / SEGMENTS;
  const r = 44;
  const c = 50;
  const polar = (deg: number) => {
    const rad = ((deg - 90 - (360 - sweep) / 2 - (sweep - 180) / 2 + 180 - 180) * Math.PI) / 180;
    return [c + r * Math.cos(rad), c + r * Math.sin(rad)];
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = polar(from);
    const [x2, y2] = polar(to);
    return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
  };
  const start = (360 - sweep) / 2;

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div className="relative" style={{ width: size, height: size * 0.78 }}>
        <svg viewBox="0 0 100 82" className="size-full overflow-visible" role="img" aria-label={`Risk ${s} of 100, ${sev}`}>
          {Array.from({ length: SEGMENTS }, (_, i) => {
            const from = start + i * (seg + gap);
            const lit = i <= idx;
            return (
              <path
                key={i}
                d={arc(from, from + seg)}
                fill="none"
                strokeWidth={7}
                strokeLinecap="round"
                className={cn(
                  "transition-opacity duration-[var(--dur-slow)]",
                  lit ? SEV_TEXT[ORDER[i]] : "text-line-strong",
                )}
                stroke="currentColor"
                opacity={lit ? 1 : 0.45}
              />
            );
          })}
        </svg>
        <div className="absolute inset-x-0 bottom-1 flex flex-col items-center">
          <span className={cn("font-display text-[2.6rem] leading-none tabular-nums", SEV_TEXT[sev])}>{Math.round(s)}</span>
          <span className="font-mono text-micro uppercase text-ink-muted">{sev}</span>
        </div>
      </div>
      {caption && <p className="mt-1 text-center text-caption text-ink-muted">{caption}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* SeverityLegend — renders the ramp with its labels. Used on the style guide  */
/* and wherever a dense view needs to teach its colour language inline.        */
/* -------------------------------------------------------------------------- */

export function SeverityLegend({
  labels,
  className,
  omit = ["none"],
}: {
  labels?: Partial<Record<Severity, string>>;
  className?: string;
  omit?: Severity[];
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      {ORDER.filter((s) => !omit.includes(s)).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5 font-mono text-micro uppercase text-ink-muted">
          <span className={cn("size-2 rounded-full", SEV_BG[s])} aria-hidden />
          {labels?.[s] ?? s}
        </span>
      ))}
    </div>
  );
}
