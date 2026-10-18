"use client";

/**
 * Ask — plain-English questions, answered from the graph, with the work shown.
 *
 * Three decisions worth stating, because they are the difference between this
 * page and a generic chat window:
 *
 * 1. **The trace is part of the answer, not a debug panel.** Aftershock's whole
 *    claim is "here is the evidence"; the tool calls, their arguments and their
 *    receipts are that evidence. They render inline in a `Trace`, collapsed to
 *    one line each, and a step that errored opens itself — a failure the reader
 *    has to go looking for is a failure they will not find.
 *
 * 2. **Checkpoints rewind the conversation, not your code.** Aftershock only
 *    reads a repository; nothing on this page can change a file, so a "restore"
 *    that claimed to undo code changes would be a lie. What it restores is the
 *    thread: drop this turn and everything after it, and put the question back
 *    in the composer so you can re-ask it differently — against another model,
 *    or with different wording. The label says exactly that.
 *
 * 3. **The model is chosen per question, next to the question.** It is a
 *    property of the ask, not a global setting, because comparing two models on
 *    the same question is the normal reason to change it. Keys live in Settings;
 *    this only picks from what is already callable.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Bot, CircleAlert, Restore, Search, Send, Settings, Sparkles, Stop, Terminal } from "@/components/icons";
import { ModelPicker, EFFORTS } from "@/components/ask/model-picker";
import {
  Callout,
  Chip,
  CodeBlock,
  Eyebrow,
  Mono,
  Page,
  PageHeader,
  Panel,
  Segmented,
  Trace,
  TraceLine,
} from "@/components/ds";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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

/* -------------------------------------------------------------------------- */

/** `{"symbol": "parse", "depth": 3}` → `symbol=parse depth=3` — scannable at a glance. */
function args(input: Record<string, unknown>): string {
  const parts = Object.entries(input)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return parts.join(" ");
}

function StepLine({ s }: { s: Step }) {
  const failed = Boolean(s.error);
  return (
    <TraceLine
      status={!s.done ? "running" : failed ? "error" : "done"}
      title={s.tool}
      summary={s.done ? s.summary : args(s.input)}
      receipts={s.receipts}
      // A failed step opens itself: the reader should not have to guess which of
      // eleven collapsed rows is the one that went wrong.
      defaultOpen={failed}
    >
      <CodeBlock code={JSON.stringify(s.input, null, 2)} title="arguments" maxHeight={224} />
      {s.summary && <p className="text-body-sm text-ink-muted">{s.summary}</p>}
      {typeof s.error === "string" && <p className="text-body-sm text-fail">{s.error}</p>}
    </TraceLine>
  );
}

function Provenance({ t }: { t: Turn }) {
  if (!t.mode) {
    return (
      <span className="flex items-center gap-1.5 text-caption text-ink-faint">
        <Sparkles className="size-3.5 animate-pulse" aria-hidden /> choosing a model…
      </span>
    );
  }
  if (t.mode === "claude") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-caption text-ink-muted">
        <Sparkles className="size-3.5 shrink-0 text-brand" aria-hidden />
        <span className="truncate">
          {t.provider ? `${t.provider} · ` : ""}
          <Mono className="text-ink">{t.model}</Mono>
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-caption text-ink-muted">
      <Terminal className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        Router{t.reason ? ` — ${t.reason}` : ""}
      </span>
    </span>
  );
}

function TurnView({ t, onRestore, canRestore }: { t: Turn; onRestore: () => void; canRestore: boolean }) {
  const failedSteps = t.steps.filter((s) => s.error).length;
  return (
    <article className="as-in flex flex-col gap-2.5">
      {/* The question. Right-aligned so a long thread reads as a conversation, not a log. */}
      <div className="flex items-start justify-end gap-2">
        {canRestore && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRestore}
                className="mt-1 size-7 shrink-0 p-0 text-ink-faint hover:text-ink-strong"
                aria-label="Restore the thread to before this question"
              >
                <Restore className="size-3.5" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              Rewind to here — drops this turn and everything after it, and puts the question back in the box. Your
              files are untouched; Aftershock only reads them.
            </TooltipContent>
          </Tooltip>
        )}
        <p className="w-fit max-w-[85%] rounded-nested rounded-br-sm border border-line-strong bg-surface-raised px-3.5 py-2 text-body-sm text-ink-strong">
          {t.q}
        </p>
      </div>

      <Panel
        bodyClassName="flex flex-col gap-3"
        action={
          <div className="flex items-center gap-2">
            {failedSteps > 0 && (
              <Chip tone="fail" size="sm">
                {failedSteps} failed
              </Chip>
            )}
            {t.steps.length > 0 && (
              <span className="font-mono text-micro text-ink-faint">
                {t.steps.length} {t.steps.length === 1 ? "step" : "steps"}
              </span>
            )}
          </div>
        }
        title={<Provenance t={t} />}
      >
        {/* The asked-for model differed from the one that answered: say so, rather than
         *  letting a silent downgrade look like the model you picked did poorly. */}
        {t.mode === "router" && t.asked.model && (
          <Callout tone="warn" icon={<CircleAlert className="text-warn" aria-hidden />}>
            You picked <Mono>{t.asked.model}</Mono>, but the router answered{t.reason ? `: ${t.reason}` : ""}. The
            answer is still from the graph — it just used one tool instead of reasoning over several.
          </Callout>
        )}

        {t.steps.length > 0 && (
          <Trace>
            {t.steps.map((s, i) => (
              <StepLine key={i} s={s} />
            ))}
          </Trace>
        )}

        {t.answer ? (
          <div className="text-body-sm leading-relaxed text-ink">
            <Markdown text={t.answer} />
          </div>
        ) : t.error ? (
          <p className="flex items-start gap-2 text-body-sm text-fail">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {t.error}
          </p>
        ) : t.stopped ? (
          <p className="text-body-sm text-ink-muted">Stopped. The steps above did run — their receipts are real.</p>
        ) : !t.done ? (
          <p className="flex items-center gap-2 text-body-sm text-ink-muted">
            <span className="size-1.5 animate-pulse rounded-full bg-brand" aria-hidden />
            {t.steps.length === 0 ? "Querying the graph…" : "Writing the answer…"}
          </p>
        ) : (
          <p className="text-body-sm text-ink-muted">No answer came back.</p>
        )}
      </Panel>
    </article>
  );
}

