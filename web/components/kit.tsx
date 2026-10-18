"use client";

/** Small building blocks every page shares: page header, tiles, stats, states, receipts, symbol links. */

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Check, CircleAlert, Copy, Loader2, Receipt } from "@/components/icons";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ApiError, Receipts as R } from "@/lib/api";
import { ms, symName } from "@/lib/format";
import { cn } from "@/lib/utils";

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <main className={cn("mx-auto w-full max-w-[1400px] px-4 pt-6 pb-16 lg:px-6", className)}>{children}</main>;
}

export function PageHeader({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[34px] leading-none">{title}</h1>
        {sub && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{sub}</p>}
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

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
    <section className={cn("epi-in flex min-w-0 flex-col rounded-xl border border-border bg-card/50", className)}>
      {(title || action) && (
        <header className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border/70 px-4 py-2">
          <h2 className="text-[11px] font-medium tracking-[0.08em] text-fog uppercase">{title}</h2>
          {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
        </header>
      )}
      <div className={cn("min-h-0 flex-1 p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-[0.08em] text-fog uppercase">{label}</div>
      <div className={cn("mt-1 font-mono text-2xl tracking-tight text-paper tabular-nums", tone)}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function ErrorNote({ error, className }: { error: ApiError | Error | string; className?: string }) {
  const msg = typeof error === "string" ? error : error.message;
  return (
    <div role="alert" className={cn("flex items-start gap-2 rounded-lg border border-coral-red/30 bg-coral-red/5 px-3 py-2.5 text-sm text-mist", className)}>
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-coral-red" aria-hidden />
      <span className="min-w-0 break-words">{msg}</span>
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-border px-6 py-14 text-center">
      {icon && <div className="mb-3 text-fog">{icon}</div>}
      <div className="text-sm text-paper">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
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
        <span className={cn("inline-flex items-center gap-1.5 font-mono text-[11px] text-fog", className)} tabIndex={0}>
          <Receipt className="size-3.5" aria-hidden />
          {r.queries} {r.queries === 1 ? "query" : "queries"} · {ms(r.total_ms)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-xs">
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
      className={cn("h-7 text-xs", className)}
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
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {done ? "Copied" : label}
    </Button>
  );
}

/** A symbol, linked to its detail page. `id` is the graph id (`path::qname`). */
export function SymLink({ repo, id, name, className }: { repo: string; id: string; name?: string; className?: string }) {
  return (
    <Link
      href={repoHref(repo, `/explore?ref=${encodeURIComponent(id)}`)}
      className={cn("font-mono text-paper underline-offset-2 hover:text-gold hover:underline", className)}
    >
      {symName(name ?? id.slice(id.indexOf("::") + 2))}
    </Link>
  );
}

export function FileLink({ repo, path, line, className }: { repo: string; path: string; line?: number; className?: string }) {
  return (
    <Link
      href={repoHref(repo, `/explore?file=${encodeURIComponent(path)}`)}
      className={cn("font-mono text-muted-foreground underline-offset-2 hover:text-mist hover:underline", className)}
    >
      {path}
      {line ? `:${line}` : ""}
    </Link>
  );
}

/** A thin horizontal meter (probability, confidence, share). */
export function Meter({ value, className, barClassName }: { value: number; className?: string; barClassName?: string }) {
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-graphite", className)} aria-hidden>
      <div className={cn("h-full rounded-full bg-mist", barClassName)} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded-sm border border-border bg-white/5 px-1 font-mono text-[10px] text-fog">{children}</kbd>;
}
