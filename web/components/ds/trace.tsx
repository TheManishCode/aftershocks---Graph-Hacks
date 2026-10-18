"use client";

/**
 * Trace — the agent's work, shown as a vertical rail of steps.
 *
 * This is the product's most important component. Aftershock's claim is that it
 * answers with evidence rather than vibes, and the trace is where that claim is
 * either honoured or not: every graph query the agent ran, what it passed, what
 * came back, and what it cost. A step that cannot say what it did is a step the
 * reader cannot check.
 *
 * Three rules it enforces so pages cannot drift:
 *
 *  1. A step is collapsed by default and shows its summary on one line. The
 *     reader scans the shape of the reasoning first and opens only what they
 *     doubt. An agent that ran eleven queries must not cost eleven screens.
 *  2. Status is a shape *and* a colour — a filled disc, a ring, a cross — so the
 *     trace survives greyscale and colour-blindness.
 *  3. Receipts render in the step's own footer, never in a tooltip. A number you
 *     have to hover for is a number nobody reads.
 *
 * Status colours come from `pass`/`fail`/`warn`, not the severity ramp: a failed
 * tool call is not a "critical risk", and spending the thermal ramp on it would
 * dilute the one place that ramp means impact.
 */

import * as React from "react";

import { Check, ChevronRight, CircleAlert, Loader2 } from "@/components/icons";
import type { Receipts } from "@/lib/api";
import { ms } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Mono } from "./primitives";

export type TraceStatus = "pending" | "running" | "done" | "error" | "skipped";

/* -------------------------------------------------------------------------- */
/* Trace — the container. Draws the rail the steps hang from.                  */
/* -------------------------------------------------------------------------- */

