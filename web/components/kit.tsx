"use client";

/**
 * Product building blocks: the pieces that know what a repo, a symbol or a
 * receipt is. Everything visual here delegates to components/ds/* — this file
 * decides *meaning*, the design system decides *appearance*.
 *
 * The public surface is unchanged on purpose: all nine pages import from here,
 * so re-skinning the product is a change to ds/ plus this file, never to pages.
 * New screens should prefer the ds primitives directly (Panel, Slab, Grid) and
 * reach for these only when they need the product vocabulary.
 */

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Check, CircleAlert, Copy, Loader2, Receipt } from "@/components/icons";
import { Callout, Eyebrow, Kbd as DsKbd, Meter as DsMeter } from "@/components/ds/primitives";
import { Panel } from "@/components/ds/panel";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ApiError, Receipts as R } from "@/lib/api";
import { ms, symName } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The page container. A `<div>`, not a `<main>`: the shell already owns the
 * single `<main id="content">` landmark, and two would break screen-reader nav.
 */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[var(--page-max)] px-4 pt-6 pb-16 lg:px-6", className)}>{children}</div>
  );
}

export function PageHeader({
  title,
  sub,
  eyebrow,
  children,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** Short mono label above the title — names the question this page answers. */
  eyebrow?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-[var(--section-gap)] flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <Eyebrow className="mb-1.5 block">{eyebrow}</Eyebrow>}
        <h1 className="text-display leading-none">{title}</h1>
        {sub && <p className="mt-2 max-w-2xl text-body-sm text-ink-muted">{sub}</p>}
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** A titled data container. Thin wrapper over <Panel> so existing pages keep working. */
export function Tile({
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Panel title={title} action={action} className={cn("as-in", className)} bodyClassName={bodyClassName}>
      {children}
    </Panel>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <Eyebrow className="block">{label}</Eyebrow>
      {/* Barlow Condensed: a 6-digit count stays on one line at this size. */}
      <div className={cn("mt-1 font-display text-[1.75rem] leading-none text-ink-strong tabular-nums", tone)}>{value}</div>
      {hint && <div className="mt-1 truncate text-caption text-ink-muted">{hint}</div>}
    </div>
  );
}

export function ErrorNote({ error, className, onRetry }: { error: ApiError | Error | string; className?: string; onRetry?: () => void }) {
  const msg = typeof error === "string" ? error : error.message;
  return (
    <Callout
      role="alert"
      tone="fail"
      className={className}
      icon={<CircleAlert className="text-fail" aria-hidden />}
      action={
        onRetry && (
          <Button variant="outline" size="sm" className="h-7" onClick={onRetry}>
            Retry
          </Button>
        )
      }
    >
      <span className="break-words whitespace-pre-wrap">{msg}</span>
    </Callout>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="grid place-items-center rounded-panel border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && <div className="mb-3 text-ink-faint [&>svg]:size-6">{icon}</div>}
      <div className="text-body text-ink-strong">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-body-sm text-ink-muted">{children}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-body-sm text-ink-muted" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}…
    </div>
  );
}

/** What it cost to answer: the graph queries behind a result (every API response carries them). */
export function Receipts({ r, className }: { r?: R; className?: string }) {
  if (!r) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex items-center gap-1.5 font-mono text-micro text-ink-muted tabular-nums", className)} tabIndex={0}>
          <Receipt className="size-3.5" aria-hidden />
          {r.queries} {r.queries === 1 ? "query" : "queries"} · {ms(r.total_ms)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-caption">
        {r.queries} graph queries, {ms(r.graph_ms)} in FalkorDB, {ms(r.total_ms)} total
      </TooltipContent>
    </Tooltip>
  );
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("h-7 text-caption", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Clipboard blocked by the browser");
        }
      }}
    >
      {done ? <Check className="size-3.5 text-pass" /> : <Copy className="size-3.5" />} {done ? "Copied" : label}
    </Button>
  );
}

/** A symbol, linked to its detail page. `id` is the graph id (`path::qname`). */
export function SymLink({ repo, id, name, className }: { repo: string; id: string; name?: string; className?: string }) {
  return (
    <Link
      href={repoHref(repo, `/explore?ref=${encodeURIComponent(id)}`)}
      className={cn("font-mono text-ink-strong underline-offset-2 hover:text-brand hover:underline", className)}
    >
      {symName(name ?? id.slice(id.indexOf("::") + 2))}
    </Link>
  );
}

export function FileLink({ repo, path, line, className }: { repo: string; path: string; line?: number; className?: string }) {
  return (
    <Link
      href={repoHref(repo, `/explore?file=${encodeURIComponent(path)}`)}
      className={cn("font-mono text-ink-muted underline-offset-2 hover:text-brand hover:underline", className)}
    >
      {path}
      {line ? `:${line}` : ""}
    </Link>
  );
}

/** A thin horizontal meter (probability, confidence, share). */
export function Meter({ value, className, barClassName }: { value: number; className?: string; barClassName?: string }) {
  return <DsMeter value={value} className={className} barClassName={barClassName} />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <DsKbd>{children}</DsKbd>;
}
