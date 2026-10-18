"use client";

/**
 * Culprit: tests are failing — which symbol is to blame?
 *
 * The page has two shapes. Without `?run=`, it ranks suspects for tests you
 * name by hand. With one, it opens a recorded run: its failures, its ranked
 * suspects, its lineage, and the fix loop.
 *
 * Two things this page must never get wrong.
 *
 * **It is the one surface in Aftershock that writes to your files.** Everything
 * else only reads the graph. So the fix loop states, before you press anything,
 * exactly what it will do — re-run, ask the model, write to the working tree,
 * re-run again, revert an edit that did not help — and the stream shows each of
 * those as it happens rather than reporting at the end.
 *
 * **Measured and inferred evidence are labelled differently.** A run recorded
 * under per-test coverage ranks suspects on code the tests actually executed; a
 * run without it falls back to the static call graph. Those are not equally
 * strong claims, and the summary says which one produced the ranking.
 */

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  Callout,
  Chip,
  CodeBlock,
  Empty,
  ErrorNote,
  Eyebrow,
  Grid,
  Metric,
  Mono,
  Page,
  PageHeader,
  Panel,
  Spinner,
  Stack,
} from "@/components/ds";
import { Bot, Bug, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Loader2, Stop } from "@/components/icons";
import { ProblemList } from "@/components/impact-view";
import { Receipts, SymLink } from "@/components/kit";
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
        <Panel title="Recorded runs" className="mt-6" bodyClassName="p-2">
          <RunList repo={repo} runs={history.data.runs} />
        </Panel>
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
          else if (["start", "run", "ran", "suspect", "asking", "round"].includes(event))
            setSteps((s) => [...s, { kind: event, ...x } as Step]);
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
      <PageHeader
        eyebrow="Recorded run"
        title={<Mono className="text-heading text-ink-strong">{id.slice(-8)}</Mono>}
        sub="Each failure is traced through the code graph to the symbols most likely to cause it. The fix loop sends the top suspect's chain and source to a model, writes its edit to the working tree, re-runs the tests, and keeps the edit only if fewer tests fail."
      >
        {d?.culprits?.receipts && <Receipts r={d.culprits.receipts} />}
      </PageHeader>

      {detail.error ? (
        <ErrorNote error={detail.error} onRetry={detail.reload} />
      ) : !d ? (
        <Spinner label="Loading the run" />
      ) : (
        <Grid cols="main-aside">
          <Stack className="min-w-0 gap-4">
            <RunSummary repo={repo} d={d} />

            {d.failures.length > 0 && (
              <Panel title={`Failures · ${num(d.failures.length)}`} bodyClassName="p-2">
                <ul className="space-y-0.5">
                  {d.failures.map((f) => {
                    const h = d.history?.[f.test];
                    const isOpen = failOpen === f.nodeid;
                    const Chevron = isOpen ? ChevronDown : ChevronRight;
                    return (
                      <li
                        key={f.nodeid}
                        className={cn(
                          "rounded-panel border border-transparent",
                          isOpen && "border-line bg-surface-raised",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setFailOpen(isOpen ? null : f.nodeid)}
                          className="flex w-full items-center gap-2 rounded-panel px-2 py-1.5 text-left hover:bg-accent"
                          aria-expanded={isOpen}
                        >
                          <Chevron className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                          <CircleAlert className="size-3.5 shrink-0 text-fail" aria-hidden />
                          <span className="min-w-0 flex-1 truncate font-mono text-caption text-ink-strong">
                            {f.nodeid}
                          </span>
                          {/* A failure in setup or teardown is a different bug from a
                              failure in the test body, so the phase is never hidden. */}
                          {f.when && f.when !== "call" && (
                            <Chip size="sm" tone="neutral">
                              {f.when}
                            </Chip>
                          )}
                          {/* History separates "broken since we started recording" from
                              "fails one run in four", which is the flakiness question. */}
                          {h ? (
                            <span
                              className={cn(
                                "shrink-0 text-micro",
                                h.failed === h.runs ? "text-fail" : h.failed ? "text-warn" : "text-ink-faint",
                              )}
                            >
                              {h.failed === h.runs
                                ? "failing since recorded"
                                : h.failed
                                  ? `flaky? ${h.failed}/${h.runs} failed`
                                  : `passed ${h.runs} earlier runs`}
                            </span>
                          ) : (
                            <span className="shrink-0 text-micro text-ink-faint">first record</span>
                          )}
                        </button>
                        {isOpen && (
                          <div className="space-y-2 px-3 pb-3">
                            <SymLink repo={repo} id={f.test} className="text-caption" />
                            <CodeBlock code={f.message || "(no message)"} maxHeight={288} wrap noCopy={!f.message} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Panel>
            )}

            {d.culprits && (
              <Panel
                title={`Likely culprits · ${num(d.culprits.suspects.length)}`}
                action={<Mono className="text-micro text-ink-faint">{d.culprits.method}</Mono>}
                note="Open a suspect for its chain — the hops from a failing test to it, as the graph resolved them. That chain and the source along it are what the model is given."
                bodyClassName="p-2"
              >
                <ProblemList repo={repo} problems={d.culprits.problems} />
                {d.culprits.suspects.length ? (
                  <ul className="space-y-0.5">
                    {d.culprits.suspects.map((s, i) => (
                      <SuspectRow
                        key={s.id}
                        repo={repo}
                        s={s}
                        rank={i + 1}
                        open={open === s.id}
                        onToggle={() => setOpen(open === s.id ? null : s.id)}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="p-3 text-body-sm text-ink-muted">
                    No suspects: the failing tests reach no resolved code.
                  </p>
                )}
              </Panel>
            )}

            {d.output_tail && (
              <Panel title="pytest output" flush>
                <CodeBlock code={d.output_tail} maxHeight={288} wrap />
              </Panel>
            )}
          </Stack>

          <Stack className="min-w-0 gap-4 lg:sticky lg:top-20 lg:self-start">
            <Panel
              title="Fix with AI"
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
                <p className="text-body-sm text-ink-muted">
                  {runtime.data?.reason ?? "Running tests from the browser is off."} Start the API with{" "}
                  <code className="font-mono">AFTERSHOCK_ALLOW_RUN=1</code> to re-run and fix from here.
                </p>
              ) : !d.failed ? (
                <p className="text-body-sm text-ink-muted">Nothing to fix: this run had no failing tests.</p>
              ) : !steps.length && !error && !result ? (
                <Stack className="gap-3">
                  <p className="text-body-sm text-ink-muted">
                    Re-runs this run&apos;s {num(d.tests)} tests; if they still fail, sends the model the failure
                    output, the top suspect&apos;s chain and source, and read-only graph tools to follow callers and
                    history further. It states the cause and evidence with its fix. The tests run again after each
                    edit; an edit that does not reduce failures is reverted. Up to 3 rounds.
                  </p>
                  {/* The only destructive thing in the product gets said plainly,
                      before the button, not in a footnote after it. */}
                  <Callout tone="warn" title="This writes to your working tree">
                    Edits land in the files on disk, not in a branch. Commit or stash anything you are not willing to
                    lose first.
                  </Callout>
                </Stack>
              ) : (
                <HealTimeline repo={repo} steps={steps} live={healing} />
              )}
              {error && <ErrorNote error={error} className="mt-3" />}
              {result && <Verdict repo={repo} r={result} last={last?.run_id ?? null} />}
            </Panel>

            {history.data && (
              <Panel title="Recorded runs" bodyClassName="p-2">
                <RunList repo={repo} runs={history.data.runs} current={id} />
              </Panel>
            )}
          </Stack>
        </Grid>
      )}
    </Page>
  );
}

function RunSummary({ repo, d }: { repo: string; d: RunDetail }) {
  const runHref = (x: string) => `/r/${encodeURIComponent(repo)}/culprit?run=${x}`;
  return (
    <div className="as-in rounded-panel border border-line bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
        <Metric size="sm" label="Failed" value={num(d.failed)} tone={d.failed ? "text-fail" : undefined} />
        <Metric size="sm" label="Passed" value={num(d.passed)} tone="text-pass" />
        <Metric size="sm" label="Skipped" value={num(d.skipped)} />
        <Metric size="sm" label="Time" value={`${d.seconds.toFixed(1)}s`} />
        <div className="ml-auto space-y-1 text-right text-caption text-ink-muted">
          <div>
            {d.trigger === "heal"
              ? `heal ${d.heal_step}${d.heal_round ? ` · round ${d.heal_round}` : ""}`
              : d.mode}{" "}
            · exit {d.exit_code} · {relTime(d.started)}
          </div>
          {d.failed > 0 && (
            // Which evidence produced the ranking is a property of the answer, so
            // it is stated on screen rather than hidden in a tooltip.
            <Chip tone={d.measured ? "info" : "neutral"} size="sm">
              {d.measured ? "ranked on measured coverage" : "ranked on the static graph"}
            </Chip>
          )}
          {d.commit && <Mono className="block text-micro text-ink-faint">{d.commit.slice(0, 10)}</Mono>}
        </div>
      </div>

      {(d.parent || d.retries.length > 0 || d.changed.length > 0) && (
        <div className="mt-3 space-y-1 border-t border-line pt-3 text-caption text-ink-muted">
          {d.parent && (
            <p>
              Re-run of{" "}
              <Link className="font-mono text-ink hover:text-ink-strong" href={runHref(d.parent)}>
                {d.parent.slice(-8)}
              </Link>
              {d.heal_suspect && (
                <>
                  {" "}
                  after editing <SymLink repo={repo} id={d.heal_suspect} className="text-caption" />
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
                  <Link className="font-mono text-ink hover:text-ink-strong" href={runHref(x)}>
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

      {d.heal_why && <p className="mt-3 text-body-sm leading-relaxed whitespace-pre-line text-ink">{d.heal_why}</p>}
      {d.heal_diff && (
        <div className="mt-3">
          <CodeBlock code={d.heal_diff} diff title="the edit that was kept" maxHeight={256} />
        </div>
      )}
    </div>
  );
}

function HealTimeline({ repo, steps, live }: { repo: string; steps: Step[]; live: boolean }) {
  const runHref = (x: string) => `/r/${encodeURIComponent(repo)}/culprit?run=${x}`;
  return (
    <ol className="space-y-2 text-body-sm" aria-live="polite">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink-faint/60" aria-hidden />
          <div className="min-w-0 flex-1 text-ink">
            {s.kind === "start" ? (
              <>
                Fixing with <Mono>{s.model}</Mono> via {s.backend === "claude-cli" ? "the claude CLI" : "the API"}
              </>
            ) : s.kind === "run" ? (
              <>
                Running {num(s.tests)} tests ({s.step}
                {s.round ? ` after round ${s.round}` : ""})…
              </>
            ) : s.kind === "ran" ? (
              <>
                <span className={s.failed ? "text-fail" : "text-pass"}>{num(s.failed)} failed</span>,{" "}
                {num(s.passed)} passed
                {s.run_id && (
                  <>
                    {" "}
                    ·{" "}
                    <Link className="font-mono text-ink-muted hover:text-ink-strong" href={runHref(s.run_id)}>
                      {s.run_id.slice(-8)}
                    </Link>
                  </>
                )}
              </>
            ) : s.kind === "suspect" ? (
              <>
                Top suspect <Mono className="text-ink-strong">{s.name}</Mono>{" "}
                <span className="text-ink-muted">
                  ({s.file}
                  {s.line ? `:${s.line}` : ""}
                  {s.hops !== undefined ? `, ${s.hops} hops` : ""})
                </span>
              </>
            ) : s.kind === "asking" ? (
              <>
                Asking the model to fix <Mono>{s.suspect}</Mono>, with the graph chain as context and the graph tools
                to look further…
              </>
            ) : s.kind === "round" ? (
              <div>
                <span
                  className={cn(
                    s.outcome === "fixed" ? "text-pass" : s.outcome === "partial" ? "text-warn" : "text-fail",
                  )}
                >
                  Round {s.n}: {OUTCOME[s.outcome] ?? s.outcome}
                </span>{" "}
                <span className="text-ink-muted">
                  ({s.before_failed} → {s.after_failed} failing)
                </span>
                {s.tools && s.tools.length > 0 && (
                  // What the model looked at is part of the evidence for its fix.
                  <p className="mt-1 text-caption text-ink-muted">
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
                  </p>
                )}
                {s.explanation && (
                  <p className="mt-1.5 text-caption leading-relaxed whitespace-pre-line text-ink">{s.explanation}</p>
                )}
                {s.diff_preview && (
                  <div className="mt-1.5">
                    <CodeBlock code={s.diff_preview} diff maxHeight={224} />
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </li>
      ))}
      {live && (
        <li className="flex items-center gap-2 text-ink-muted">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> working
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
    <div
      className={cn(
        "mt-3 rounded-panel border p-3 text-body-sm",
        good ? "border-pass/30 bg-pass/[0.06]" : "border-line bg-surface-raised",
      )}
    >
      <div className="flex items-center gap-2 text-ink-strong">
        {good ? (
          <CircleCheck className="size-4 text-pass" aria-hidden />
        ) : (
          <CircleAlert className="size-4 text-warn" aria-hidden />
        )}
        {r.verdict.replace(/_/g, " ")}
        {r.initial && r.final && (
          <Mono className="ml-auto text-micro text-ink-muted">
            {r.initial.failed} → {r.final.failed} failing
          </Mono>
        )}
      </div>
      <p className="mt-1 text-body-sm text-ink">
        {VERDICT[r.verdict] ?? ""} {r.note}
      </p>
      {last && (
        <Link
          className="mt-2 inline-block text-caption text-brand hover:underline"
          href={`/r/${encodeURIComponent(repo)}/culprit?run=${last}`}
        >
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
        sub="Rank the code your failing tests reach by spectrum-based fault localisation (Ochiai): symbols many failing tests reach and few passing tests reach rise to the top, and symbols you changed get a boost."
      >
        {d && <Receipts r={d.receipts} />}
      </PageHeader>

      <Stack className="gap-[var(--section-gap)]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (failing.length) run.run(repo, { failing, changed: changed.length ? changed : undefined });
          }}
        >
          <Panel title="What is failing?" bodyClassName="flex flex-col gap-3">
            <div>
              <Label htmlFor="failing" className="mb-1.5 block">
                <Eyebrow>Failing tests — a test function, or a test file for all of its tests</Eyebrow>
              </Label>
              <SymbolPicker
                id="failing"
                repo={repo}
                value={failing}
                onChange={setFailing}
                placeholder="test_checkout_applies_coupon, tests/test_cart.py…"
              />
            </div>
            <div>
              <Label htmlFor="changed" className="mb-1.5 block">
                <Eyebrow>Recently changed (optional) — boosts what you touched</Eyebrow>
              </Label>
              <SymbolPicker
                id="changed"
                repo={repo}
                value={changed}
                onChange={setChanged}
                placeholder="What changed since the tests last passed?"
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={!failing.length || run.loading}>
                <Bug className="size-4" aria-hidden /> {run.loading ? "Ranking…" : "Find suspects"}
              </Button>
            </div>
          </Panel>
        </form>

        {run.error ? (
          <ErrorNote error={run.error} />
        ) : run.loading && !d ? (
          <Spinner label="Ranking suspects" />
        ) : d ? (
          <Stack className={cn("gap-4", run.loading && "opacity-60")}>
            <ProblemList repo={repo} problems={d.problems} />
            <Panel
              title={`Suspects · ${num(d.suspects.length)}`}
              action={<Mono className="text-micro text-ink-faint">{d.method}</Mono>}
              note={`${d.failing.length} failing test${d.failing.length === 1 ? "" : "s"}. Every other test that reaches a suspect counts as passing.`}
              bodyClassName="p-2"
            >
              {d.suspects.length ? (
                <ul className="space-y-0.5">
                  {d.suspects.map((s, i) => (
                    <SuspectRow
                      key={s.id}
                      repo={repo}
                      s={s}
                      rank={i + 1}
                      open={open === s.id}
                      onToggle={() => setOpen(open === s.id ? null : s.id)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="p-3 text-body-sm text-ink-muted">
                  No suspects: the failing tests reach no resolved code. Their calls may go through fixtures, dynamic
                  dispatch or names the resolver could not bind.
                </p>
              )}
            </Panel>
            {d.unexplained?.length ? (
              // A test the change cannot explain is a finding, not noise — it means
              // either a second bug or a wrong assumption about what changed.
              <Callout tone="warn" title="Not explained by the changed symbols">
                These failing tests reach none of what you listed as changed:{" "}
                {d.unexplained.map((u) => splitId(u)[1] || u).join(", ")}.
              </Callout>
            ) : null}
          </Stack>
        ) : (
          <Empty title="Paste the failing tests" icon={<Bug className="size-6" aria-hidden />}>
            Static reachability stands in for coverage, so no instrumented test run is needed. Runs started from the
            Tests page are recorded below and open here with their failures already filled in.
          </Empty>
        )}
      </Stack>
    </>
  );
}
