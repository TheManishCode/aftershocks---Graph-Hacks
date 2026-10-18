"use client";

/**
 * The GROUNDTRUTH primitives. Every page is built from these and nothing else
 * decides appearance; the vocabulary that knows what a symbol or a receipt is
 * lives in kit.tsx.
 *
 *   Head      the page's title block on the void, with a bottom-anchored readout
 *   Sheet     a solid ruled section · its number, title, action, body
 *   Spec      the spec sheet · term / description / chartreuse figure
 *   Row       a ledger line · numbered, ruled, chartreuse when active
 *   Viewer    corner ticks + HUD around anything you look *at* (graphs, output)
 *   Sel       a selection box · eight handles and a coordinate tag
 *   Steps     a schedule whose rail fills as it progresses
 */

import * as React from "react";

import { CircleAlert, Copy, Check } from "@/components/icons";
import { Enter, Reveal, Scramble } from "@/components/motion";
import { toast } from "sonner";
import type { Level, Tier } from "@/lib/api";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- severity */

export type Severity = "none" | "low" | "medium" | "high" | "critical";
export const SEV_TEXT: Record<Severity, string> = {
  none: "text-ink-faint",
  low: "text-sev-low",
  medium: "text-sev-medium",
  high: "text-sev-high",
  critical: "text-sev-critical",
};
export const SEV_BG: Record<Severity, string> = {
  none: "bg-ink-faint",
  low: "bg-sev-low",
  medium: "bg-sev-medium",
  high: "bg-sev-high",
  critical: "bg-sev-critical",
};
export const fromLevel = (l?: Level): Severity => l ?? "none";
export const fromTier = (t?: Tier): Severity =>
  t === "definite" ? "critical" : t === "likely" ? "high" : t === "possible" ? "medium" : "none";

/* ------------------------------------------------------------------- page */

/** Page frame: clears the fixed bar, sets the measure. */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <main id="main" className={cn("mx-auto w-[var(--wrap)] pt-[calc(var(--nav)+clamp(28px,6vh,64px))] pb-24", className)}>
      {children}
    </main>
  );
}

export interface Readout {
  fig: React.ReactNode;
  label: string;
}

/**
 * The title block. Left: number, headline, lead. Right: the instrument readout,
 * bottom-anchored, figures in chartreuse — only real, sourced numbers go here.
 */
export function Head({
  no,
  title,
  lead,
  meta,
  children,
}: {
  no: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  meta?: Readout[];
  children?: React.ReactNode;
}) {
  return (
    <Reveal as="header" className="mb-[clamp(28px,5vh,52px)] grid items-end gap-6 md:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="gt-no mb-4">{no}</div>
        <h1 className="gt-h1">{title}</h1>
        {lead && <p className="gt-lead mt-3">{lead}</p>}
        {children && <div className="mt-5 flex flex-wrap items-center gap-3">{children}</div>}
      </div>
      {meta && meta.length > 0 && (
        <dl className="flex flex-row flex-wrap gap-x-8 gap-y-3 md:flex-col md:items-end md:text-right">
          {meta.map((m) => (
            <div key={m.label}>
              <dd className="m-0 font-mono text-[17px] leading-tight font-medium tracking-[.02em] text-mark">
                {typeof m.fig === "string" ? <Scramble value={m.fig} /> : m.fig}
              </dd>
              <dt className="mt-1 font-mono text-[10px] tracking-[.13em] text-ink-dim uppercase">{m.label}</dt>
            </div>
          ))}
        </dl>
      )}
    </Reveal>
  );
}

export type SheetTone = "capture" | "library" | "fragment" | "commission" | "void" | "mark" | "fail";

