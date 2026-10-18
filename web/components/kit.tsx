"use client";

/**
 * Product vocabulary: the four components that know what a repo, a symbol or a
 * receipt *is*. Everything purely visual lives in `components/gt.tsx` — that file
 * decides appearance, this one decides meaning.
 */

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Check, Copy, Receipt } from "@/components/icons";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Receipts as R } from "@/lib/api";
import { ms, symName } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * What it cost to answer: the graph queries behind a result.
 *
 * Every API response carries these, and every page shows them. It is the
 * cheapest possible honesty signal — a page that spent 0 queries did not
 * consult the graph, and the reader can see that without being told.
 */
export function Receipts({ r, className }: { r?: R; className?: string }) {
  if (!r) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-[.04em] text-ink-dim tabular-nums", className)}
          tabIndex={0}
        >
          <Receipt className="size-3.5" aria-hidden />
          {r.queries} {r.queries === 1 ? "query" : "queries"} · {ms(r.total_ms)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-[11px]">
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
      className={cn("h-7", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          // Clipboard access is denied outside a secure context, which is easy
          // to hit on a LAN address. Silence would look like a broken button.
          toast.error("Clipboard blocked by the browser");
        }
      }}
    >
      {done ? <Check className="size-3.5 text-mark" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}{" "}
      {done ? "Copied" : label}
    </Button>
  );
}

/** A symbol, linked to its detail page. `id` is the graph id (`path::qname`). */
export function SymLink({ repo, id, name, className }: { repo: string; id: string; name?: string; className?: string }) {
  return (
    <Link
      href={repoHref(repo, `/explore?ref=${encodeURIComponent(id)}`)}
      className={cn("font-mono text-ink underline-offset-2 hover:text-mark hover:underline", className)}
    >
      {symName(name ?? id.slice(id.indexOf("::") + 2))}
    </Link>
  );
}

export function FileLink({ repo, path, line, className }: { repo: string; path: string; line?: number; className?: string }) {
  return (
    <Link
      href={repoHref(repo, `/explore?file=${encodeURIComponent(path)}`)}
      className={cn("font-mono text-ink-dim underline-offset-2 hover:text-mark hover:underline", className)}
    >
      {path}
      {line ? `:${line}` : ""}
    </Link>
  );
}
