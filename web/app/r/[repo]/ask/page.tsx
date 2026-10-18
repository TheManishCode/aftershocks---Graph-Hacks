"use client";

import { useEffect, useRef, useState } from "react";

import { Bot, Check, CircleAlert, Loader2, Send, Sparkles, Terminal, X } from "@/components/icons";
import { Page, Receipts } from "@/components/kit";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { askStreamUrl, type Receipts as R } from "@/lib/api";
import { useRepo } from "@/lib/hooks";
import { postStream } from "@/lib/sse";
import { cn } from "@/lib/utils";

interface Step {
  tool: string;
  input: Record<string, unknown>;
  summary?: string;
  error?: string | boolean;
  receipts?: R;
  done: boolean;
}
interface Turn {
  q: string;
  mode?: "claude" | "router";
  model?: string;
  reason?: string;
  steps: Step[];
  answer?: string;
  error?: string;
  done: boolean;
}

const SUGGEST = [
  "What breaks if I change the signature of the most central function?",
  "Which tests cover the graph module?",
  "Why does the API layer depend on the database helpers?",
  "Where are the dependency cycles?",
  "What code looks dead?",
  "Who should review a change to the ingest pipeline?",
];

function StepRow({ s }: { s: Step }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="text-xs">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-white/[0.03]" aria-expanded={open}>
        {!s.done ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-brand" />
        ) : s.error ? (
          <CircleAlert className="size-3.5 shrink-0 text-coral-red" />
        ) : (
          <Check className="size-3.5 shrink-0 text-pulse-green" />
        )}
        <span className="font-mono text-paper">{s.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fog">{JSON.stringify(s.input)}</span>
        {s.receipts && <Receipts r={s.receipts} className="shrink-0" />}
      </button>
      {open && (
        <div className="ml-6 space-y-1 border-l border-graphite py-1 pl-3 font-mono text-[11px] text-fog">
          <pre className="whitespace-pre-wrap break-all">{JSON.stringify(s.input, null, 2)}</pre>
          {s.summary && <div className="text-mist">{s.summary}</div>}
          {typeof s.error === "string" && <div className="text-coral-red">{s.error}</div>}
        </div>
      )}
    </li>
  );
}

function TurnView({ t }: { t: Turn }) {
  return (
    <article className="epi-in space-y-3">
      <div className="ml-auto w-fit max-w-[85%] rounded-xl rounded-br-sm border border-graphite bg-obsidian px-4 py-2.5 text-sm text-paper">{t.q}</div>
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2 text-[11px] text-fog">
          {t.mode === "claude" ? <Sparkles className="size-3.5 text-brand" /> : <Terminal className="size-3.5" />}
          {t.mode === "claude" ? (
            <span>
              Claude agent <span className="font-mono">{t.model}</span>
            </span>
          ) : t.mode === "router" ? (
            <span>Deterministic router{t.reason ? ` (${t.reason})` : ""}: no model, matched to one graph tool</span>
          ) : (
            <span>Planning…</span>
          )}
          {t.steps.length > 0 && <span className="ml-auto">{t.steps.length} tool call{t.steps.length === 1 ? "" : "s"}</span>}
        </div>
        {t.steps.length > 0 && (
          <ol className="mb-3 space-y-0.5 rounded-lg border border-graphite/70 bg-void/50 p-1.5">
            {t.steps.map((s, i) => (
              <StepRow key={i} s={s} />
            ))}
          </ol>
        )}
        {t.answer ? (
          <div className="prose-sm text-sm leading-relaxed text-mist">
            <Markdown text={t.answer} />
          </div>
        ) : t.error ? (
          <div className="flex items-start gap-2 text-sm text-coral-red">
            <CircleAlert className="mt-0.5 size-4 shrink-0" /> {t.error}
          </div>
        ) : !t.done ? (
          <div className="flex items-center gap-2 text-sm text-fog">
            <Loader2 className="size-4 animate-spin" /> Querying the graph…
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default function AskPage() {
  const repo = useRepo();
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = turns.length > 0 && !turns[turns.length - 1].done;

  useEffect(() => () => abort.current?.abort(), []);
  // block body: newer browsers return a Promise from scrollIntoView, which React would call as a cleanup
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const patch = (fn: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1])]);

  const ask = async (question: string) => {
    question = question.trim();
    if (!question || busy) return;
    setQ("");
    setTurns((ts) => [...ts, { q: question, steps: [], done: false }]);
    const ac = new AbortController();
    abort.current = ac;
    try {
      await postStream(
        askStreamUrl(repo),
        { question },
        (event, raw) => {
          const d = (raw ?? {}) as Record<string, unknown>;
          if (event === "plan") patch((t) => ({ ...t, mode: d.mode as Turn["mode"], model: d.model as string, reason: d.reason as string }));
          else if (event === "tool") patch((t) => ({ ...t, steps: [...t.steps, { tool: String(d.name), input: (d.input as Record<string, unknown>) ?? {}, done: false }] }));
          else if (event === "result")
            patch((t) => {
              const steps = [...t.steps];
              // results arrive in call order; fill the first open step for this tool
              const i = steps.findIndex((s) => !s.done && s.tool === d.tool);
              const r = { summary: d.summary as string, error: d.error as string | boolean, receipts: d.receipts as R, done: true };
              if (i >= 0) steps[i] = { ...steps[i], ...r };
              else steps.push({ tool: String(d.tool), input: (d.input as Record<string, unknown>) ?? {}, ...r });
              return { ...t, steps };
            });
          else if (event === "answer") patch((t) => ({ ...t, answer: String(d.text ?? "") }));
          else if (event === "error") patch((t) => ({ ...t, error: String(d.detail ?? "failed") }));
          else if (event === "end") patch((t) => ({ ...t, done: true, steps: t.steps.map((s) => ({ ...s, done: true })) }));
        },
        ac.signal,
      );
    } catch (e) {
      if (!ac.signal.aborted) patch((t) => ({ ...t, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      patch((t) => ({ ...t, done: true }));
    }
  };

  return (
    <Page className="flex max-w-[920px] flex-col">
      <div className="mb-6">
        <h1 className="text-[34px] leading-none">Ask</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Plain-English questions, answered by graph tools you can inspect. With an Anthropic key the server runs a Claude agent; without one, a
          deterministic router maps the question to a single tool. Agent mode ships with Anthropic&apos;s server-side refusal fallbacks enabled.
        </p>
      </div>

      <div className="flex-1 space-y-6">
        {turns.length === 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SUGGEST.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                className="rounded-lg border border-border bg-card/40 px-3 py-2.5 text-left text-sm text-mist transition-colors hover:border-smoke hover:text-paper"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          turns.map((t, i) => <TurnView key={i} t={t} />)
        )}
        <div ref={end} />
      </div>

      <form
        className="sticky bottom-4 mt-6 rounded-xl border border-border bg-carbon/95 p-2 shadow-2xl backdrop-blur"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <div className="flex items-end gap-2">
          <Bot className="mb-2.5 ml-1 size-5 shrink-0 text-fog" aria-hidden />
          <Textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(q);
              }
            }}
            placeholder={`Ask about ${repo}…`}
            rows={1}
            className="max-h-40 min-h-10 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
            aria-label="Question"
          />
          {busy ? (
            <Button type="button" variant="outline" size="icon" onClick={() => abort.current?.abort()} aria-label="Stop">
              <X className="size-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!q.trim()} aria-label="Send" className={cn(!q.trim() && "opacity-50")}>
              <Send className="size-4" />
            </Button>
          )}
        </div>
      </form>
    </Page>
  );
}
