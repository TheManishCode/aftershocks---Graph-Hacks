"use client";

/**
 * Ask — plain-English questions, answered from the graph, with the work shown.
 *
 * 1. **The trace is part of the answer, not a debug panel.** The tool calls,
 *    their arguments and their receipts are the evidence. They render inline,
 *    one ruled line each, and a step that errored opens itself — a failure the
 *    reader has to go looking for is a failure they will not find.
 *
 * 2. **Checkpoints rewind the conversation, not your code.** Aftershock only
 *    reads a repository, so "restore" drops this turn and everything after it
 *    and puts the question back in the composer — nothing more is claimed.
 *
 * 3. **The model is chosen per question, next to the question.** Comparing two
 *    models on the same question is the normal reason to change it. Keys live
 *    in Settings; this only picks from what is already callable.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EFFORTS, ModelPicker } from "@/components/ask/model-picker";
import { Callout, Chip, CodeBlock, Head, Mono, Page, Seg, Sheet, no2 } from "@/components/gt";
import { Bot, ChevronDown, CircleAlert, Restore, Send, Settings, Sparkles, Stop, Terminal } from "@/components/icons";
import { Receipts } from "@/components/kit";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, askStreamUrl, type Effort, type Receipts as R } from "@/lib/api";
import { useQuery, useRepo } from "@/lib/hooks";
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
  /** what was asked for; `null` means the server's default was used */
  asked: { model: string | null; effort: Effort };
  mode?: "claude" | "router";
  /** what actually answered — not always what was asked for, see `reason` */
  model?: string;
  provider?: string;
  /** why the router answered instead of a model */
  reason?: string;
  steps: Step[];
  answer?: string;
  error?: string;
  stopped?: boolean;
  done: boolean;
}

const SUGGEST = [
  "What breaks if I change the signature of the most central function?",
  "Which tests cover the graph module?",
  "Where are the dependency cycles?",
  "What code looks dead?",
  "Who should review a change to the ingest pipeline?",
  "Which files change together most often?",
];

/** `{"symbol": "parse", "depth": 3}` → `symbol=parse depth=3` — scannable at a glance. */
function args(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" ");
}

function StepLine({ s, i }: { s: Step; i: number }) {
  const failed = Boolean(s.error);
  const status = !s.done ? "running" : failed ? "error" : "done";
  return (
    // A failed step opens itself: the reader should not have to guess which of
    // eleven collapsed rows is the one that went wrong.
    <details open={failed || undefined} className="group border-b border-line-soft last:border-0">
      <summary className="grid cursor-pointer list-none grid-cols-[28px_10px_minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 hover:bg-void-lift [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[10.5px] text-ink-faint">{no2(i + 1)}</span>
        <span
          className={cn("size-2", status === "running" ? "animate-blink bg-mark" : status === "error" ? "bg-fail" : "bg-pass")}
          aria-label={status}
          role="img"
        />
        <Mono className="text-[12.5px] text-ink">{s.tool}</Mono>
        <span className="truncate font-mono text-[11px] text-ink-faint">{s.done ? s.summary : args(s.input)}</span>
        <ChevronDown className="size-3.5 text-ink-faint transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="flex flex-col gap-2 px-3 pt-1 pb-3 pl-[52px]">
        <CodeBlock code={JSON.stringify(s.input, null, 2)} title="arguments" maxHeight={224} />
        {s.summary && <p className="text-[13px] text-ink-dim">{s.summary}</p>}
        {typeof s.error === "string" && <p className="text-[13px] text-fail">{s.error}</p>}
        {s.receipts && <Receipts r={s.receipts} />}
      </div>
    </details>
  );
}

function Provenance({ t }: { t: Turn }) {
  if (!t.mode)
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-ink-faint">
        <Sparkles className="size-3.5 animate-pulse" aria-hidden /> choosing a model…
      </span>
    );
  if (t.mode === "claude")
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-dim">
        <Sparkles className="size-3.5 shrink-0 text-mark" aria-hidden />
        <span className="truncate">
          {t.provider ? `${t.provider} · ` : ""}
          <Mono className="text-ink">{t.model}</Mono>
        </span>
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-dim">
      <Terminal className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">Router{t.reason ? ` — ${t.reason}` : ""}</span>
    </span>
  );
}

