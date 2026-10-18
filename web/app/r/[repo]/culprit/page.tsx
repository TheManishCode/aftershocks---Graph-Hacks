"use client";

/**
 * Culprit: tests are failing — which symbol is to blame?
 *
 * Two shapes. Without `?run=`, it ranks suspects for tests you name by hand.
 * With one, it opens a recorded run: its failures, its ranked suspects, its
 * lineage, and the fix loop.
 *
 * **It is the one surface in Aftershock that writes to your files.** So the fix
 * loop states, before you press anything, exactly what it will do — re-run, ask
 * the model, write to the working tree, re-run again, revert an edit that did
 * not help — and the stream shows each of those as it happens.
 *
 * **Measured and inferred evidence are labelled differently.** A run recorded
 * under per-test coverage ranks on code the tests actually executed; one
 * without it falls back to the static call graph, and the summary says which.
 */

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  Callout,
  Chip,
  CodeBlock,
  Cols,
  Empty,
  ErrorNote,
  Figure,
  Head,
  Label,
  Measuring,
  Mono,
  Page,
  Sheet,
  Skeleton,
  Stack,
  Steps,
  type Step as GtStep,
} from "@/components/gt";
import { Bot, Bug, ChevronDown, CircleAlert, CircleCheck, Stop } from "@/components/icons";
import { ProblemList } from "@/components/impact-view";
import { Receipts, SymLink } from "@/components/kit";
import { Enter } from "@/components/motion";
import { RunList } from "@/components/run-list";
import { SuspectRow } from "@/components/suspect-row";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { api, healStreamUrl, type HealDone, type HealRound, type RunDetail, type TestRunSummary } from "@/lib/api";
import { num, relTime, splitId } from "@/lib/format";
import { type Query, useAction, useQuery, useRepo } from "@/lib/hooks";
import { postStream } from "@/lib/sse";
import { cn } from "@/lib/utils";

export default function CulpritPage() {
  const repo = useRepo();
  const run = useSearchParams().get("run");
  const history = useQuery(`runs:${repo}`, () => api.runs(repo, 15));
  // Without `?run=`, open the newest failing run: its suspects are the answer people come here for.
  // `?manual=1` keeps the hand-entry form.
  const manual = useSearchParams().get("manual") === "1";
  const latest = !run && !manual ? history.data?.runs.find((r) => r.failed > 0) : undefined;
  if (!run && !manual && history.loading && !history.data) {
    return (
      <Page>
        <Skeleton className="h-64" />
      </Page>
    );
  }
  return run || latest ? (
    <RunView repo={repo} id={run ?? latest!.id} history={history} latest={!run} />
  ) : (
    <Page>
      <Manual repo={repo} />
      {history.data && history.data.runs.length > 0 && (
        <Sheet no="R · History" title="Recorded runs" className="mt-6" tone="fragment" flush>
          <RunList repo={repo} runs={history.data.runs} />
        </Sheet>
      )}
    </Page>
  );
}

/* ---------- a recorded run: its failures, suspects, lineage, and the fix loop ---------- */

type Step =
  | { kind: "start"; model: string; backend: string; tests: number }
  | { kind: "run"; step: string; tests: number; round?: number }
  | { kind: "ran"; step: string; run_id: string | null; passed: number; failed: number; round?: number }
  | { kind: "suspect"; name: string; file: string; line?: number; score?: number; hops?: number }
  | { kind: "asking"; model: string; suspect: string; file: string }
  | ({ kind: "round" } & HealRound)
  | { kind: "error"; detail: string };

const OUTCOME: Record<string, string> = {
  fixed: "fixed every failing test",
  partial: "fixed some failures; kept",
  no_change: "no improvement; reverted",
  worse: "made it worse; reverted",
  write_rejected: "edit rejected; nothing written",
  claude_error: "the model returned no usable fix",
};

const runHrefFor = (repo: string) => (x: string) => `/r/${encodeURIComponent(repo)}/culprit?run=${x}`;

