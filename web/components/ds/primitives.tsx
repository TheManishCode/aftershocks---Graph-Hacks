/**
 * Design-system primitives: the small, unopinionated pieces every screen uses.
 *
 * These are deliberately dumb — no data fetching, no routing, no product
 * vocabulary. Anything that knows what a "symbol" or a "repo" is belongs in
 * components/kit.tsx, which composes these.
 *
 * Every primitive: forwards `className`, spreads the rest onto its root element,
 * and sizes itself from the density tokens rather than hard-coded padding.
 */

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Eyebrow — the mono label rail (Zenith-X / Apex). Names a region in one word. */
/* -------------------------------------------------------------------------- */

export function Eyebrow({
  children,
  className,
  tone = "muted",
  ...rest
}: React.ComponentProps<"span"> & { tone?: "muted" | "brand" | "strong" }) {
  return (
    <span
      className={cn(
        "font-mono text-micro uppercase",
        tone === "muted" && "text-ink-muted",
        tone === "brand" && "text-brand",
        tone === "strong" && "text-ink-strong",
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Chip — a compact, non-interactive status/metadata token.                    */
/* -------------------------------------------------------------------------- */

const chip = cva(
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-micro whitespace-nowrap uppercase",
  {
    variants: {
      tone: {
        neutral: "border-line-strong bg-surface text-ink-muted",
        brand: "border-brand/35 bg-brand/10 text-brand",
        pass: "border-pass/35 bg-pass/10 text-pass",
        warn: "border-warn/35 bg-warn/10 text-warn",
        fail: "border-fail/35 bg-fail/10 text-fail",
        info: "border-info/35 bg-info/10 text-info",
        /** For the severity ramp, prefer <SeverityChip>, which picks the tone. */
        bare: "border-transparent bg-transparent px-0 text-ink-muted",
      },
      size: { sm: "text-[10px] leading-4", md: "text-micro" },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export interface ChipProps extends React.ComponentProps<"span">, VariantProps<typeof chip> {
  /** A leading dot in the chip's own colour — reads as a status light. */
  dot?: boolean;
}

export function Chip({ className, tone, size, dot, children, ...rest }: ChipProps) {
  return (
    <span className={cn(chip({ tone, size }), className)} {...rest}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Mono — code, ids, paths. Keeps tabular figures and the slashed zero on.     */
/* -------------------------------------------------------------------------- */

export function Mono({ className, children, ...rest }: React.ComponentProps<"span">) {
  return (
    <span className={cn("font-mono tabular-nums", className)} {...rest}>
      {children}
    </span>
  );
}

/** An inline code token with a surface behind it. */
export function Code({ className, children, ...rest }: React.ComponentProps<"code">) {
  return (
    <code
      className={cn("rounded-sm border border-line bg-surface px-1 py-px font-mono text-[0.92em] text-ink-strong", className)}
      {...rest}
    >
      {children}
    </code>
  );
}

export function Kbd({ className, children, ...rest }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-sm border border-line bg-surface-raised px-1 font-mono text-[10px] text-ink-muted",
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}

/* -------------------------------------------------------------------------- */
/* Meter — a thin horizontal bar. The one way to draw a 0..1 proportion.       */
/* -------------------------------------------------------------------------- */

export interface MeterProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** 0..1. Clamped. */
  value: number;
  barClassName?: string;
  /** Renders a track tick at this fraction, for a target or threshold. */
  marker?: number;
  /** Accessible description; when omitted the meter is decorative. */
  label?: string;
}

export function Meter({ value, className, barClassName, marker, label, ...rest }: MeterProps) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const a11y = label
    ? { role: "meter" as const, "aria-valuenow": Math.round(v * 100), "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": label }
    : { "aria-hidden": true };
  return (
    <div className={cn("relative h-1 w-full overflow-hidden rounded-full bg-line-strong", className)} {...a11y} {...rest}>
      <div
        className={cn("h-full rounded-full bg-ink transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out-quint)]", barClassName)}
        style={{ width: `${Math.max(v > 0 ? 2 : 0, v * 100)}%` }}
      />
      {marker !== undefined && (
        <span className="absolute inset-y-0 w-px bg-ink-strong/60" style={{ left: `${Math.max(0, Math.min(100, marker * 100))}%` }} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Distribution — a stacked proportion bar. For edge mixes, tiers, languages.  */
/* -------------------------------------------------------------------------- */

export function Distribution({
  parts,
  className,
  height = "h-1.5",
  ...rest
}: Omit<React.ComponentProps<"div">, "children"> & {
  parts: { key: string; value: number; className: string; label?: string }[];
  height?: string;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className={cn("flex w-full overflow-hidden rounded-full bg-line-strong", height, className)} {...rest}>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <span
            key={p.key}
            className={cn("h-full first:rounded-l-full last:rounded-r-full", p.className)}
            style={{ width: `${(p.value / total) * 100}%` }}
            title={p.label ?? p.key}
          />
        ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sparkline — a dependency-free inline trend. SVG, scales to its container.   */
/* -------------------------------------------------------------------------- */

export function Sparkline({
  points,
  className,
  strokeClassName = "stroke-brand",
  area = true,
  ...rest
}: Omit<React.ComponentProps<"svg">, "points" | "fill"> & { points: number[]; strokeClassName?: string; area?: boolean }) {
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = 100 / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(28 - ((p - min) / span) * 26).toFixed(2)}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-7 w-full", className)} aria-hidden {...rest}>
      {area && <path d={`${d} L100,30 L0,30 Z`} className={cn("fill-current opacity-10", strokeClassName.replace("stroke-", "text-"))} />}
      <path d={d} fill="none" strokeWidth={1.25} vectorEffect="non-scaling-stroke" className={strokeClassName} />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Segmented — the inline mode switch. Replaces tab bars for 2–4 short options.*/
/* -------------------------------------------------------------------------- */

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: React.ReactNode; title?: string }[];
  className?: string;
  /** Accessible group name. */
  label: string;
  size?: "sm" | "md";
}

export function Segmented<T extends string>({ value, onChange, options, className, label, size = "md" }: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex items-center gap-0.5 rounded-control border border-line bg-surface p-0.5", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            data-hit
            className={cn(
              "rounded-[6px] font-mono text-micro whitespace-nowrap uppercase transition-colors duration-[var(--dur-fast)]",
              size === "sm" ? "px-2 py-1" : "px-2.5 py-1.5",
              active ? "bg-brand-solid text-white" : "text-ink-muted hover:bg-accent hover:text-ink-strong",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton — the loading placeholder. Always matches the real element's box.  */
/* -------------------------------------------------------------------------- */

export function Skeleton({ className, ...rest }: React.ComponentProps<"div">) {
  return <div className={cn("relative overflow-hidden rounded-[6px] bg-surface-raised as-sweep", className)} aria-hidden {...rest} />;
}

/** A skeleton shaped like n table rows, so loading does not reflow the layout. */
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-[var(--row-h)]" style={{ opacity: 1 - i * (0.6 / rows) }} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Callout — an inline note. The only way to render an advisory block.          */
/* -------------------------------------------------------------------------- */

const callout = cva("flex items-start gap-2.5 rounded-panel border px-3 py-2.5 text-body-sm", {
  variants: {
    tone: {
      neutral: "border-line bg-surface text-ink",
      brand: "border-brand/30 bg-brand/[0.07] text-ink",
      info: "border-info/30 bg-info/[0.07] text-ink",
      warn: "border-warn/30 bg-warn/[0.07] text-ink",
      fail: "border-fail/30 bg-fail/[0.07] text-ink",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Callout({
  className,
  tone,
  icon,
  children,
  action,
  ...rest
}: React.ComponentProps<"div"> & VariantProps<typeof callout> & { icon?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cn(callout({ tone }), className)} {...rest}>
      {icon && <span className="mt-px shrink-0 [&>svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Divider — a labelled or plain hairline.                                     */
/* -------------------------------------------------------------------------- */

export function Divider({ label, className, ...rest }: React.ComponentProps<"div"> & { label?: React.ReactNode }) {
  if (!label) return <div className={cn("h-px w-full bg-line", className)} role="separator" {...rest} />;
  return (
    <div className={cn("flex items-center gap-3", className)} role="separator" {...rest}>
      <span className="h-px flex-1 bg-line" />
      <Eyebrow>{label}</Eyebrow>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Range — a small labelled slider with its value shown next to it.            */
/* -------------------------------------------------------------------------- */

export interface RangeProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Visible text before the track. Doubles as the accessible name. */
  label: string;
  /** How the number reads aloud, e.g. `(n) => \`${n} hops\``. */
  format?: (value: number) => string;
  className?: string;
}

/**
 * The label is a real `<label>` wrapping the input rather than a `title`, so the
 * control is named the same way for a screen reader as it is on screen, and the
 * text is a second hit target for the slider.
 */
export function Range({ value, onChange, min = 1, max = 6, step = 1, label, format, className }: RangeProps) {
  return (
    <label className={cn("flex items-center gap-2 text-caption text-ink-muted", className)}>
      {label}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={format?.(value)}
        className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-line accent-[var(--color-brand)]"
      />
      <Mono className="w-4 text-ink-strong tabular-nums">{value}</Mono>
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Scroller — a bounded scroll region that fades its overflowing edge.         */
/* Used instead of raw `overflow-y-auto` so long lists signal there is more.   */
/* -------------------------------------------------------------------------- */

export function Scroller({ className, children, ...rest }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("min-h-0 overflow-y-auto overscroll-contain", className)}
      style={{
        maskImage: "linear-gradient(to bottom, transparent 0, #000 10px, #000 calc(100% - 14px), transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 0, #000 10px, #000 calc(100% - 14px), transparent 100%)",
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
