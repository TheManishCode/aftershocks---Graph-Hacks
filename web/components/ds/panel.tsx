/**
 * Panels — the containers every screen is built from.
 *
 * There are exactly three container shapes in the product, and this file owns
 * all of them. A new page composes these; it never invents a box.
 *
 *   <Panel>   data. 24px radius, #27272A hairline, a labelled mono header rail.
 *             The default. Dense, nestable, scroll-safe.
 *   <Bento>   a navigation card. Same radius and border language as Panel — the
 *             guardrails require one radius across buttons, cards and badges —
 *             but it lifts on hover, because it is "choose where to go" rather
 *             than "read this". Lift is the only thing that distinguishes them,
 *             and that is deliberate: the difference is behavioural, not visual.
 *   <Slab>    a titled band that groups panels and sets the 80px section rhythm.
 *
 * DEPTH IS MATERIAL, NOT SHADOW. On a pure-black ground a drop shadow has
 * nothing to fall on; it just greys the area around the box. A nested panel
 * steps one rung up the surface ladder (`tone="raised"`) and keeps its
 * hairline. The single exception is `tone="focal"`, the inverted #E5E5E5
 * surface, which is lifted off the page precisely because it is meant to be
 * the one object the eye lands on first.
 *
 * ONE FOCAL PANEL PER VIEWPORT. Two inverted surfaces competing is the fastest
 * way to destroy the "first viewport signal" the brief asks to preserve.
 */

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";
import { Eyebrow } from "./primitives";

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

const panel = cva("flex min-w-0 flex-col rounded-card border", {
  variants: {
    tone: {
      /** On the page ground. The default. */
      default: "border-line bg-base",
      /** Inside another panel — one rung up the ladder. */
      raised: "border-line-strong bg-surface-raised",
      /** For inputs and read-only output wells: recessed into the black. */
      recessed: "border-line bg-ground",
      /**
       * The inverted focal surface. Carries black ink, so every child inheriting
       * `currentColor` flips with it; use `text-invert-ink-muted` for metadata
       * inside one rather than `text-ink-muted`, which is tuned for black.
       */
      focal: "border-transparent bg-invert text-invert-ink shadow-[var(--shadow-focal)]",
      /**
       * Attention without a hue: a louder border on a lifted surface. This is
       * what `tone="brand"` used to be, renamed because the chrome is no longer
       * a colour and a token called "brand" would now be lying about what it
       * draws. Use it where something matters but has no severity.
       */
      emphasis: "border-line-loud bg-surface-raised",
      /** No chrome — for grouping only. */
      bare: "border-transparent bg-transparent",
    },
    interactive: { true: "transition-colors duration-[var(--dur-fast)] hover:border-line-loud", false: "" },
  },
  defaultVariants: { tone: "default", interactive: false },
});

export interface PanelProps extends Omit<React.ComponentProps<"section">, "title">, VariantProps<typeof panel> {
  /** Short, uppercase. Names the region; omit for an unlabelled container. */
  title?: React.ReactNode;
  /** Right-aligned header content: counts, filters, a toolbar. */
  action?: React.ReactNode;
  /** Secondary line under the title, inside the header. */
  note?: React.ReactNode;
  /** Replaces the padded body wrapper — use for tables and canvases. */
  flush?: boolean;
  bodyClassName?: string;
}