function RunView({ repo, id, history, latest = false }: { repo: string; id: string; history: Query<{ runs: TestRunSummary[] }>; latest?: boolean }) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const detail = useQuery(`run:${repo}:${id}`, () => api.runDetail(repo, id));
  const runtime = useQuery("runtime", api.runtime);
  const [open, setOpen] = useState<string | null>(null);
  const [failOpen, setFailOpen] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [healing, setHealing] = useState(false);
  const [result, setResult] = useState<HealDone>();
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const autostart = useRef(sp.get("heal") === "1");
  useEffect(() => () => abort.current?.abort(), []);

  const d = detail.data;
  const canHeal = !!runtime.data?.enabled && !!d && d.failed > 0;

  const heal = async () => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setSteps([]);
    setResult(undefined);
    setError(undefined);
    setHealing(true);
    try {
      await postStream(
        healStreamUrl(repo, id),
        { max_rounds: 3 },
        (event, data) => {
          const x = data as Record<string, unknown>;
          if (event === "done") setResult(data as HealDone);
          else if (event === "error") setError(String(x.detail));
          else if (["start", "run", "ran", "suspect", "asking", "round"].includes(event)) setSteps((s) => [...s, { kind: event, ...x } as Step]);
        },
        ctl.signal,
      );
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === ctl) {
        setHealing(false);
        history.reload();
      }
    }
  };

  // "Fix with AI" arriving from the Tests page. The flag is dropped from the URL
  // before the first round starts, so a reload cannot silently edit the code again.
  useEffect(() => {
    if (!autostart.current || !canHeal) return;
    autostart.current = false;
    router.replace(`${pathname}?run=${id}`, { scroll: false });
    heal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canHeal]);

  const last = [...steps].reverse().find((s): s is Extract<Step, { kind: "ran" }> => s.kind === "ran" && !!s.run_id);

  return (
    <Page>
      <Head
        no={`04 · Culprit · run ${id.slice(-8)}`}
        title={
          <>
            Why did it fail, <em>and can it be fixed?</em>
          </>
        }
        lead="Each failure is traced through the code graph to the symbols most likely to cause it. The fix loop sends the top suspect's chain and source to a model, writes its edit to the working tree, re-runs the tests, and keeps the edit only if fewer tests fail."
        meta={
          d
            ? [
                { fig: num(d.failed), label: "failed" },
                { fig: num(d.passed), label: "passed" },
                ...(d.culprits ? [{ fig: num(d.culprits.suspects.length), label: "suspects" }] : []),
              ]
            : undefined
        }
      >
        {d?.culprits?.receipts && <Receipts r={d.culprits.receipts} />}
      </Head>
      {latest && (
        <p className="mb-4 text-[12.5px] text-ink-dim">
          The newest failing run on {repo}.{" "}
          <Link className="text-ink underline underline-offset-2" href={`/r/${encodeURIComponent(repo)}/culprit?manual=1`}>
            Rank tests you name instead
          </Link>
        </p>
      )}

      {detail.error ? (
        <ErrorNote error={detail.error} onRetry={detail.reload} />
      ) : !d ? (
        <Measuring label="Loading the run" />
      ) : (
        <Cols kind="main-aside">
          <Stack className="min-w-0">
            <RunSummary repo={repo} d={d} />

            {d.failures.length > 0 && (
              <Sheet no="02 · Failures" title={`Failures · ${num(d.failures.length)}`} tone="library" flush>
                <ul className="pb-2">
                  {d.failures.map((f) => {
                    const h = d.history?.[f.test];
                    const isOpen = failOpen === f.nodeid;
                    return (
                      <li key={f.nodeid} className={cn(isOpen && "bg-deep")}>
                        <button
                          type="button"
                          onClick={() => setFailOpen(isOpen ? null : f.nodeid)}
                          className="gt-row w-full grid-cols-[14px_14px_minmax(0,1fr)_auto_auto] text-left"
                          data-on={isOpen || undefined}
                          aria-expanded={isOpen}
                        >
                          <ChevronDown className={cn("size-3.5 text-ink-faint transition-transform", !isOpen && "-rotate-90")} aria-hidden />
                          <CircleAlert className="size-3.5 text-fail" aria-hidden />
                          <span className="min-w-0 truncate font-mono text-[12.5px] text-ink">{f.nodeid}</span>
                          {/* A failure in setup or teardown is a different bug from one in the test body. */}
                          {f.when && f.when !== "call" ? <Chip>{f.when}</Chip> : <span />}
                          {/* History separates "broken since recorded" from "fails one run in four". */}
                          {h ? (
                            <span className={cn("font-mono text-[10.5px]", h.failed === h.runs ? "text-fail" : h.failed ? "text-warn" : "text-ink-faint")}>
                              {h.failed === h.runs ? "failing since recorded" : h.failed ? `flaky? ${h.failed}/${h.runs} failed` : `passed ${h.runs} earlier runs`}
                            </span>
                          ) : (
                            <span className="font-mono text-[10.5px] text-ink-faint">first record</span>
                          )}
                        </button>
                        {isOpen && (
                          <div className="space-y-2 px-[clamp(14px,2vw,24px)] pt-1 pb-4">
                            <SymLink repo={repo} id={f.test} className="text-[12px]" />
                            <CodeBlock code={f.message || "(no message)"} maxHeight={288} wrap noCopy={!f.message} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Sheet>
            )}

            {d.culprits && (
              <Sheet
                no="03 · Suspects"
                title={`Likely culprits · ${num(d.culprits.suspects.length)}`}
                action={<Mono className="min-w-0 text-[11px] whitespace-normal text-ink-faint [overflow-wrap:anywhere]">{d.culprits.method}</Mono>}
                note="Open a suspect for its chain — the hops from a failing test to it, as the graph resolved them. That chain and the source along it are what the model is given."
                tone="library"
                flush
              >
                <div className="px-[clamp(14px,2vw,24px)] empty:hidden">
                  <ProblemList repo={repo} problems={d.culprits.problems} />
                </div>
                {d.culprits.suspects.length ? (
                  <ul className="pb-2">
                    {d.culprits.suspects.map((s, i) => (
                      <SuspectRow key={s.id} repo={repo} s={s} rank={i + 1} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
                    ))}
                  </ul>
                ) : (
                  <p className="px-[clamp(14px,2vw,24px)] pb-5 text-[13px] text-ink-dim">No suspects: the failing tests reach no resolved code.</p>
                )}
              </Sheet>
            )}

            {d.output_tail && (
              <Sheet no="04 · Output" title="pytest output" tone="fragment">
                <CodeBlock code={d.output_tail} maxHeight={288} wrap />
              </Sheet>
            )}
          </Stack>

          <Stack className="min-w-0 lg:sticky lg:top-[calc(var(--nav)+16px)] lg:self-start">
            <Sheet
              no="05 · Fix loop"
              title="Fix with AI"
              tone="commission"
              action={
                healing ? (
                  <Button size="sm" variant="outline" onClick={() => abort.current?.abort()}>
                    <Stop className="size-3.5" aria-hidden /> Stop watching
                  </Button>
                ) : (
                  <Button size="sm" onClick={heal} disabled={!canHeal}>
                    <Bot className="size-3.5" aria-hidden /> {result ? "Try again" : "Fix with AI"}
                  </Button>
                )
              }
            >
              {!runtime.data?.enabled ? (
                <p className="text-[13.5px] text-ink-dim">
                  Fixing with AI edits files on disk, so it only runs on the operator&apos;s own machine: start the API there with{" "}
                  <code className="font-mono text-ink">AFTERSHOCK_ALLOW_RUN=1</code>. The run, its failures and the ranked culprits above are readable by anyone.
                </p>
              ) : !d.failed ? (
                <p className="text-[13.5px] text-ink-dim">Nothing to fix: this run had no failing tests.</p>
              ) : !steps.length && !error && !result ? (
                <Stack className="gap-3">
                  <p className="text-[13.5px] leading-relaxed text-ink-dim">
                    Re-runs this run&apos;s {num(d.tests)} tests; if they still fail, sends the model the failure output, the top suspect&apos;s chain and source, and
                    read-only graph tools to follow callers and history further. It states the cause and evidence with its fix. The tests run again after each edit; an
                    edit that does not reduce failures is reverted. Up to 3 rounds.
                  </p>
                  {/* The only destructive thing in the product gets said plainly, before the button. */}
                  <Callout tone="warn" title="This writes to your working tree">
                    Edits land in the files on disk, not in a branch. Commit or stash anything you are not willing to lose first.
                  </Callout>
                </Stack>
              ) : (
                <HealTimeline repo={repo} steps={steps} live={healing} />
              )}
              {error && <ErrorNote error={error} className="mt-3" />}
              {result && <Verdict repo={repo} r={result} last={last?.run_id ?? null} />}
            </Sheet>

            {history.data && (
              <Sheet no="R · History" title="Recorded runs" tone="fragment" flush>
                <RunList repo={repo} runs={history.data.runs} current={id} />
              </Sheet>
            )}
          </Stack>
        </Cols>
      )}
    </Page>
  );
}

function RunSummary({ repo, d }: { repo: string; d: RunDetail }) {
  const runHref = runHrefFor(repo);
  const link = "font-mono text-ink hover:text-mark";
  return (
    <Sheet no="01 · Summary" title={d.trigger === "heal" ? `heal ${d.heal_step}${d.heal_round ? ` · round ${d.heal_round}` : ""}` : d.mode} tone="capture"
      action={
        d.failed > 0 ? (
          // Which evidence produced the ranking is a property of the answer, so it is on screen.
          <Chip tone={d.measured ? "info" : "neutral"}>{d.measured ? "ranked on measured coverage" : "ranked on the static graph"}</Chip>
        ) : null
      }
    >
      <Enter className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4 [&>*]:bg-sheet [&>*]:p-4">
        <Figure label="Failed" value={num(d.failed)} tone={d.failed ? "text-fail" : undefined} />
        <Figure label="Passed" value={num(d.passed)} tone="text-pass" />
        <Figure label="Skipped" value={num(d.skipped)} />
        <Figure label="Time" value={`${d.seconds.toFixed(1)}s`} />
      </Enter>
      <p className="mt-3 font-mono text-[11px] text-ink-faint">
        exit {d.exit_code} · {relTime(d.started)}
        {d.commit && <> · {d.commit.slice(0, 10)}</>}
      </p>

      {(d.parent || d.retries.length > 0 || d.changed.length > 0) && (
        <div className="mt-3 space-y-1 border-t border-line pt-3 text-[12.5px] text-ink-dim">
          {d.parent && (
            <p>
              Re-run of{" "}
              <Link className={link} href={runHref(d.parent)}>
                {d.parent.slice(-8)}
              </Link>
              {d.heal_suspect && (
                <>
                  {" "}
                  after editing <SymLink repo={repo} id={d.heal_suspect} className="text-[12.5px]" />
                </>
              )}
            </p>
          )}
          {d.retries.length > 0 && (
            <p>
              Re-run as{" "}
              {d.retries.map((x, i) => (
                <span key={x}>
                  {i > 0 && ", "}
                  <Link className={link} href={runHref(x)}>
                    {x.slice(-8)}
                  </Link>
                </span>
              ))}
            </p>
          )}
          {d.changed.length > 0 && (
            <p>
              Changed before this run:{" "}
              {d.changed
                .slice(0, 8)
                .map((c) => splitId(c)[1] || c)
                .join(", ")}
              {d.changed.length > 8 ? ` +${d.changed.length - 8}` : ""}
            </p>
          )}
        </div>
      )}

      {d.heal_why && <p className="mt-3 text-[13.5px] leading-relaxed whitespace-pre-line text-ink">{d.heal_why}</p>}
      {d.heal_diff && (
        <div className="mt-3">
          <CodeBlock code={d.heal_diff} diff title="the edit that was kept" maxHeight={256} />
        </div>
      )}
    </Sheet>
  );
}

function stepView(repo: string, s: Step, i: number): GtStep | null {
  const runHref = runHrefFor(repo);
  const key = String(i);
  switch (s.kind) {
    case "start":
      return { key, title: "Start", lit: true, body: <>Fixing with <Mono className="text-ink">{s.model}</Mono> via {s.backend === "claude-cli" ? "the claude CLI" : "the API"}</> };
    case "run":
      return { key, title: "Run", lit: true, body: <>Running {num(s.tests)} tests ({s.step}{s.round ? ` after round ${s.round}` : ""})…</> };
    case "ran":
      return {
        key,
        title: "Result",
        lit: true,
        fail: s.failed > 0,
        body: (
          <>
            <span className={s.failed ? "text-fail" : "text-pass"}>{num(s.failed)} failed</span>, {num(s.passed)} passed
            {s.run_id && (
              <>
                {" "}·{" "}
                <Link className="font-mono text-ink-dim hover:text-mark" href={runHref(s.run_id)}>
                  {s.run_id.slice(-8)}
                </Link>
              </>
            )}
          </>
        ),
      };
    case "suspect":
      return {
        key,
        title: "Suspect",
        lit: true,
        body: (
          <>
            <Mono className="text-ink">{s.name}</Mono> ({s.file}
            {s.line ? `:${s.line}` : ""}
            {s.hops !== undefined ? `, ${s.hops} hops` : ""})
          </>
        ),
      };
    case "asking":
      return { key, title: "Ask", lit: true, body: <>Asking the model to fix <Mono className="text-ink">{s.suspect}</Mono>, with the graph chain as context and the graph tools to look further…</> };
    case "round":
      return {
        key,
        title: `Round ${s.n}`,
        lit: true,
        fail: s.outcome !== "fixed" && s.outcome !== "partial",
        mark: (
          <>
            {s.before_failed} → {s.after_failed}
          </>
        ),
        body: (
          <span className="block">
            <span className={cn(s.outcome === "fixed" ? "text-pass" : s.outcome === "partial" ? "text-warn" : "text-fail")}>{OUTCOME[s.outcome] ?? s.outcome}</span>{" "}
            <span className="text-ink-faint">
              ({s.before_failed} → {s.after_failed} failing)
            </span>
            {s.tools && s.tools.length > 0 && (
              // What the model looked at is part of the evidence for its fix.
              <span className="mt-1 block text-[12px]">
                Looked up:{" "}
                {s.tools.map((t, j) => (
                  <Mono key={j}>
                    {j > 0 && ", "}
                    {t.name}(
                    {Object.entries(t.input ?? {})
                      .filter(([k]) => k !== "repo")
                      .map(([, v]) => (typeof v === "string" ? (v.split("::").pop() ?? v) : JSON.stringify(v)))
                      .join(" → ")}
                    )
                  </Mono>
                ))}
              </span>
            )}
            {s.explanation && <span className="mt-1.5 block text-[12.5px] leading-relaxed whitespace-pre-line text-ink">{s.explanation}</span>}
            {s.diff_preview && (
              <span className="mt-1.5 block">
                <CodeBlock code={s.diff_preview} diff maxHeight={224} />
              </span>
            )}
          </span>
        ),
      };
    default:
      return null;
  }
}

function HealTimeline({ repo, steps, live }: { repo: string; steps: Step[]; live: boolean }) {
  const items = steps.map((s, i) => stepView(repo, s, i)).filter((x): x is GtStep => x !== null);
  if (live) items.push({ key: "live", title: <span className="animate-blink">Working</span>, body: "the loop is running", lit: false });
  return <Steps steps={items} fill={live ? (items.length - 1) / Math.max(items.length, 1) : 1} live />;
}

const VERDICT: Record<string, string> = {
  fixed: "All failing tests now pass.",
  all_passed: "The tests already pass on re-run: the failure did not reproduce (flaky, or fixed since).",
  unresolved: "Some tests still fail. Edits that reduced failures are kept in the working tree; the rest were reverted.",
  no_tests: "No tests ran.",
};

function Verdict({ repo, r, last }: { repo: string; r: HealDone; last: string | null }) {
  const good = r.verdict === "fixed" || r.verdict === "all_passed";
  return (
    <Callout
      tone={good ? "mark" : "warn"}
      className="mt-4"
      icon={good ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
      title={
        <span className="flex items-center gap-2">
          {r.verdict.replace(/_/g, " ")}
          {r.initial && r.final && (
            <span className="ml-auto text-ink-dim">
              {r.initial.failed} → {r.final.failed} failing
            </span>
          )}
        </span>
      }
    >
      <p className="text-ink">
        {VERDICT[r.verdict] ?? ""} {r.note}
      </p>
      {last && (
        <Link className="mt-2 inline-block font-mono text-[11px] tracking-[.1em] text-mark uppercase hover:underline" href={runHrefFor(repo)(last)}>
          Open the last re-run →
        </Link>
      )}
    </Callout>
  );
}

/* ---------- ad-hoc: rank suspects for tests you name ---------- */

function Manual({ repo }: { repo: string }) {
  const [failing, setFailing] = useState<string[]>([]);
  const [changed, setChanged] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const run = useAction(api.culprit);
  const d = run.data;

  return (
    <>
      <Head
        no="04 · Culprit"
        title={
          <>
            Tests are failing. <em>Which code is to blame?</em>
          </>
        }
        lead="Rank the code your failing tests reach by spectrum-based fault localisation (Ochiai): symbols many failing tests reach and few passing tests reach rise to the top, and symbols you changed get a boost."
        meta={d ? [{ fig: num(d.suspects.length), label: "suspects" }, { fig: num(d.failing.length), label: "failing tests" }] : undefined}
      >
        {d && <Receipts r={d.receipts} />}
      </Head>

      <Stack>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (failing.length) run.run(repo, { failing, changed: changed.length ? changed : undefined });
          }}
        >
          <Sheet no="00 · Input" title="What is failing?" tone="commission" bodyClassName="flex flex-col gap-4">
            <div>
              <Label htmlFor="failing">Failing tests — a test function, or a test file for all of its tests</Label>
              <SymbolPicker id="failing" repo={repo} value={failing} onChange={setFailing} placeholder="test_checkout_applies_coupon, tests/test_cart.py…" />
            </div>
            <div>
              <Label htmlFor="changed">Recently changed (optional) — boosts what you touched</Label>
              <SymbolPicker id="changed" repo={repo} value={changed} onChange={setChanged} placeholder="What changed since the tests last passed?" />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={!failing.length || run.loading}>
                <Bug className="size-4" aria-hidden /> {run.loading ? "Ranking…" : "Find suspects"}
              </Button>
            </div>
          </Sheet>
        </form>

        {run.error ? (
          <ErrorNote error={run.error} />
        ) : run.loading && !d ? (
          <Measuring label="Ranking suspects" />
        ) : d ? (
          <Stack className={cn(run.loading && "opacity-60 transition-opacity")}>
            <ProblemList repo={repo} problems={d.problems} />
            <Sheet
              no="01 · Suspects"
              title={`Suspects · ${num(d.suspects.length)}`}
              action={<Mono className="min-w-0 text-[11px] whitespace-normal text-ink-faint [overflow-wrap:anywhere]">{d.method}</Mono>}
              note={`${d.failing.length} failing test${d.failing.length === 1 ? "" : "s"}. Every other test that reaches a suspect counts as passing.`}
              tone="library"
              flush
            >
              {d.suspects.length ? (
                <ul className="pb-2">
                  {d.suspects.map((s, i) => (
                    <SuspectRow key={s.id} repo={repo} s={s} rank={i + 1} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
                  ))}
                </ul>
              ) : (
                <p className="px-[clamp(14px,2vw,24px)] pb-5 text-[13px] text-ink-dim">
                  No suspects: the failing tests reach no resolved code. Their calls may go through fixtures, dynamic dispatch or names the resolver could not bind.
                </p>
              )}
            </Sheet>
            {d.unexplained?.length ? (
              // A test the change cannot explain is a finding, not noise.
              <Callout tone="warn" title="Not explained by the changed symbols">
                These failing tests reach none of what you listed as changed: {d.unexplained.map((u) => splitId(u)[1] || u).join(", ")}.
              </Callout>
            ) : null}
          </Stack>
        ) : (
          <Empty title="Paste the failing tests">
            Static reachability stands in for coverage, so no instrumented test run is needed. Runs started from the Tests page are recorded below and open here with their
            failures already filled in.
          </Empty>
        )}
      </Stack>
    </>
  );
}
