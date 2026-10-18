"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Bot, Bug, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Loader2, Stop } from "@/components/icons";
import { ProblemList } from "@/components/impact-view";
import { Empty, ErrorNote, Page, PageHeader, Receipts, Spinner, Stat, SymLink, Tile } from "@/components/kit";
import { RunList } from "@/components/run-list";
import { SuspectRow } from "@/components/suspect-row";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, healStreamUrl, type HealDone, type HealRound, type RunDetail, type TestRunSummary } from "@/lib/api";
import { num, relTime, splitId } from "@/lib/format";
import { type Query, useAction, useQuery, useRepo } from "@/lib/hooks";
import { postStream } from "@/lib/sse";
import { cn } from "@/lib/utils";

export default function CulpritPage() {
  const repo = useRepo();
  const run = useSearchParams().get("run");
  const history = useQuery(`runs:${repo}`, () => api.runs(repo, 15));
  return run ? (
    <RunView repo={repo} id={run} history={history} />
  ) : (
    <Page>
      <Manual repo={repo} />
      {history.data && history.data.runs.length > 0 && (
        <Tile title="Recorded runs" className="mt-6" bodyClassName="p-2">
          <RunList repo={repo} runs={history.data.runs} />
        </Tile>
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
  claude_error: "Claude returned no usable fix",
};

function RunView({ repo, id, history }: { repo: string; id: string; history: Query<{ runs: TestRunSummary[] }> }) {
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
    if (healing) return;
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

  // "Fix with AI" from the Tests page: start once, then drop the flag so a reload does not edit the code again
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
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Run <span className="font-mono text-mist">{id.slice(-8)}</span>
          </span>
        }
        sub="A recorded test run. Each failure is traced through the code graph to the symbols most likely to cause it; Claude can fix the top suspect with that chain and its source as context, then re-run the tests and keep the edit only if fewer tests fail."
      >
        {d?.culprits?.receipts && <Receipts r={d.culprits.receipts} />}
      </PageHeader>

      {detail.error ? (
        <ErrorNote error={detail.error} onRetry={detail.reload} />
      ) : !d ? (
        <Spinner label="Loading the run" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0 space-y-4">
            <RunSummary repo={repo} d={d} />
            {d.failures.length > 0 && (
              <Tile title={`Failures · ${d.failures.length}`} bodyClassName="p-2">
                <ul className="space-y-0.5">
                  {d.failures.map((f) => {
                    const h = d.history?.[f.test];
                    const isOpen = failOpen === f.nodeid;
                    return (
                      <li key={f.nodeid} className={cn("rounded-lg border border-transparent", isOpen && "border-graphite bg-white/[0.02]")}>
                        <button type="button" onClick={() => setFailOpen(isOpen ? null : f.nodeid)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.03]" aria-expanded={isOpen}>
                          {isOpen ? <ChevronDown className="size-3.5 shrink-0 text-fog" /> : <ChevronRight className="size-3.5 shrink-0 text-fog" />}
                          <CircleAlert className="size-3.5 shrink-0 text-coral-red" />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-paper">{f.nodeid}</span>
                          {f.when && f.when !== "call" && <span className="shrink-0 rounded bg-white/5 px-1.5 text-[10.5px] text-fog">{f.when}</span>}
                          {h ? (
                            <span className={cn("shrink-0 text-[11px]", h.failed === h.runs ? "text-coral-red" : h.failed ? "text-brand" : "text-fog")} title="the same test in earlier recorded runs">
                              {h.failed === h.runs ? "failing since recorded" : h.failed ? `flaky? ${h.failed}/${h.runs} failed` : `passed ${h.runs} earlier runs`}
                            </span>
                          ) : (
                            <span className="shrink-0 text-[11px] text-fog">first record</span>
                          )}
                        </button>
                        {isOpen && (
                          <div className="space-y-2 px-3 pb-3">
                            <SymLink repo={repo} id={f.test} className="text-[12px]" />
                            <pre className="max-h-72 overflow-auto rounded-md border border-graphite bg-black/30 p-3 font-mono text-[11.5px] whitespace-pre-wrap text-mist">{f.message || "(no message)"}</pre>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Tile>
            )}
            {d.culprits && (
              <Tile title={`Likely culprits · ${d.culprits.suspects.length}`} action={<span className="font-mono text-[11px] text-fog">{d.culprits.method}</span>} bodyClassName="p-2">
                <ProblemList repo={repo} problems={d.culprits.problems} />
                {d.culprits.suspects.length ? (
                  <ul className="space-y-0.5">
                    {d.culprits.suspects.map((s, i) => (
                      <SuspectRow key={s.id} repo={repo} s={s} rank={i + 1} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
                    ))}
                  </ul>
                ) : (
                  <p className="p-3 text-sm text-muted-foreground">No suspects: the failing tests reach no resolved code.</p>
                )}
                <p className="px-2 pt-2 text-[11px] text-fog">Open a suspect for its chain: the hops from a failing test to it, as the graph resolved them. That chain and the source along it are what Claude is given.</p>
              </Tile>
            )}
            {d.output_tail && (
              <Tile title="pytest output" bodyClassName="p-2">
                <pre className="max-h-72 overflow-auto rounded-md bg-black/30 p-3 font-mono text-[11.5px] whitespace-pre-wrap text-mist">{d.output_tail}</pre>
              </Tile>
            )}
          </div>

          <div className="min-w-0 space-y-4 lg:sticky lg:top-20 lg:self-start">
            <Tile
              title="Fix with AI"
              action={
                healing ? (
                  <Button size="sm" variant="outline" onClick={() => abort.current?.abort()} title="Stops watching; a fix already in progress finishes and is recorded">
                    <Stop className="size-3.5" /> Stop watching
                  </Button>
                ) : (
                  <Button size="sm" onClick={heal} disabled={!canHeal}>
                    <Bot className="size-3.5" /> {result ? "Try again" : "Fix with AI"}
                  </Button>
                )
              }
            >
              {!runtime.data?.enabled ? (
                <p className="text-sm text-muted-foreground">{runtime.data?.reason ?? "Running tests from the browser is off."} Start the API with AFTERSHOCK_ALLOW_RUN=1 to re-run and fix from here.</p>
              ) : !d.failed ? (
                <p className="text-sm text-muted-foreground">Nothing to fix: this run had no failing tests.</p>
              ) : !steps.length && !error && !result ? (
                <p className="text-sm text-muted-foreground">
                  Re-runs this run&apos;s {num(d.tests)} tests; if they still fail, sends Claude the failure output, the top suspect&apos;s chain and source, and read-only graph tools to follow callers and history further; it states the cause and evidence with its fix. The tests run again after each edit; an edit that does not reduce failures is reverted. Up to 3 rounds. Edits are written to the working tree.
                </p>
              ) : (
                <HealTimeline repo={repo} steps={steps} live={healing} />
              )}
              {error && <ErrorNote error={error} className="mt-3" />}
              {result && <Verdict repo={repo} r={result} last={last?.run_id ?? null} />}
            </Tile>
            {history.data && (
              <Tile title="Recorded runs" bodyClassName="p-2">
                <RunList repo={repo} runs={history.data.runs} current={id} />
              </Tile>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

function RunSummary({ repo, d }: { repo: string; d: RunDetail }) {
  const runHref = (x: string) => `/r/${encodeURIComponent(repo)}/culprit?run=${x}`;
  return (
    <div className="epi-in rounded-xl border border-border bg-card/50 p-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
        <Stat label="Failed" value={num(d.failed)} tone={d.failed ? "text-coral-red" : undefined} />
        <Stat label="Passed" value={num(d.passed)} tone="text-signal-teal" />
        <Stat label="Skipped" value={num(d.skipped)} />
        <Stat label="Time" value={`${d.seconds.toFixed(1)}s`} />
        <div className="ml-auto text-right text-xs text-fog">
          <div>
            {d.trigger === "heal" ? `heal ${d.heal_step}${d.heal_round ? ` · round ${d.heal_round}` : ""}` : d.mode} · exit {d.exit_code} · {relTime(d.started)}
          </div>
          {d.failed > 0 && <div title={d.measured ? "Ran under per-test coverage: suspects are ranked on the code each test executed" : "Suspects are ranked on the static call graph; a run with `coverage` installed in the repo's environment is measured"}>
            {d.measured ? "ranked on measured coverage" : "ranked on the static graph"}
          </div>}
          {d.commit && <div className="font-mono">{d.commit.slice(0, 10)}</div>}
        </div>
      </div>
      {(d.parent || d.retries.length > 0 || d.changed.length > 0) && (
        <div className="mt-3 space-y-1 border-t border-border/70 pt-3 text-xs text-fog">
          {d.parent && (
            <p>
              Re-run of{" "}
              <Link className="font-mono text-mist hover:text-paper" href={runHref(d.parent)}>
                {d.parent.slice(-8)}
              </Link>
              {d.heal_suspect && (
                <>
                  {" "}after editing <SymLink repo={repo} id={d.heal_suspect} className="text-[12px]" />
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
                  <Link className="font-mono text-mist hover:text-paper" href={runHref(x)}>
                    {x.slice(-8)}
                  </Link>
                </span>
              ))}
            </p>
          )}
          {d.changed.length > 0 && <p>Changed before this run: {d.changed.slice(0, 8).map((c) => splitId(c)[1] || c).join(", ")}{d.changed.length > 8 ? ` +${d.changed.length - 8}` : ""}</p>}
        </div>
      )}
      {d.heal_why && <p className="mt-3 text-[12.5px] leading-relaxed whitespace-pre-line text-mist">{d.heal_why}</p>}
      {d.heal_diff && <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-graphite bg-black/30 p-3 font-mono text-[11.5px] whitespace-pre text-mist">{d.heal_diff}</pre>}
    </div>
  );
}

function HealTimeline({ repo, steps, live }: { repo: string; steps: Step[]; live: boolean }) {
  const runHref = (x: string) => `/r/${encodeURIComponent(repo)}/culprit?run=${x}`;
  return (
    <ol className="space-y-2 text-[12.5px]" aria-live="polite">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-fog/60" />
          <div className="min-w-0 flex-1 text-mist">
            {s.kind === "start" ? (
              <>
                Fixing with <span className="font-mono">{s.model}</span> via {s.backend === "claude-cli" ? "the claude CLI" : "the API"}
              </>
            ) : s.kind === "run" ? (
              <>Running {num(s.tests)} tests ({s.step}{s.round ? ` after round ${s.round}` : ""})…</>
            ) : s.kind === "ran" ? (
              <>
                <span className={s.failed ? "text-coral-red" : "text-signal-teal"}>{num(s.failed)} failed</span>, {num(s.passed)} passed
                {s.run_id && (
                  <>
                    {" "}·{" "}
                    <Link className="font-mono text-fog hover:text-paper" href={runHref(s.run_id)}>
                      {s.run_id.slice(-8)}
                    </Link>
                  </>
                )}
              </>
            ) : s.kind === "suspect" ? (
              <>
                Top suspect <span className="font-mono text-paper">{s.name}</span> <span className="text-fog">({s.file}{s.line ? `:${s.line}` : ""}{s.hops !== undefined ? `, ${s.hops} hops` : ""})</span>
              </>
            ) : s.kind === "asking" ? (
              <>
                Asking Claude to fix <span className="font-mono">{s.suspect}</span>, with the graph chain as context and the graph tools to look further…
              </>
            ) : s.kind === "round" ? (
              <div>
                <span className={cn(s.outcome === "fixed" ? "text-signal-teal" : s.outcome === "partial" ? "text-brand" : "text-coral-red")}>
                  Round {s.n}: {OUTCOME[s.outcome] ?? s.outcome}
                </span>{" "}
                <span className="text-fog">
                  ({s.before_failed} → {s.after_failed} failing)
                </span>
                {s.tools && s.tools.length > 0 && (
                  <p className="mt-1 text-[11.5px] text-fog">
                    Looked up:{" "}
                    {s.tools.map((t, j) => (
                      <span key={j} className="font-mono">
                        {j > 0 && ", "}
                        {t.name}({Object.entries(t.input ?? {}).filter(([k]) => k !== "repo").map(([, v]) => (typeof v === "string" ? (v.split("::").pop() ?? v) : JSON.stringify(v))).join(" → ")})
                      </span>
                    ))}
                  </p>
                )}
                {s.explanation && <p className="mt-1.5 text-[12px] leading-relaxed whitespace-pre-line text-mist">{s.explanation}</p>}
                {s.diff_preview && <pre className="mt-1.5 max-h-56 overflow-auto rounded-md border border-graphite bg-black/30 p-2 font-mono text-[11px] whitespace-pre text-mist">{s.diff_preview}</pre>}
              </div>
            ) : null}
          </div>
        </li>
      ))}
      {live && (
        <li className="flex items-center gap-2 text-fog">
          <Loader2 className="size-3.5 animate-spin" /> working
        </li>
      )}
    </ol>
  );
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
    <div className={cn("mt-3 rounded-lg border p-3 text-sm", good ? "border-signal-teal/30 bg-signal-teal/[0.06]" : "border-border bg-white/[0.02]")}>
      <div className="flex items-center gap-2 text-paper">
        {good ? <CircleCheck className="size-4 text-signal-teal" /> : <CircleAlert className="size-4 text-brand" />}
        {r.verdict.replace(/_/g, " ")}
        {r.initial && r.final && (
          <span className="ml-auto font-mono text-[11px] text-fog">
            {r.initial.failed} → {r.final.failed} failing
          </span>
        )}
      </div>
      <p className="mt-1 text-[12.5px] text-mist">{VERDICT[r.verdict] ?? ""} {r.note}</p>
      {last && (
        <Link className="mt-2 inline-block text-[12px] text-brand hover:underline" href={`/r/${encodeURIComponent(repo)}/culprit?run=${last}`}>
          Open the last re-run →
        </Link>
      )}
    </div>
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
      <PageHeader
        title="Culprit"
        sub="Tests are failing. Rank the code they reach by spectrum-based fault localization (Ochiai): symbols many failing tests reach and few passing tests reach rise to the top; symbols you changed get a boost."
      >
        {d && <Receipts r={d.receipts} />}
      </PageHeader>
      <form
        className="mb-6 space-y-3 rounded-xl border border-border bg-card/50 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (failing.length) run.run(repo, { failing, changed: changed.length ? changed : undefined });
        }}
      >
        <div>
          <Label htmlFor="failing" className="mb-1.5 text-xs text-fog">
            Failing tests <span className="text-fog/80">(test functions, or a test file for all of its tests)</span>
          </Label>
          <SymbolPicker id="failing" repo={repo} value={failing} onChange={setFailing} placeholder="test_checkout_applies_coupon, tests/test_cart.py…" />
        </div>
        <div>
          <Label htmlFor="changed" className="mb-1.5 text-xs text-fog">
            Recently changed <span className="text-fog/80">(optional)</span>
          </Label>
          <SymbolPicker id="changed" repo={repo} value={changed} onChange={setChanged} placeholder="What changed since the tests last passed?" />
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={!failing.length || run.loading}>
            <Bug className="size-4" /> {run.loading ? "Ranking…" : "Find suspects"}
          </Button>
        </div>
      </form>

      {run.error ? (
        <ErrorNote error={run.error} />
      ) : run.loading && !d ? (
        <Spinner label="Ranking suspects" />
      ) : d ? (
        <div className={cn("space-y-4", run.loading && "opacity-60")}>
          <ProblemList repo={repo} problems={d.problems} />
          <Tile title={`Suspects · ${d.suspects.length}`} action={<span className="font-mono text-[11px] text-fog">{d.method}</span>} bodyClassName="p-2">
            {d.suspects.length ? (
              <ul className="space-y-0.5">
                {d.suspects.map((s, i) => (
                  <SuspectRow key={s.id} repo={repo} s={s} rank={i + 1} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
                ))}
              </ul>
            ) : (
              <p className="p-3 text-sm text-muted-foreground">
                No suspects: the failing tests reach no resolved code. Their calls may go through fixtures, dynamic dispatch or names the resolver could not bind.
              </p>
            )}
          </Tile>
          {d.unexplained?.length ? (
            <p className="text-xs text-fog">
              These failing tests reach none of the changed symbols, so the change may not explain them:{" "}
              {d.unexplained.map((u) => splitId(u)[1] || u).join(", ")}.
            </p>
          ) : null}
          <p className="text-xs text-fog">
            {d.failing.length} failing test{d.failing.length === 1 ? "" : "s"}. Every other test that reaches a suspect counts as passing. {d.method}.
          </p>
        </div>
      ) : (
        <Empty title="Paste the failing tests" icon={<Bug className="size-6" />}>
          Static reachability stands in for coverage, so no instrumented test run is needed. Runs from the Tests page are recorded below and open here with their failures already filled in.
        </Empty>
      )}
    </>
  );
}
