"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { ArrowRight, Bot, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Loader2, Play, Stop, TestTube, Terminal } from "@/components/icons";
import { CopyButton, Empty, ErrorNote, FileLink, Page, PageHeader, Receipts, Spinner, Stat, SymLink, Tile } from "@/components/kit";
import { RunList } from "@/components/run-list";
import { SuspectRow } from "@/components/suspect-row";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, runStreamUrl, type RunDone, type RunMode, type RunSelected, type TestRow } from "@/lib/api";
import { ms, num } from "@/lib/format";
import { useQuery, useRepo } from "@/lib/hooks";
import { postStream } from "@/lib/sse";
import { cn } from "@/lib/utils";

const MODES: { key: RunMode; label: string; hint: string }[] = [
  { key: "diff", label: "Working tree", hint: "the tests your uncommitted changes reach" },
  { key: "targets", label: "Symbols", hint: "the tests that reach the symbols you pick" },
  { key: "all", label: "Whole suite", hint: "every test, no selection" },
  { key: "coverage", label: "Record coverage", hint: "whole suite under per-test coverage; later selections use it" },
];

type Filter = "all" | "failed" | "passed" | "skipped";
type Phase = "idle" | "running" | "done" | "error" | "stopped";

/** One row per test: a failing setup/teardown row beats a passing call row. */
function fold(rows: TestRow[]): Map<string, TestRow> {
  const out = new Map<string, TestRow>();
  for (const r of rows) {
    const prev = out.get(r.nodeid);
    if (!prev || r.outcome === "failed" || (prev.outcome === "passed" && r.outcome === "skipped")) out.set(r.nodeid, r);
  }
  return out;
}

/** The last line of a pytest failure is usually the assertion (`E   assert 2 == 3`). */
const headline = (m = "") => m.trim().split("\n").filter((l) => l.trim()).at(-1)?.replace(/^E\s+/, "") ?? "";

function ResultRow({ repo, r, open, onToggle }: { repo: string; r: TestRow; open: boolean; onToggle: () => void }) {
  const failed = r.outcome === "failed";
  const [file, ...rest] = r.nodeid.split("::");
  return (
    <li className={cn("rounded-lg", open && "bg-white/[0.02]")}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!r.message}
        aria-expanded={r.message ? open : undefined}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left enabled:hover:bg-white/[0.03]"
      >
        {failed ? (
          <CircleAlert className="size-4 shrink-0 text-coral-red" aria-label="failed" />
        ) : r.outcome === "skipped" ? (
          <span className="grid size-4 shrink-0 place-items-center font-mono text-[11px] text-fog" aria-label="skipped">
            –
          </span>
        ) : (
          <CircleCheck className="size-4 shrink-0 text-signal-teal" aria-label="passed" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
          <span className="text-fog">{file}::</span>
          <span className={failed ? "text-paper" : "text-mist"}>{rest.join("::")}</span>
          {r.when !== "call" && <span className="ml-1.5 text-[10.5px] text-brand">in {r.when}</span>}
        </span>
        {failed && !open && <span className="hidden max-w-[40%] truncate font-mono text-[11px] text-coral-red/80 md:inline">{headline(r.message)}</span>}
        <span className="w-14 shrink-0 text-right font-mono text-[11px] text-fog tabular-nums">{ms(r.seconds * 1000)}</span>
        {r.message ? open ? <ChevronDown className="size-3.5 shrink-0 text-fog" /> : <ChevronRight className="size-3.5 shrink-0 text-fog" /> : <span className="size-3.5 shrink-0" />}
      </button>
      {open && r.message && (
        <div className="px-2 pb-2 pl-8">
          <pre className="max-h-80 overflow-auto rounded-md border border-graphite bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-mist">{r.message}</pre>
          <div className="mt-1.5">
            <FileLink repo={repo} path={file} className="text-[11px]" />
          </div>
        </div>
      )}
    </li>
  );
}

/** Pass / fail / skip as one segmented bar; the unfilled rest is what is still to run. */
function Progress({ passed, failed, skipped, total, live }: { passed: number; failed: number; skipped: number; total: number; live: boolean }) {
  const of = Math.max(total, passed + failed + skipped, 1);
  const w = (n: number) => `${(100 * n) / of}%`;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={passed + failed + skipped}>
      <div className="flex h-full">
        <div className="bg-signal-teal transition-[width] duration-300" style={{ width: w(passed) }} />
        <div className="bg-coral-red transition-[width] duration-300" style={{ width: w(failed) }} />
        <div className="bg-fog/50 transition-[width] duration-300" style={{ width: w(skipped) }} />
        {live && <div className="h-full flex-1 animate-pulse bg-white/[0.04]" />}
      </div>
    </div>
  );
}

