"use client";

import { useEffect, useState } from "react";

import { Steps } from "@/components/gt";
import { eventsUrl } from "@/lib/api";

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
  // the rail fills by whole stages, plus the measured fraction of parse while it runs
  const fill = job.status === "done" ? 1 : (at + (at === 0 ? frac : 0.5)) / STAGES.length;
  const r = job.report;
  return (
    <div className="border border-line bg-deep px-[clamp(14px,2vw,22px)] py-4" aria-live="polite">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[13px] text-ink">{repo}</span>
        <span className={job.status === "error" ? "font-mono text-[10.5px] tracking-[.12em] text-fail uppercase" : "font-mono text-[10.5px] tracking-[.12em] text-mark uppercase"}>
          {job.status === "running" ? "indexing" : job.status === "done" ? "indexed" : "failed"}
          {job.status === "running" && <span className="animate-blink">_</span>}
        </span>
        {job.status === "error" && job.detail && <span className="text-[13px] text-fail">{job.detail}</span>}
        {job.stage === "parse" && job.total ? (
          <span className="gt-fig ml-auto">
            {job.done}/{job.total} files
          </span>
        ) : null}
      </div>
      <Steps
        fill={fill}
        steps={STAGES.map((st, i) => ({
          key: st.key,
          title: st.label,
          lit: i < at || (i === at && job.status !== "error"),
          fail: job.status === "error" && i === at,
          mark: i < at ? "done" : i === at ? (job.status === "error" ? "failed" : job.status === "done" ? "done" : "now") : "",
        }))}
      />
      {job.status === "done" && r && (
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-ink-dim">
          {(["files", "parsed", "symbols", "edges"] as const).map((k) =>
            r[k] !== undefined ? (
              <span key={k}>
                <span className="text-mark">{String(r[k])}</span> {k}
              </span>
            ) : null,
          )}
          {typeof r.call_sites === "number" && r.call_sites > 0 && (
            <span>
              <span className="text-mark">{Math.round(((r.resolved_sites as number) / r.call_sites) * 100)}%</span> call sites resolved
            </span>
          )}
        </div>
      )}
    </div>
  );
}
