/**
 * Metrics — numbers presented as instrument readouts.
 *
 * One rule, borrowed from Apex Kinetix and Zenith-X: the number is the loudest
 * thing in its box and its label is the quietest. Everything is tabular-nums in
 * the condensed display face, so a column of figures lines up on the decimal
 * and a six-digit count never wraps.
 */

import * as React from "react";

import { cn } from "@/lib/utils";
import { Eyebrow } from "./primitives";

export interface MetricProps extends Omit<React.ComponentProps<"div">, "children"> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Small text under the value: a unit, a share, a comparison. */
  hint?: React.ReactNode;
  /** Colour override for the value — pass a severity text class. */
  tone?: string;
  size?: "sm" | "md" | "lg";
  /** Rendered to the right of the value: a sparkline, a chip, a delta. */
  aside?: React.ReactNode;
}

const SIZE = {
  sm: "text-[1.25rem]",
  md: "text-[1.75rem]",
  lg: "text-[2.5rem]",
} as const;

export function Metric({ label, value, hint, tone, size = "md", aside, className, ...rest }: MetricProps) {
  return (
    <div className={cn("min-w-0", className)} {...rest}>
      <Eyebrow className="block truncate">{label}</Eyebrow>
      <div className="mt-1 flex items-end gap-2">
        <span className={cn("font-display leading-none text-ink-strong tabular-nums", SIZE[size], tone)}>{value}</span>
        {aside && <span className="mb-0.5 min-w-0 flex-1">{aside}</span>}
      </div>
      {hint && <div className="mt-1 truncate text-caption text-ink-muted">{hint}</div>}
    </div>
  );
}

/**
 * A label/value pair on one line. The workhorse of detail panels: dozens of
 * these stack without any of them shouting.
 */
export function MetricRow({
  label,
  value,
  tone,
  className,
  ...rest
}: Omit<React.ComponentProps<"div">, "children"> & { label: React.ReactNode; value: React.ReactNode; tone?: string }) {
  return (
    <div
      className={cn("flex min-h-[var(--row-h)] items-center gap-3 border-b border-line/60 last:border-0", className)}
      {...rest}
    >
      <span className="shrink-0 text-body-sm text-ink-muted">{label}</span>
      <span className={cn("ml-auto min-w-0 truncate text-right font-mono text-body-sm text-ink-strong tabular-nums", tone)}>
        {value}
      </span>
    </div>
  );
}

/**
 * A signed change. Direction is carried by the arrow *and* the colour, and the
 * caller says which direction is good — "more impacted symbols" is bad, "more
 * covered tests" is good, and the component cannot guess.
 */
export function Delta({
  value,
  goodWhen = "down",
  format = (n: number) => `${n > 0 ? "+" : ""}${n}`,
  className,
}: {
  value: number;
  goodWhen?: "up" | "down" | "neither";
  format?: (n: number) => string;
  className?: string;
}) {
  if (!Number.isFinite(value) || value === 0) {
    return <span className={cn("font-mono text-micro text-ink-faint tabular-nums", className)}>—</span>;
  }
  const up = value > 0;
  const good = goodWhen === "neither" ? null : goodWhen === "up" ? up : !up;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-mono text-micro tabular-nums",
        good === null ? "text-ink-muted" : good ? "text-pass" : "text-sev-high",
        className,
      )}
    >
      <span aria-hidden>{up ? "▲" : "▼"}</span>
      {format(value)}
    </span>
  );
}
