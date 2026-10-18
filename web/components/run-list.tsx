"use client";

import Link from "next/link";

import { Bot, CircleAlert, CircleCheck } from "@/components/icons";
import type { TestRunSummary } from "@/lib/api";
import { num, relTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Recorded TestRuns (D25), newest first; each opens on the Culprit page, where a failing one can be fixed. */
export function RunList({ repo, runs, current }: { repo: string; runs: TestRunSummary[]; current?: string }) {
  if (!runs.length) return <p className="p-3 text-sm text-muted-foreground">No recorded runs yet. Every run from this page, the CLI or a heal is kept here.</p>;
  return (
    <ul className="space-y-0.5">
      {runs.map((r) => {
        const bad = r.failed > 0 || ![0, 5].includes(r.exit_code);
        return (
          <li key={r.id}>
            <Link
              href={`/r/${encodeURIComponent(repo)}/culprit?run=${r.id}`}
              aria-current={current === r.id ? "true" : undefined}
              className={cn("flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]", current === r.id && "bg-white/[0.05]")}
            >
              {bad ? <CircleAlert className="size-3.5 shrink-0 text-fail" /> : <CircleCheck className="size-3.5 shrink-0 text-info" />}
              <span className="w-[4.5rem] shrink-0 font-mono text-[11px] text-ink-muted">{r.id.slice(-8)}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                {r.trigger === "heal" ? (
                  <span className="inline-flex items-center gap-1 text-brand">
                    <Bot className="size-3" /> heal {r.heal_step}
                    {r.heal_round ? ` · round ${r.heal_round}` : ""}
                  </span>
                ) : (
                  r.mode
                )}
                {r.heal_suspect && <span className="font-mono text-ink-muted"> · {r.heal_suspect.split("::").pop()}</span>}
              </span>
              <span className="shrink-0 font-mono text-[11px]">
                <span className={r.failed ? "text-fail" : "text-ink-muted"}>{num(r.failed)}✗</span> <span className="text-ink-muted">{num(r.passed)}✓</span>
              </span>
              <span className="w-16 shrink-0 text-right text-[11px] text-ink-muted">{relTime(r.started)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