function TurnView({ t, i, onRestore, canRestore }: { t: Turn; i: number; onRestore: () => void; canRestore: boolean }) {
  const failedSteps = t.steps.filter((s) => s.error).length;
  return (
    <article className="flex flex-col gap-3">
      {/* The question, right-aligned so a long thread reads as a conversation, not a log. */}
      <div className="flex items-start justify-end gap-2">
        {canRestore && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRestore}
                className="mt-1 size-7 shrink-0 p-0 text-ink-faint hover:text-ink"
                aria-label="Restore the thread to before this question"
              >
                <Restore className="size-3.5" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              Rewind to here — drops this turn and everything after it, and puts the question back in the box. Your files are untouched; Aftershock only reads
              them.
            </TooltipContent>
          </Tooltip>
        )}
        <p className="w-fit max-w-[85%] border border-line-loud border-r-mark border-r-2 bg-slate px-4 py-2.5 text-[14px] text-ink">{t.q}</p>
      </div>

      <Sheet
        no={`${no2(i + 1)} · Answer`}
        title={<Provenance t={t} />}
        tone="library"
        bodyClassName="flex flex-col gap-4"
        action={
          <>
            {failedSteps > 0 && <Chip tone="fail">{failedSteps} failed</Chip>}
            {t.steps.length > 0 && (
              <span className="font-mono text-[11px] text-ink-faint">
                {t.steps.length} {t.steps.length === 1 ? "step" : "steps"}
              </span>
            )}
          </>
        }
      >
        {/* The asked-for model differed from the one that answered: say so, rather than
         *  letting a silent downgrade look like the model you picked did poorly. */}
        {t.mode === "router" && t.asked.model && (
          <Callout tone="warn" icon={<CircleAlert aria-hidden />}>
            You picked <Mono>{t.asked.model}</Mono>, but the router answered{t.reason ? `: ${t.reason}` : ""}. The answer is still from the graph — it just used one
            tool instead of reasoning over several.
          </Callout>
        )}

        {t.steps.length > 0 && (
          <div className="border border-line bg-deep" role="list" aria-label="Tool calls">
            <div className="gt-label border-b border-line px-3 py-2">Trace</div>
            {t.steps.map((s, j) => (
              <div role="listitem" key={j}>
                <StepLine s={s} i={j} />
              </div>
            ))}
          </div>
        )}

        {t.answer ? (
          <div className="text-[14px] leading-relaxed text-ink">
            <Markdown text={t.answer} />
          </div>
        ) : t.error ? (
          <p className="flex items-start gap-2 text-[13.5px] text-fail">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {t.error}
          </p>
        ) : t.stopped ? (
          <p className="text-[13.5px] text-ink-dim">Stopped. The steps above did run — their receipts are real.</p>
        ) : !t.done ? (
          <p className="flex items-center gap-2 font-mono text-[12px] tracking-[.08em] text-ink-dim uppercase">
            <span className="size-2 animate-blink bg-mark" aria-hidden />
            {t.steps.length === 0 ? "Querying the graph" : "Writing the answer"}
          </p>
        ) : (
          <p className="text-[13.5px] text-ink-dim">No answer came back.</p>
        )}
      </Sheet>
    </article>
  );
}

