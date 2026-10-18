"use client";

import { useEffect, useState } from "react";

import { Check, CircleAlert, Loader2 } from "@/components/icons";
import { eventsUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The pipeline's stages, in order (aftershock/ingest/pipeline.py); "analyze" covers history, PageRank and communities. */
const STAGES = [
  { key: "parse", label: "Parse" },
  { key: "diff", label: "Diff" },
  { key: "symbols", label: "Symbols" },
  { key: "edges", label: "Edges" },
  { key: "analyze", label: "Analyze" },
] as const;

type Ev = { type: string; stage?: string; done?: number; total?: number; detail?: string; report?: Record<string, unknown>; [k: string]: unknown };

export interface JobState {
  stage: string;
  done?: number;
  total?: number;
  facts: Record<string, string | number>;
  status: "running" | "done" | "error";
  detail?: string;
  report?: Record<string, unknown>;
}

/** Follows one index job over SSE (via EventSource, which reconnects with Last-Event-ID on its own). */
export function useIndexJob(repo: string | null, after: number, onDone?: () => void): JobState | null {
  const [s, setS] = useState<JobState | null>(null);
  useEffect(() => {
    if (!repo) return;
    setS({ stage: "parse", facts: {}, status: "running" });
    const es = new EventSource(eventsUrl(repo, after));
    const on = (e: MessageEvent) => {
      let ev: Ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.type === "progress" && ev.stage) {
        const facts: Record<string, string | number> = {};
        for (const [k, v] of Object.entries(ev)) if (!["type", "stage", "ts", "seq", "done", "total"].includes(k) && (typeof v === "number" || typeof v === "string")) facts[k] = v;
        // after "edges" the pipeline mines history and computes centrality without further events
        const stage = ev.stage === "edges" ? "analyze" : ev.stage;
        setS((p) => ({ ...(p ?? { status: "running" }), stage, done: ev.done, total: ev.total, facts: { ...p?.facts, ...facts }, status: "running" }));
      } else if (ev.type === "indexed") {
        setS((p) => ({ ...(p ?? { facts: {} }), stage: "done", status: "done", report: ev.report }));
        es.close();
        onDone?.();
      } else if (ev.type === "error") {
        setS((p) => ({ ...(p ?? { facts: {}, stage: "parse" }), status: "error", detail: ev.detail }));
        es.close();
        onDone?.();
      }
    };
    es.addEventListener("progress", on);
    es.addEventListener("indexed", on);
    es.addEventListener("error", (e) => {
      if (e instanceof MessageEvent) on(e); // a server "error" event; a bare Event is a dropped connection, which retries
    });
    return () => es.close();
    // onDone is a callback prop; re-subscribing when it changes identity would replay the job
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, after]);
  return s;
}

export function JobProgress({ repo, job }: { repo: string; job: JobState }) {
  const at = job.status === "done" ? STAGES.length : Math.max(0, STAGES.findIndex((x) => x.key === job.stage));
  const frac = job.stage === "parse" && job.total ? (job.done ?? 0) / job.total : 0;
  return (
    <div className="epi-in rounded-xl border border-border bg-card/60 p-4" aria-live="polite">
      <div className="mb-3 flex items-center gap-2 text-sm">
        {job.status === "running" && <Loader2 className="size-4 animate-spin text-brand" aria-hidden />}
        {job.status === "done" && <Check className="size-4 text-pulse-green" aria-hidden />}
        {job.status === "error" && <CircleAlert className="size-4 text-coral-red" aria-hidden />}
        <span className="font-mono text-paper">{repo}</span>
        <span className="text-muted-foreground">
          {job.status === "running" ? "indexing…" : job.status === "done" ? "indexed" : (job.detail ?? "failed")}
        </span>
        {job.stage === "parse" && job.total ? (
          <span className="ml-auto font-mono text-xs text-fog tabular-nums">
            {job.done}/{job.total} files
          </span>
        ) : null}
      </div>
      <ol className="grid grid-cols-5 gap-1.5">
        {STAGES.map((st, i) => (
          <li key={st.key} className="min-w-0">
            <div className="h-1 overflow-hidden rounded-full bg-graphite">
              <div
                className={cn("h-full rounded-full transition-[width] duration-300", job.status === "error" && i === at ? "bg-coral-red" : "bg-brand")}
                style={{ width: i < at ? "100%" : i === at ? (st.key === "parse" ? `${Math.max(4, frac * 100)}%` : job.status === "error" ? "100%" : "40%") : "0%" }}
              />
            </div>
            <div className={cn("mt-1.5 truncate text-[11px]", i <= at ? "text-mist" : "text-fog")}>{st.label}</div>
          </li>
        ))}
      </ol>
      {job.status === "done" && job.report && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
          {(["files", "parsed", "symbols", "edges"] as const).map((k) =>
            job.report![k] !== undefined ? (
              <span key={k}>
                <span className="text-paper">{String(job.report![k])}</span> {k}
              </span>
            ) : null,
          )}
          {typeof job.report.call_sites === "number" && job.report.call_sites > 0 && (
            <span>
              <span className="text-paper">{Math.round(((job.report.resolved_sites as number) / job.report.call_sites) * 100)}%</span> call sites resolved
            </span>
          )}
        </div>
      )}
    </div>
  );
}