/** A ruled, solid section. Pass `flush` when the body draws its own padding (ledgers, tables). */
export function Sheet({
  no,
  title,
  note,
  action,
  tone = "capture",
  flush,
  className,
  bodyClassName,
  children,
  id,
  ...rest
}: {
  no?: string;
  title?: React.ReactNode;
  note?: React.ReactNode;
  action?: React.ReactNode;
  tone?: SheetTone;
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
  id?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, "title">) {
  const titled = no || title || action;
  return (
    <Reveal as="section" className={cn("min-w-0", className)}>
      <section id={id} data-tone={tone} className="gt-sheet min-w-0" {...rest}>
        {titled && (
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-[clamp(14px,2vw,24px)] pt-[clamp(14px,2vw,22px)]">
            <div className="min-w-0 flex-1">
              {no && <div className="gt-label mb-2">{no}</div>}
              {title && <h2 className="gt-h2">{title}</h2>}
              {note && <p className="mt-1.5 max-w-[70ch] text-[13px] leading-relaxed text-ink-dim">{note}</p>}
            </div>
            {action && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{action}</div>}
          </div>
        )}
        <div
          className={cn(
            flush ? "pt-3" : "px-[clamp(14px,2vw,24px)] pt-4 pb-[clamp(14px,2vw,22px)]",
            !titled && !flush && "pt-[clamp(14px,2vw,22px)]",
            bodyClassName,
          )}
        >
          {children}
        </div>
      </section>
    </Reveal>
  );
}

/** Two-column layouts used across pages. `main-aside` puts the wide column first. */
export function Cols({ kind = "main-aside", className, children }: { kind?: "main-aside" | "aside-main" | "halves" | "thirds"; className?: string; children: React.ReactNode }) {
  const cols = {
    "main-aside": "lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]",
    "aside-main": "lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]",
    halves: "lg:grid-cols-2",
    thirds: "md:grid-cols-2 xl:grid-cols-3",
  }[kind];
  return <div className={cn("grid min-w-0 gap-[clamp(14px,2vw,22px)]", cols, className)}>{children}</div>;
}

export function Stack({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex min-w-0 flex-col gap-[clamp(14px,2vw,22px)]", className)}>{children}</div>;
}

/* ------------------------------------------------------------- spec sheet */

export type SpecRow = [term: React.ReactNode, desc: React.ReactNode, fig?: React.ReactNode];

export function Spec({ rows, className }: { rows: SpecRow[]; className?: string }) {
  return (
    <Enter as="dl" className={cn("gt-spec", className)}>
      {rows.map(([t, d, n], i) => (
        <div key={i}>
          <dt>{t}</dt>
          <dd>{d}</dd>
          <dd className="n">{typeof n === "string" ? <Scramble value={n} /> : n}</dd>
        </div>
      ))}
    </Enter>
  );
}

/* ----------------------------------------------------------------- ledger */

/** Zero-padded ledger number: 1 → "01". */
export const no2 = (i: number) => String(i).padStart(2, "0");

/* ----------------------------------------------------------------- viewer */

export function Ticks() {
  return (
    <>
      <i className="gt-tick gt-tick--tl" aria-hidden />
      <i className="gt-tick gt-tick--tr" aria-hidden />
      <i className="gt-tick gt-tick--bl" aria-hidden />
      <i className="gt-tick gt-tick--br" aria-hidden />
    </>
  );
}

export function Viewer({
  hud,
  hint,
  children,
  className,
  style,
}: {
  hud?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={cn("gt-viewer", className)} style={style}>
      {children}
      <Ticks />
      {hud && <div className="gt-hud top-3 left-7 text-mark">{hud}</div>}
      {hint && <div className="gt-hud right-7 bottom-3 left-7 justify-between text-ink-faint">{hint}</div>}
    </div>
  );
}

/* --------------------------------------------------------- selection box */

const HANDLES: React.CSSProperties[] = [
  { left: -7, top: -7 },
  { left: "calc(50% - 3px)", top: -7 },
  { right: -7, top: -7 },
  { right: -7, top: "calc(50% - 3px)" },
  { right: -7, bottom: -7 },
  { left: "calc(50% - 3px)", bottom: -7 },
  { left: -7, bottom: -7 },
  { left: -7, top: "calc(50% - 3px)" },
];

/** Draws the GROUNDTRUTH selection box around its child: eight handles, one mono tag. */
export function Sel({ tag, on = true, className, children }: { tag?: string; on?: boolean; className?: string; children: React.ReactNode }) {
  if (!on) return <div className={className}>{children}</div>;
  return (
    <div className={cn("gt-sel", className)}>
      {children}
      {HANDLES.map((s, i) => (
        <span key={i} className="gt-h" style={s} aria-hidden />
      ))}
      {tag && (
        <span className="gt-tag" aria-hidden>
          {tag}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ steps */

export interface Step {
  key: string;
  title: React.ReactNode;
  body?: React.ReactNode;
  mark?: React.ReactNode;
  lit?: boolean;
  fail?: boolean;
}

/** A schedule. `fill` is 0..1 — how far the rail is lit. */
export function Steps({ steps, fill = 0, className, live }: { steps: Step[]; fill?: number; className?: string; live?: boolean }) {
  return (
    <ol
      className={cn("gt-steps", className)}
      style={{ "--fill": Math.max(0, Math.min(1, fill)) } as React.CSSProperties}
      aria-live={live ? "polite" : undefined}
    >
      {steps.map((s) => (
        <li key={s.key} data-lit={s.lit ? "true" : undefined} data-state={s.fail ? "fail" : undefined}>
          <b>{s.title}</b>
          <span className="text-[13px] leading-relaxed text-ink-dim">{s.body}</span>
          <i>{s.mark}</i>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------ small parts */

export type Tone = "neutral" | "mark" | "fail" | "pass" | "warn" | "info" | "hot";
const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink-dim",
  mark: "text-mark",
  fail: "text-fail",
  pass: "text-pass",
  warn: "text-warn",
  info: "text-info",
  hot: "text-hot",
};

export function Chip({ tone = "neutral", solid, className, children, title }: { tone?: Tone; solid?: boolean; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "gt-chip",
        solid ? (tone === "mark" ? "border-mark bg-mark text-on-mark" : tone === "fail" ? "border-fail bg-fail text-white" : "border-ink bg-ink text-deep") : TONE_TEXT[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Mono({ className, children, title }: { className?: string; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("font-mono", className)}>
      {children}
    </span>
  );
}

export function Label({ className, children, htmlFor }: { className?: string; children: React.ReactNode; htmlFor?: string }) {
  return htmlFor ? (
    <label htmlFor={htmlFor} className={cn("gt-label mb-2 block", className)}>
      {children}
    </label>
  ) : (
    <span className={cn("gt-label block", className)}>{children}</span>
  );
}

/** A hairline meter. 0..1. */
export function Meter({ value, className, barClassName, label }: { value: number; className?: string; barClassName?: string; label?: string }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div
      className={cn("h-[3px] w-full bg-line", className)}
      role={label ? "meter" : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 1 : undefined}
      aria-valuenow={label ? v : undefined}
    >
      <div className={cn("h-full", barClassName ?? "bg-mark")} style={{ width: `${Math.max(v > 0 ? 2 : 0, v * 100)}%` }} />
    </div>
  );
}

/** A big readout: figure over label. */
export function Figure({ label, value, tone, hint, className }: { label: string; value: React.ReactNode; tone?: string; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className={cn("font-mono text-[clamp(20px,2.2vw,28px)] leading-none font-medium tracking-tight tabular-nums", tone ?? "text-ink")}>
        {typeof value === "string" ? <Scramble value={value} /> : value}
      </div>
      <div className="gt-label mt-2">{label}</div>
      {hint && <div className="mt-1 text-[11.5px] text-ink-faint">{hint}</div>}
    </div>
  );
}

/** Segmented control: mono caps, the chosen one is the instrument's mark. */
export function Seg<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; title?: string }[];
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap border border-line-loud">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "font-mono tracking-[.1em] uppercase transition-colors",
              size === "sm" ? "px-2 py-1 text-[9.5px]" : "px-3 py-2 text-[10.5px]",
              on ? "bg-mark text-on-mark" : "text-ink-dim hover:bg-white/5 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Range({ label, value, onChange, min = 1, max = 8, format }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; format?: (n: number) => string }) {
  const id = React.useId();
  return (
    <div className="flex items-center gap-3">
      <label htmlFor={id} className="gt-label">
        {label}
      </label>
      <input id={id} type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="gt-range w-28" />
      <span className="gt-fig w-14">{format ? format(value) : value}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- states */

export function Measuring({ label = "Measuring", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("py-10", className)} role="status" aria-live="polite">
      <div className="gt-measuring h-[3px] w-full max-w-[420px]" />
      <div className="gt-label mt-3 text-ink-dim">
        {label}
        <span className="animate-blink">_</span>
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse bg-white/[0.05]", className)} aria-hidden />;
}

export function Empty({ title, children, action, className }: { title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <Viewer className={cn("px-[clamp(20px,4vw,48px)] py-[clamp(36px,7vh,72px)]", className)} hint={<span>NO DATA YET</span>}>
      <div className="max-w-[60ch]">
        <h3 className="gt-h2">{title}</h3>
        {children && <div className="mt-3 text-[14px] leading-relaxed text-ink-dim">{children}</div>}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </Viewer>
  );
}

export function ErrorNote({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className={cn("flex items-start gap-3 border border-fail/50 bg-fail/[0.07] px-4 py-3", className)}>
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-fail" aria-hidden />
      <div className="min-w-0 flex-1 text-[13.5px] break-words text-ink">{msg}</div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 font-mono text-[10.5px] tracking-[.12em] text-mark uppercase hover:underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function Callout({ tone = "neutral", title, children, className, icon }: { tone?: "neutral" | "warn" | "fail" | "mark" | "info"; title?: React.ReactNode; children: React.ReactNode; className?: string; icon?: React.ReactNode }) {
  const bar = { neutral: "border-line-loud", warn: "border-warn", fail: "border-fail", mark: "border-mark", info: "border-info" }[tone];
  const head = { neutral: "text-ink", warn: "text-warn", fail: "text-fail", mark: "text-mark", info: "text-info" }[tone];
  return (
    <div className={cn("border-l-2 bg-black/10 py-3 pr-4 pl-4", bar, className)}>
      <div className="flex items-start gap-2.5">
        {icon && <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", head)}>{icon}</span>}
        <div className="min-w-0 flex-1">
          {title && <div className={cn("mb-1 font-mono text-[10.5px] tracking-[.14em] uppercase", head)}>{title}</div>}
          <div className="text-[13.5px] leading-relaxed text-ink-dim">{children}</div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- code block */

export function CodeBlock({
  code,
  title,
  maxHeight = 360,
  wrap,
  diff,
  noCopy,
  className,
}: {
  code: string;
  title?: string;
  maxHeight?: number;
  wrap?: boolean;
  diff?: boolean;
  noCopy?: boolean;
  className?: string;
}) {
  const [done, setDone] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    } catch {
      toast.error("Clipboard blocked by the browser");
    }
  };
  return (
    <div className={cn("relative min-w-0 border border-line bg-deep", className)}>
      {(title || !noCopy) && (
        <div className="flex items-center gap-3 border-b border-line px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] tracking-[.12em] text-ink-faint uppercase">{title ?? ""}</span>
          {!noCopy && (
            <button type="button" onClick={copy} className="flex items-center gap-1 font-mono text-[10px] tracking-[.12em] text-ink-dim uppercase hover:text-mark" aria-label={`Copy ${title ?? "code"}`}>
              {done ? <Check className="size-3 text-mark" aria-hidden /> : <Copy className="size-3" aria-hidden />}
              {done ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      )}
      <pre
        className={cn("gt-scroll m-0 overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-ink", wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre")}
        style={{ maxHeight }}
        tabIndex={0}
      >
        {diff
          ? code.split("\n").map((l, i) => (
              <div
                key={i}
                className={cn(
                  l.startsWith("+") && !l.startsWith("+++") && "bg-pass/10 text-pass",
                  l.startsWith("-") && !l.startsWith("---") && "bg-fail/10 text-fail",
                  l.startsWith("@@") && "text-ink-faint",
                )}
              >
                {l || " "}
              </div>
            ))
          : code}
      </pre>
    </div>
  );
}

/* --------------------------------------------------------------- the gauge */

/**
 * Risk as a surveyor's scale: a ruled 0–100 track, a needle at the score, the
 * level named in words. Colour carries the level too, never alone.
 */
export function RiskGauge({ score, level, className }: { score: number; level: Severity; className?: string }) {
  const s = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-end justify-between gap-4">
        <div className={cn("font-mono text-[clamp(44px,6vw,64px)] leading-[.9] font-medium tracking-tight tabular-nums", SEV_TEXT[level])}>
          <Scramble value={String(s)} />
        </div>
        <div className="text-right">
          <div className={cn("font-mono text-[12px] tracking-[.18em] uppercase", SEV_TEXT[level])}>{level}</div>
          <div className="gt-label mt-1">risk / 100</div>
        </div>
      </div>
      <div className="relative mt-4 h-6" aria-hidden>
        <div className="absolute inset-x-0 top-3 h-px bg-line-loud" />
        {Array.from({ length: 21 }, (_, i) => (
          <span key={i} className="absolute top-1.5 w-px bg-line-loud" style={{ left: `${i * 5}%`, height: i % 5 === 0 ? 12 : 6, top: i % 5 === 0 ? 6 : 9 }} />
        ))}
        <span className={cn("absolute top-0 h-6 w-[2px]", SEV_BG[level])} style={{ left: `calc(${s}% - 1px)` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] tracking-[.14em] text-ink-faint" aria-hidden>
        <span>0</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>100</span>
      </div>
    </div>
  );
}