/* -------------------------------------------------------------------------- */

export default function AskPage() {
  const repo = useRepo();
  const [q, setQ] = useState("");
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
  const reasons = useMemo(
    () => providers.some((p) => p.models.some((m) => m.id === model && m.reasoning)),
    [providers, model],
  );

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    // block body: newer browsers return a Promise from scrollIntoView, which React would call as a cleanup
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const patch = useCallback(
    (fn: (t: Turn) => Turn) => setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts[ts.length - 1])] : ts)),
    [],
  );

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
        // Omit the keys entirely rather than sending null: the server's default should
        // apply because nothing was asked for, not because something asked for nothing.
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
            patch((t) => ({
              ...t,
              steps: [...t.steps, { tool: String(d.name), input: (d.input as Record<string, unknown>) ?? {}, done: false }],
            }));
          else if (event === "result")
            patch((t) => {
              const steps = [...t.steps];
              // results arrive in call order; fill the first open step for this tool
              const i = steps.findIndex((s) => !s.done && s.tool === d.tool);
              const r = {
                summary: d.summary as string,
                error: d.error as string | boolean,
                receipts: d.receipts as R,
                done: true,
              };
              if (i >= 0) steps[i] = { ...steps[i], ...r };
              else steps.push({ tool: String(d.tool), input: (d.input as Record<string, unknown>) ?? {}, ...r });
              return { ...t, steps };
            });
          else if (event === "answer") patch((t) => ({ ...t, answer: String(d.text ?? "") }));
          else if (event === "error") patch((t) => ({ ...t, error: String(d.detail ?? "the agent failed") }));
          else if (event === "end")
            patch((t) => ({ ...t, done: true, steps: t.steps.map((s) => ({ ...s, done: true })) }));
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
    <Page className="flex min-h-[calc(100svh-var(--topbar-h))] flex-col">
      <PageHeader
        eyebrow="Ask"
        title="Ask the graph"
        sub="Questions in English, answered from the indexed graph. Every tool call the agent made is listed with its arguments and what it cost, so you can check the answer instead of trusting it."
      />

      {!prov.loading && !anyKey && (
        <Callout
          tone="info"
          icon={<Terminal className="text-info" aria-hidden />}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/models">
                <Settings className="size-3.5" aria-hidden /> Add a key
              </Link>
            </Button>
          }
          className="mb-4"
        >
          No model is configured, so questions go to the deterministic router: it matches your wording to one graph
          tool and returns that tool&apos;s output. Accurate, but it will not combine several queries or reason about
          what you meant.
        </Callout>
      )}

      <div className="flex flex-1 flex-col gap-5">
        {turns.length === 0 ? (
          <Panel title="Try one" bodyClassName="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {SUGGEST.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                className={cn(
                  "group flex items-start gap-2 rounded-control border border-line bg-base px-3 py-2.5 text-left",
                  "transition-colors duration-[var(--dur-fast)] hover:border-brand/40 hover:bg-surface",
                )}
              >
                <Search className="mt-0.5 size-3.5 shrink-0 text-ink-faint group-hover:text-brand" aria-hidden />
                <span className="text-body-sm text-ink">{s}</span>
              </button>
            ))}
          </Panel>
        ) : (
          turns.map((t, i) => (
            <TurnView key={i} t={t} onRestore={() => restore(i)} canRestore={!busy || i < turns.length - 1} />
          ))
        )}
        <div ref={end} />
      </div>

      <form
        className="sticky bottom-4 mt-5 rounded-nested border border-line-strong bg-base/95 shadow-[var(--shadow-pop)] backdrop-blur-xl"
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
      >
        <div className="flex items-end gap-2 p-2">
          <Bot className="mb-2 ml-1 size-4 shrink-0 text-ink-faint" aria-hidden />
          <Textarea
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
            className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
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
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-2 py-1">
          <ModelPicker
            providers={providers}
            serverDefault={serverDefault}
            value={model}
            onChange={setModel}
            disabled={busy}
          />
          {reasons && (
            <>
              <span className="h-4 w-px bg-line" aria-hidden />
              <Eyebrow className="text-ink-faint">Effort</Eyebrow>
              <Segmented
                label="Reasoning effort"
                size="sm"
                value={effort}
                onChange={setEffort}
                options={EFFORTS.map((e) => ({ value: e, label: e }))}
              />
            </>
          )}
          <span className="ml-auto hidden items-center gap-1 text-micro text-ink-faint sm:flex">
            Enter to ask · Shift+Enter for a new line
          </span>
        </div>
      </form>
    </Page>
  );
}
