/**
 * Panels — the containers every screen is built from.
 *
 * There are exactly three container shapes in the product, and this file owns
 * all of them. A new page composes these; it never invents a box.
 *
 *   <Panel>   data. 10px radius, hairline border, a labelled header rail.
 *             The default. Dense, nestable, scroll-safe.
 *   <Bento>   feature / navigation card. 18px radius, hover lift, for the small
 *             number of places that are "choose where to go", not "read this".
 *   <Slab>    a full-bleed band used to group panels into a titled section.
 *
 * Depth is material, not shadow: a nested panel steps one rung up the surface
 * ladder (`tone="raised"`) and gains a 1px top highlight. This is the
 * Skeuomorphic Interface rule, and it keeps nested data legible on OLED.
 */

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";
import { Eyebrow } from "./primitives";

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

const panel = cva("flex min-w-0 flex-col rounded-panel border", {
  variants: {
    tone: {
      /** On the page ground. The default. */
      default: "border-line bg-base",
      /** Inside another panel — one rung up the ladder, lit from above. */
      raised: "border-line-strong bg-surface-raised shadow-[var(--shadow-inset-top)]",
      /** For inputs and read-only output wells. */
      recessed: "border-line bg-ground/60",
      /** Draws attention without using a severity colour. */
      brand: "border-brand/30 bg-brand/[0.045]",
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

export function Panel({ title, action, note, flush, children, className, bodyClassName, tone, interactive, ...rest }: PanelProps) {
  return (
    <section className={cn(panel({ tone, interactive }), className)} {...rest}>
      {(title || action) && (
        <header className="flex min-h-[var(--panel-head-h)] flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-[var(--panel-pad-x)] py-1.5">
          <div className="min-w-0">
            {title && <Eyebrow className="block truncate">{title}</Eyebrow>}
            {note && <span className="mt-0.5 block truncate text-caption text-ink-muted normal-case">{note}</span>}
          </div>
          {action && <div className="ml-auto flex shrink-0 items-center gap-1.5">{action}</div>}
        </header>
      )}
      {flush ? children : <div className={cn("min-h-0 flex-1 p-[var(--panel-pad-x)]", bodyClassName)}>{children}</div>}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Bento — the navigational / feature card (Cognitive Processing Hub).         */
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
        "group relative isolate flex flex-col overflow-hidden rounded-bento border border-line bg-base p-5",
        "transition-[border-color,background-color,transform] duration-[var(--dur-base)] ease-[var(--ease-out-quint)]",
        "hover:-translate-y-0.5 hover:border-brand/40 hover:bg-surface",
        "focus-visible:-translate-y-0.5 focus-visible:border-brand/40",
        className,
      )}
      {...rest}
    >
      {/* A soft brand wash that arrives on hover — the Cognitive Hub's ambient layer. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-[var(--dur-slow)] group-hover:opacity-100"
        style={{ background: "radial-gradient(120% 100% at 0% 0%, rgb(124 92 255 / 12%), transparent 60%)" }}
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
        <div className="mb-3 flex flex-wrap items-end gap-x-4 gap-y-1">
          <div className="min-w-0">
            {title && <h2 className="text-subheading leading-none">{title}</h2>}
            {description && <p className="mt-1.5 max-w-prose text-body-sm text-ink-muted">{description}</p>}
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
      className={cn("flex flex-wrap items-center gap-2 rounded-panel border border-line bg-base px-3 py-2", className)}
      role="toolbar"
      {...rest}
    >
      {children}
    </div>
  );
}

/** A vertical hairline between toolbar groups. */
export function ToolbarSep({ className }: { className?: string }) {
  return <span className={cn("mx-0.5 h-5 w-px shrink-0 bg-line", className)} aria-hidden />;
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