function Disabled({ repo, reason }: { repo: string; reason: string | null }) {
  const cmd = `AFTERSHOCK_ALLOW_RUN=1 aftershock serve`;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card/50 p-5">
        <div className="mb-1 flex items-center gap-2 text-sm text-paper">
          <Terminal className="size-4 text-brand" /> Running tests from the browser is off
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {reason ?? "The API refused."} Running a repo&apos;s tests executes its code, so it is opt-in and only works from the machine the API runs on.
        </p>
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-graphite bg-black/30 px-3 py-2 font-mono text-[12.5px] text-mist">{cmd}</code>
            <CopyButton text={cmd} />
          </div>
          <p className="text-xs text-fog">Or from a terminal, without the UI:</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-graphite bg-black/30 px-3 py-2 font-mono text-[12.5px] text-mist">aftershock run {repo} --diff</code>
            <CopyButton text={`aftershock run ${repo} --diff`} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TestsPage() {
  const repo = useRepo();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const runtime = useQuery("runtime", api.runtime);
  const history = useQuery(`runs:${repo}`, () => api.runs(repo, 10));
  const [mode, setMode] = useState<RunMode>(() => (MODES.some((m) => m.key === sp.get("mode")) ? (sp.get("mode") as RunMode) : "diff"));
  const [targets, setTargets] = useState<string[]>(() => sp.getAll("t"));
  const rev = sp.get("rev") || undefined; // from the Diff page's Run link: compare against this ref, not HEAD
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<RunSelected>();
  const [rows, setRows] = useState<TestRow[]>([]);
  const [done, setDone] = useState<RunDone>();
  const [stage, setStage] = useState<string>();
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [suspect, setSuspect] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const buffer = useRef<TestRow[]>([]);

  const running = phase === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (buffer.current.length) {
        const add = buffer.current;
        buffer.current = [];
        setRows((r) => [...r, ...add]); // batched: a fast suite reports hundreds of rows a second
      }
    }, 250);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    if (mode === "targets" && !targets.length) return;
    const qs = new URLSearchParams({ mode });
    if (mode === "targets") targets.forEach((t) => qs.append("t", t));
    if (mode === "diff" && rev) qs.set("rev", rev);
    router.replace(`${pathname}?${qs}`, { scroll: false });
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    buffer.current = [];
    setRows([]);
    setSelected(undefined);
    setDone(undefined);
    setError(undefined);
    setStage(undefined);
    setOpen(null);
    setFilter("all");
    setStarted(Date.now());
    setNow(Date.now());
    setPhase("running");
    let ended: Phase = "done";
    try {
      await postStream(
        runStreamUrl(repo),
        { mode, targets: mode === "targets" ? targets : undefined, rev: mode === "diff" ? rev : undefined },
        (event, data) => {
          if (event === "test") buffer.current.push(data as TestRow);
          else if (event === "selected") setSelected(data as RunSelected);
          else if (event === "progress") setStage((data as { stage: string }).stage);
          else if (event === "done") setDone(data as RunDone);
          else if (event === "error") {
            ended = "error";
            setError((data as { detail: string }).detail);
          }
        },
        ctl.signal,
      );
    } catch (e) {
      if (ctl.signal.aborted) ended = "stopped";
      else {
        ended = "error";
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      const rest = buffer.current;
      buffer.current = [];
      if (rest.length) setRows((r) => [...r, ...rest]);
      if (abort.current === ctl) {
        setPhase(ended);
        history.reload();
        setNow(Date.now());
      }
    }
  };

  const results = useMemo(() => [...fold(rows).values()], [rows]);
  const counts = useMemo(() => {
    const c = { passed: 0, failed: 0, skipped: 0 };
    for (const r of results) c[r.outcome]++;
    return c;
  }, [results]);
  const groups = useMemo(() => {
    const shown = results.filter((r) => filter === "all" || r.outcome === filter);
    const by = new Map<string, TestRow[]>();
    for (const r of shown) {
      const f = r.nodeid.split("::")[0];
      by.set(f, [...(by.get(f) ?? []), r]);
    }
    // failures first, inside each file and across files
    const rank = (rs: TestRow[]) => (rs.some((r) => r.outcome === "failed") ? 0 : 1);
    return [...by.entries()]
      .map(([f, rs]) => [f, rs.sort((a, b) => (a.outcome === "failed" ? 0 : 1) - (b.outcome === "failed" ? 0 : 1))] as const)
      .sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]));
  }, [results, filter]);

  const expected = selected?.count ?? (mode === "all" || mode === "coverage" ? (done?.suite_tests ?? 0) : 0);
  const elapsed = (phase === "idle" ? 0 : now - started) / 1000;
  const culprits = done?.culprits;
  const enabled = runtime.data?.enabled;

  return (
    <Page>
      <PageHeader
        title="Tests"
        sub="Run the tests a change reaches, watch them live, and when something fails get the most likely culprit ranked from this run's failures."
      >
        {culprits?.receipts && <Receipts r={culprits.receipts} />}
      </PageHeader>

      {runtime.loading && !runtime.data ? (
        <Spinner label="Checking the runner" />
      ) : runtime.error ? (
        <ErrorNote error={runtime.error} onRetry={runtime.reload} />
      ) : !enabled ? (
        <Disabled repo={repo} reason={runtime.data?.reason ?? null} />
      ) : (
        <>
          <form
            className="mb-5 rounded-xl border border-border bg-card/50 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!running) start();
            }}
          >
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap rounded-md border border-border p-0.5" role="radiogroup" aria-label="What to run">
                {MODES.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    role="radio"
                    aria-checked={mode === m.key}
                    title={m.hint}
                    disabled={running}
                    onClick={() => setMode(m.key)}
                    className={cn("h-8 rounded px-3 text-xs transition-colors", mode === m.key ? "bg-white/10 text-paper" : "text-fog hover:text-mist")}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-fog">
                {MODES.find((m) => m.key === mode)?.hint}
                {mode === "diff" && rev && <span className="font-mono text-mist"> · against {rev}</span>}
              </span>
              <div className="ml-auto flex gap-2">
                {running ? (
                  <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
                    <Stop className="size-4" /> Stop
                  </Button>
                ) : (
                  <Button type="submit" disabled={mode === "targets" && !targets.length}>
                    <Play className="size-4" /> {mode === "coverage" ? "Record" : "Run"}
                  </Button>
                )}
              </div>
            </div>
            {mode === "targets" && (
              <div className="mt-3">
                <Label htmlFor="run-targets" className="mb-1.5 text-xs text-fog">
                  Symbols or files you changed
                </Label>
                <SymbolPicker id="run-targets" repo={repo} value={targets} onChange={setTargets} />
              </div>
            )}
          </form>

          {phase === "idle" ? (
            <Empty title="Nothing has run yet" icon={<TestTube className="size-6" />}>
              Pick what to run. <em>Working tree</em> selects from your uncommitted changes, the same as <code className="font-mono">aftershock run {repo} --diff</code>. Results stream in as each test finishes.
            </Empty>
          ) : null}
          {phase === "idle" ? null : (
            <div className="space-y-4">
              <div className="epi-in rounded-xl border border-border bg-card/50 p-4" aria-live="polite">
                <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-3">
                  <Stat label="Passed" value={num(counts.passed)} tone="text-signal-teal" />
                  <Stat label="Failed" value={num(counts.failed)} tone={counts.failed ? "text-coral-red" : undefined} />
                  <Stat label="Skipped" value={num(counts.skipped)} />
                  <Stat
                    label="Selected"
                    value={selected ? num(selected.count) : mode === "all" || mode === "coverage" ? "all" : "…"}
                    hint={selected && selected.suite_tests ? `of ${num(selected.suite_tests)} tests in the graph` : undefined}
                  />
                  <Stat label="Time" value={`${elapsed.toFixed(1)}s`} />
                  <div className="ml-auto flex items-center gap-2 text-xs text-fog">
                    {running ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" /> {stage === "culprits" ? "ranking culprits" : stage === "map" ? "mapping coverage" : "running"}
                      </>
                    ) : phase === "stopped" ? (
                      "stopped"
                    ) : phase === "error" ? (
                      <span className="text-coral-red">failed to run</span>
                    ) : (
                      <span>exit {done?.exit_code ?? "–"}</span>
                    )}
                  </div>
                </div>
                <Progress {...counts} total={expected} live={running} />
                {selected?.note && <p className="mt-2 text-xs text-fog">{selected.note}</p>}
                {selected && selected.untested_seeds.length > 0 && (
                  <p className="mt-2 text-xs text-brand">
                    No test reaches {selected.untested_seeds.length} changed symbol{selected.untested_seeds.length === 1 ? "" : "s"}:{" "}
                    {selected.untested_seeds.slice(0, 6).map((s, i) => (
                      <span key={s.id}>
                        {i > 0 && ", "}
                        <SymLink repo={repo} id={s.id} className="text-[12px] text-brand" />
                      </span>
                    ))}
                  </p>
                )}
                {done?.mode === "coverage" && done.edges !== undefined && (
                  <p className="mt-2 text-xs text-mist">
                    Recorded {num(done.edges)} test → code edges over {num(done.symbols_covered ?? 0)} symbols. Impact and selection now include tests that ran the code.
                  </p>
                )}
              </div>

              {done?.run_id && (done.failed ?? 0) > 0 && (
                <div className="epi-in flex flex-wrap items-center gap-3 rounded-xl border border-coral-red/30 bg-coral-red/[0.06] p-4">
                  <CircleAlert className="size-4 shrink-0 text-coral-red" />
                  <p className="min-w-0 flex-1 text-sm text-mist">
                    {done.failed} failing test{done.failed === 1 ? "" : "s"} recorded as run <span className="font-mono text-paper">{done.run_id.slice(-8)}</span>. Open it to see the
                    chain from each failure to its likely culprit, then let Claude fix it with that context and re-run.
                  </p>
                  <Button asChild variant="outline">
                    <Link href={`/r/${encodeURIComponent(repo)}/culprit?run=${done.run_id}`}>
                      Investigate in Culprit <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                  <Button asChild>
                    <Link href={`/r/${encodeURIComponent(repo)}/culprit?run=${done.run_id}&heal=1`}>
                      <Bot className="size-4" /> Fix with AI
                    </Link>
                  </Button>
                </div>
              )}
              {error && <ErrorNote error={error} onRetry={running ? undefined : start} />}
              {done?.output_tail && <pre className="max-h-64 overflow-auto rounded-md border border-graphite bg-black/30 p-3 font-mono text-[11.5px] whitespace-pre-wrap text-mist">{done.output_tail}</pre>}
              {phase === "done" && selected && selected.count === 0 && (
                <Empty title="No tests to run" icon={<TestTube className="size-6" />}>
                  {selected.note ?? "Nothing the change reaches has a test."}
                </Empty>
              )}

              {(results.length > 0 || culprits) && (
                <div className={cn("grid gap-4", culprits && "lg:grid-cols-[minmax(0,1fr)_380px]")}>
                  <Tile
                    title={`Results · ${num(results.length)}`}
                    bodyClassName="p-2"
                    action={
                      <div className="flex gap-1" role="radiogroup" aria-label="Filter results">
                        {(["all", "failed", "passed", "skipped"] as Filter[]).map((f) => (
                          <button
                            key={f}
                            type="button"
                            role="radio"
                            aria-checked={filter === f}
                            onClick={() => setFilter(f)}
                            className={cn("h-7 rounded px-2 text-[11px] capitalize transition-colors", filter === f ? "bg-white/10 text-paper" : "text-fog hover:text-mist")}
                          >
                            {f}
                            {f !== "all" && <span className="ml-1 font-mono text-fog">{counts[f]}</span>}
                          </button>
                        ))}
                      </div>
                    }
                  >
                    {groups.length ? (
                      <div className="space-y-3">
                        {groups.map(([file, rs]) => (
                          <section key={file}>
                            <h3 className="px-2 pb-1 font-mono text-[11px] text-fog">
                              {file} <span className="text-fog/70">· {rs.length}</span>
                            </h3>
                            <ul className="space-y-0.5">
                              {rs.map((r) => (
                                <ResultRow key={r.nodeid} repo={repo} r={r} open={open === r.nodeid} onToggle={() => setOpen(open === r.nodeid ? null : r.nodeid)} />
                              ))}
                            </ul>
                          </section>
                        ))}
                      </div>
                    ) : (
                      <p className="p-3 text-sm text-muted-foreground">No {filter} tests.</p>
                    )}
                  </Tile>

                  {culprits && (
                    <Tile title={`Likely culprits · ${culprits.suspects.length}`} bodyClassName="p-2" className="lg:sticky lg:top-20 lg:self-start">
                      {culprits.suspects.length ? (
                        <ul className="space-y-0.5">
                          {culprits.suspects.map((s, i) => (
                            <SuspectRow key={s.id} repo={repo} s={s} rank={i + 1} open={suspect === s.id} onToggle={() => setSuspect(suspect === s.id ? null : s.id)} />
                          ))}
                        </ul>
                      ) : (
                        <p className="p-3 text-sm text-muted-foreground">No suspects: the failing tests reach no resolved code.</p>
                      )}
                      <p className="px-2 pt-2 text-[11px] text-fog">Ranked from this run: code many failing tests reach and few passing tests reach rises; symbols you changed get a boost.</p>
                    </Tile>
                  )}
                </div>
              )}
            </div>
          )}
          {history.data && (
            <Tile title="Recent runs" className="mt-4" bodyClassName="p-2">
              <RunList repo={repo} runs={history.data.runs} current={done?.run_id} />
            </Tile>
          )}
        </>
      )}
    </Page>
  );
}