export function Trace({ className, children, ...rest }: React.ComponentProps<"ol">) {
  return (
    <ol
      className={cn(
        // The rail: a hairline behind the icon column, inset so it starts and
        // ends inside the first and last disc rather than dangling past them.
        "relative flex flex-col",
        "before:absolute before:inset-y-3 before:left-[11px] before:w-px before:bg-line before:content-['']",
        className,
      )}
      {...rest}
    >
      {children}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* TraceIcon — the status disc. Sits on the rail and hides it behind itself.   */
/* -------------------------------------------------------------------------- */

const STATUS_RING: Record<TraceStatus, string> = {
  pending: "border-line-strong text-ink-faint",
  running: "border-brand/50 text-brand",
  done: "border-line-strong text-ink-muted",
  error: "border-fail/50 text-fail",
  skipped: "border-line text-ink-faint",
};

export function TraceIcon({
  status = "done",
  icon,
  className,
}: {
  status?: TraceStatus;
  /** Overrides the status glyph — pass a tool's own icon for a recognisable trace. */
  icon?: React.ReactNode;
  className?: string;
}) {
  const glyph =
    icon ??
    (status === "running" ? (
      <Loader2 className="size-3 animate-spin" />
    ) : status === "error" ? (
      <CircleAlert className="size-3" />
    ) : status === "done" ? (
      <Check className="size-3" />
    ) : (
      <span className="size-1.5 rounded-full bg-current" />
    ));
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 grid size-[23px] shrink-0 place-items-center rounded-full border bg-base",
        "[&>svg]:size-3.5",
        STATUS_RING[status],
        className,
      )}
    >
      {glyph}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* TraceTitle — the one-line description of what the step did.                 */
/* -------------------------------------------------------------------------- */

export function TraceTitle({ className, children, ...rest }: React.ComponentProps<"span">) {
  return (
    <span className={cn("min-w-0 truncate font-mono text-body-sm text-ink-strong", className)} {...rest}>
      {children}
    </span>
  );
}

/** The quiet continuation after the title: what came back, in words. */
export function TraceSummary({ className, children, ...rest }: React.ComponentProps<"span">) {
  return (
    <span className={cn("min-w-0 truncate text-body-sm text-ink-muted", className)} {...rest}>
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* TraceReceipts — the cost of a step. The evidence that it really ran.        */
/* -------------------------------------------------------------------------- */

export function TraceReceipts({ receipts, className }: { receipts?: Receipts | null; className?: string }) {
  if (!receipts) return null;
  const { queries, graph_ms, total_ms } = receipts;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-micro text-ink-faint", className)}>
      <span>
        <Mono className="text-ink-muted">{queries}</Mono> {queries === 1 ? "query" : "queries"}
      </span>
      <span>
        graph <Mono className="text-ink-muted">{ms(graph_ms)}</Mono>
      </span>
      <span>
        total <Mono className="text-ink-muted">{ms(total_ms)}</Mono>
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* TraceLine — one step.                                                       */
/* -------------------------------------------------------------------------- */

export interface TraceLineProps extends Omit<React.ComponentProps<"li">, "title" | "onToggle"> {
  status?: TraceStatus;
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** The one-line result, shown next to the title while collapsed. */
  summary?: React.ReactNode;
  /** Right-aligned metadata: a duration, a count, a chip. */
  meta?: React.ReactNode;
  receipts?: Receipts | null;
  /** The expanded body. When present the row becomes a disclosure button. */
  children?: React.ReactNode;
  defaultOpen?: boolean;
  /** Controlled disclosure. Pass with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function TraceLine({
  status = "done",
  icon,
  title,
  summary,
  meta,
  receipts,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className,
  ...rest
}: TraceLineProps) {
  const [self, setSelf] = React.useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : self;
  const collapsible = Boolean(children);
  const toggle = () => {
    if (!collapsible) return;
    if (!controlled) setSelf((v) => !v);
    onOpenChange?.(!open);
  };

  const id = React.useId();
  const Row = collapsible ? "button" : "div";

  return (
    <li className={cn("relative", className)} {...rest}>
      <Row
        {...(collapsible
          ? { type: "button" as const, onClick: toggle, "aria-expanded": open, "aria-controls": `${id}-body`, "data-hit": true }
          : {})}
        className={cn(
          "flex w-full items-center gap-2.5 py-1.5 text-left",
          collapsible && "group rounded-control transition-colors duration-[var(--dur-fast)] hover:bg-accent/60",
        )}
      >
        <TraceIcon status={status} icon={icon} />
        <TraceTitle>{title}</TraceTitle>
        {summary && <TraceSummary>{summary}</TraceSummary>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {meta}
          {collapsible && (
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 text-ink-faint transition-transform duration-[var(--dur-fast)]",
                "group-hover:text-ink-muted",
                open && "rotate-90",
              )}
            />
          )}
        </span>
      </Row>

      {collapsible && open && (
        <div id={`${id}-body`} className="ml-[11px] border-l border-line pb-2 pl-[15px]">
          <div className="flex flex-col gap-2 pt-0.5">
            {children}
            <TraceReceipts receipts={receipts} />
          </div>
        </div>
      )}
      {/* A step with receipts but no body still has to show what it cost. */}
      {!collapsible && receipts && <TraceReceipts receipts={receipts} className="ml-[34px] pb-1.5" />}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* TraceCollapsible — the whole trace, folded behind a count.                  */
/*                                                                            */
/* An answer is the thing the reader wants; the trace is the thing they want   */
/* when they doubt the answer. This wrapper keeps the second from burying the  */
/* first, while making it one click away and never hiding a failure.           */
/* -------------------------------------------------------------------------- */

export function TraceCollapsible({
  steps,
  defaultOpen,
  label,
  className,
  children,
}: {
  /** Step count, for the collapsed label. */
  steps: number;
  defaultOpen?: boolean;
  label?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen ?? false);
  const id = React.useId();
  if (!steps) return null;
  return (
    <div className={cn("rounded-nested border border-line bg-base", className)}>
      <button
        type="button"
        data-hit
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className={cn(
          "group flex w-full items-center gap-2 rounded-nested px-2.5 py-2 text-left",
          "transition-colors duration-[var(--dur-fast)] hover:bg-accent/60",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3.5 shrink-0 text-ink-faint transition-transform duration-[var(--dur-fast)]", open && "rotate-90")}
        />
        <span className="font-mono text-micro uppercase text-ink-muted group-hover:text-ink">
          {label ?? (
            <>
              {steps} {steps === 1 ? "step" : "steps"}
            </>
          )}
        </span>
      </button>
      {open && (
        <div id={id} className="border-t border-line px-2.5 py-1.5">
          {children}
        </div>
      )}
    </div>
  );
}
