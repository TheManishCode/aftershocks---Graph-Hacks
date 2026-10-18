/**
 * Page furniture — the frame every screen sits in.
 *
 * These live in the design system rather than in the product layer because they
 * know nothing about repos, symbols or receipts: they are a column, a title, an
 * empty state and a failure state. The product layer composes them.
 *
 * `Page` is a `<div>`, not a `<main>`: the shell already owns the single
 * `<main id="content">` landmark and two would break screen-reader navigation.
 */

import * as React from "react";

import { CircleAlert, Loader2 } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Callout, Eyebrow } from "./primitives";

export function Page({ className, children, ...rest }: React.ComponentProps<"div">) {
  return (
    <div className={cn("mx-auto w-full max-w-[var(--page-max)] px-4 pt-6 pb-16 lg:px-6", className)} {...rest}>
      {children}
    </div>
  );
}

export interface PageHeaderProps extends Omit<React.ComponentProps<"div">, "title"> {
  title: React.ReactNode;
  /** One sentence. What question this page answers — not what it contains. */
  sub?: React.ReactNode;
  /** Short mono label above the title. */
  eyebrow?: React.ReactNode;
  /** Right-aligned actions. */
  children?: React.ReactNode;
}

export function PageHeader({ title, sub, eyebrow, children, className, ...rest }: PageHeaderProps) {
  return (
    <div className={cn("mb-[var(--section-gap)] flex flex-wrap items-end gap-x-6 gap-y-3", className)} {...rest}>
      <div className="min-w-0">
        {eyebrow && <Eyebrow className="mb-1.5 block">{eyebrow}</Eyebrow>}
        <h1 className="text-display leading-none">{title}</h1>
        {sub && <p className="mt-2 max-w-2xl text-body-sm text-ink-muted">{sub}</p>}
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/**
 * The empty state. Always says what to do next — an empty box that only says
 * "no data" has wasted the one moment the reader was looking for guidance.
 */
export function Empty({
  title,
  icon,
  action,
  children,
  className,
  ...rest
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn("grid place-items-center rounded-panel border border-dashed border-line-strong px-6 py-12 text-center", className)}
      {...rest}
    >
      {icon && <div className="mb-3 text-ink-faint [&>svg]:size-6">{icon}</div>}
      <div className="text-body text-ink-strong">{title}</div>
      {children && <div className="mt-1.5 max-w-prose text-body-sm text-ink-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-body-sm text-ink-muted", className)} role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}…
    </div>
  );
}

/**
 * A failed request, shown in place. The message is rendered verbatim: the API's
 * wording is more useful than anything this component could invent, and a
 * swallowed detail is a support ticket.
 */
export function ErrorNote({
  error,
  onRetry,
  className,
}: {
  error: Error | string;
  onRetry?: () => void;
  className?: string;
}) {
  const msg = typeof error === "string" ? error : error.message;
  return (
    <Callout
      role="alert"
      tone="fail"
      className={className}
      icon={<CircleAlert className="text-fail" aria-hidden />}
      action={
        onRetry && (
          <button
            type="button"
            data-hit
            onClick={onRetry}
            className="rounded-control border border-line px-2 py-1 font-mono text-micro uppercase text-ink-muted transition-colors duration-[var(--dur-fast)] hover:border-line-loud hover:text-ink-strong"
          >
            Retry
          </button>
        )
      }
    >
      <span className="break-words whitespace-pre-wrap">{msg}</span>
    </Callout>
  );
}