export default function AskPage() {
  const repo = useRepo();
  // `?q=` prefills the box (the Tests page links here to have the agent pick scripts). It is never sent on load:
  // asking costs model tokens, so the user presses Send.
  const prefill = useSearchParams().get("q") ?? "";
  const [q, setQ] = useState(prefill.slice(0, 2000));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort>("medium");
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = turns.length > 0 && !turns[turns.length - 1].done;

  const prov = useQuery("providers", api.providers);
  const providers = useMemo(() => prov.data?.providers ?? [], [prov.data]);
  const serverDefault = prov.data?.default ?? null;
  const anyKey = providers.some((p) => p.configured && !p.keyless);
  // Effort only means something to a model that reasons; showing it otherwise is a dead control.
  const reasons = useMemo(() => providers.some((p) => p.models.some((m) => m.id === model && m.reasoning)), [providers, model]);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    // block body: newer browsers return a Promise from scrollIntoView, which React would call as a cleanup
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const patch = useCallback((fn: (t: Turn) => Turn) => setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts[ts.length - 1])] : ts)), []);

  const ask = async (question: string) => {
    question = question.trim();
    if (!question || busy) return;
    setQ("");
    const asked = { model, effort };
    setTurns((ts) => [...ts, { q: question, asked, steps: [], done: false }]);
    const ac = new AbortController();
    abort.current = ac;
    try {
      await postStream(
        askStreamUrl(repo),
        // Omit the keys rather than sending null: the server's default should apply
        // because nothing was asked for, not because something asked for nothing.
        { question, ...(model ? { model } : {}), ...(reasons ? { effort } : {}) },
        (event, raw) => {
          const d = (raw ?? {}) as Record<string, unknown>;
          if (event === "plan")
            patch((t) => ({
              ...t,
              mode: d.mode as Turn["mode"],
              model: (d.model_id as string) ?? (d.model as string),
              provider: d.provider_label as string,
              reason: d.reason as string,
            }));
          else if (event === "tool")
            patch((t) => ({ ...t, steps: [...t.steps, { tool: String(d.name), input: (d.input as Record<string, unknown>) ?? {}, done: false }] }));
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
          else if (event === "error") patch((t) => ({ ...t, error: String(d.detail ?? "the agent failed") }));
          else if (event === "end") patch((t) => ({ ...t, done: true, steps: t.steps.map((s) => ({ ...s, done: true })) }));
        },
        ac.signal,
      );
    } catch (e) {
      if (ac.signal.aborted) patch((t) => ({ ...t, stopped: true }));
      else patch((t) => ({ ...t, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      // Steps left open when the stream ended never reported a result; marking them
      // "done" would claim they succeeded, so they stay as they were and the turn closes.
      patch((t) => ({ ...t, done: true }));
    }
  };

  /** Drop this turn and everything after it, and put the question back for another go. */
  const restore = (i: number) => {
    abort.current?.abort();
    setTurns((ts) => ts.slice(0, i));
    setQ(turns[i].q);
    setModel(turns[i].asked.model);
    setEffort(turns[i].asked.effort);
    box.current?.focus();
  };

  return (
    <Page className="flex min-h-[100svh] flex-col">
      <Head
        no="08 · Ask"
        title={
          <>
            Ask the graph. <em>Check the work.</em>
          </>
        }
        lead="Questions in English, answered from the indexed graph. Every tool call the agent made is listed with its arguments and what it cost, so you can check the answer instead of trusting it."
      />

      {!prov.loading && !anyKey && (
        <Callout tone="info" icon={<Terminal aria-hidden />} className="mb-6" title="No model configured">
          Questions go to the deterministic router: it matches your wording to one graph tool and returns that tool&apos;s output. Accurate, but it will not combine
          several queries or reason about what you meant.{" "}
          <Link href="/settings/models" className="inline-flex items-center gap-1 text-mark underline-offset-4 hover:underline">
            <Settings className="size-3.5" aria-hidden /> Add a key
          </Link>
        </Callout>
      )}

      <div className="flex flex-1 flex-col gap-8">
        {turns.length === 0 ? (
          <Sheet no="00 · Start" title="Try one" tone="fragment" flush>
            <ul className="grid pb-2 sm:grid-cols-2">
              {SUGGEST.map((s, i) => (
                <li key={s}>
                  <button type="button" onClick={() => ask(s)} className="gt-row h-full w-full grid-cols-[28px_minmax(0,1fr)] text-left" data-hover-mark>
                    <span className="gt-row__no">{no2(i + 1)}</span>
                    <span className="gt-row__name text-[13.5px]">{s}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Sheet>
        ) : (
          turns.map((t, i) => <TurnView key={i} t={t} i={i} onRestore={() => restore(i)} canRestore={!busy || i < turns.length - 1} />)
        )}
        <div ref={end} />
      </div>

      <form
        className="sticky bottom-4 z-20 mt-8 border border-line-loud bg-sheet/95 backdrop-blur-xl"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <div className="flex items-end gap-2 p-2">
          <Bot className="mb-2.5 ml-1 size-4 shrink-0 text-ink-faint" aria-hidden />
          <textarea
            ref={box}
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
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-[14px] text-ink outline-none placeholder:text-ink-faint"
            aria-label="Question"
          />
          {busy ? (
            <Button type="button" variant="outline" size="icon" onClick={() => abort.current?.abort()} aria-label="Stop">
              <Stop className="size-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!q.trim()} aria-label="Ask">
              <Send className="size-4" />
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-2 py-1.5">
          <ModelPicker providers={providers} serverDefault={serverDefault} value={model} onChange={setModel} disabled={busy} />
          {reasons && (
            <>
              <span className="h-4 w-px bg-line" aria-hidden />
              <span className="gt-label">Effort</span>
              <Seg label="Reasoning effort" size="sm" value={effort} onChange={setEffort} options={EFFORTS.map((e) => ({ value: e, label: e }))} />
            </>
          )}
          <span className="ml-auto hidden font-mono text-[10.5px] text-ink-faint sm:inline">Enter to ask · Shift+Enter for a new line</span>
        </div>
      </form>
    </Page>
  );
}