export function Panel({
  title,
  action,
  note,
  flush,
  children,
  className,
  bodyClassName,
  tone,
  interactive,
  ...rest
}: PanelProps) {
  // A <section> is only a landmark once it has an accessible name; an unnamed one
  // is noise in a screen reader's region list. Titled panels name themselves from
  // their own header, so "Run", "Test libraries" and "Recent runs" become real
  // navigable regions instead of three anonymous boxes.
  const titleId = React.useId();
  const focal = tone === "focal";
  return (
    <section
      className={cn(panel({ tone, interactive }), className)}
      {...(title && !rest["aria-label"] && !rest["aria-labelledby"] ? { "aria-labelledby": titleId } : {})}
      {...rest}
    >
      {(title || action) && (
        <header
          className={cn(
            "flex min-h-[var(--panel-head-h)] flex-wrap items-center gap-x-4 gap-y-1 border-b px-[var(--panel-pad-x)] py-2.5",
            focal ? "border-invert-ink/12" : "border-line",
          )}
        >
          <div className="min-w-0">
            {title && (
              <Eyebrow id={titleId} className={cn("block truncate", focal && "text-invert-ink/70")}>
                {title}
              </Eyebrow>
            )}
            {note && (
              <span
                className={cn(
                  "mt-1 block truncate text-caption normal-case",
                  focal ? "text-invert-ink-muted" : "text-ink-muted",
                )}
              >
                {note}
              </span>
            )}
          </div>
          {action && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      {flush ? (
        children
      ) : (
        <div className={cn("min-h-0 flex-1 p-[var(--panel-pad-x)]", bodyClassName)}>{children}</div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Bento — the navigational card.                                              */
/* -------------------------------------------------------------------------- */

export function Bento({
  className,
  children,
  as: As = "div",
  ...rest
}: Omit<React.ComponentProps<"div">, "ref"> & { as?: React.ElementType; [key: string]: unknown }) {
  return (
    <As
      className={cn(
        "group as-lift relative isolate flex flex-col overflow-hidden rounded-card border border-line bg-base",
        "p-[var(--space-card)] hover:border-line-loud hover:bg-surface",
        "focus-visible:-translate-y-[3px] focus-visible:border-line-loud",
        className,
      )}
      {...rest}
    >
      {/* A light wash arriving from the top-left on hover. Achromatic, because
          colour in this product means severity and a nav card has no severity. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-[var(--dur-slow)] group-hover:opacity-100"
        style={{ background: "radial-gradient(130% 110% at 0% 0%, rgb(255 255 255 / 9%), transparent 62%)" }}
      />
      {children}
    </As>
  );
}

/* -------------------------------------------------------------------------- */
/* Slab — a titled section band. Groups panels and gives the page its rhythm.  */
/* -------------------------------------------------------------------------- */

export function Slab({
  title,
  description,
  action,
  children,
  className,
  ...rest
}: Omit<React.ComponentProps<"section">, "title"> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className={cn("min-w-0", className)} {...rest}>
      {(title || action) && (
        <div className="mb-[var(--space-card)] flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="min-w-0">
            {title && <h2 className="font-display text-subheading leading-none">{title}</h2>}
            {description && <p className="mt-2.5 max-w-[68ch] text-body-sm text-ink-muted">{description}</p>}
          </div>
          {action && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Toolbar — the control strip that sits above or inside a panel.              */
/* -------------------------------------------------------------------------- */

export function Toolbar({ className, children, ...rest }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-card border border-line bg-base px-4 py-2.5",
        className,
      )}
      role="toolbar"
      {...rest}
    >
      {children}
    </div>
  );
}

/** A vertical hairline between toolbar groups. */
export function ToolbarSep({ className }: { className?: string }) {
  return <span className={cn("mx-1 h-5 w-px shrink-0 bg-line", className)} aria-hidden />;
}

/* -------------------------------------------------------------------------- */
/* Grid — the layout primitive. Named spans so pages do not hand-roll columns. */
/* -------------------------------------------------------------------------- */

const GRID_COLS: Record<string, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 md:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
  /** The asymmetric work/context split used by Impact, Path and Culprit. */
  "main-aside": "grid-cols-1 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]",
  "aside-main": "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]",
  /** The dashboard split the source uses: a wide focal object beside a rail. */
  "matrix-rail": "grid-cols-1 xl:grid-cols-[minmax(0,2.1fr)_minmax(0,1fr)]",
};

export function Grid({
  cols = 2,
  className,
  children,
  ...rest
}: React.ComponentProps<"div"> & { cols?: keyof typeof GRID_COLS | 1 | 2 | 3 | 4 | 5 | 6 }) {
  return (
    <div className={cn("grid gap-[var(--stack-gap)]", GRID_COLS[String(cols)] ?? GRID_COLS["2"], className)} {...rest}>
      {children}
    </div>
  );
}

/** Vertical rhythm between sections. The only approved vertical gap. */
export function Stack({ className, children, ...rest }: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-[var(--stack-gap)]", className)} {...rest}>
      {children}
    </div>
  );
}
