"use client";

/**
 * Tests — select, run, and explain.
 *
 * Three decisions shape this page, all of them corrections of the version it
 * replaces:
 *
 *  1. **The run gate never replaces the page.** `AFTERSHOCK_ALLOW_RUN` controls
 *     one thing: executing the repo's code. It says nothing about reading the
 *     graph. The old page swapped the entire screen for a "turn this on"
 *     message, which hid the library list, the selection preview and the whole
 *     run history behind a switch none of them need. Here the gate is one
 *     banner and one disabled button.
 *  2. **Selection is separable from running.** `POST /repos/{repo}/tests` is
 *     pure graph work — it answers "which tests would this change run?" without
 *     executing anything. So it works with the gate off, and it is the first
 *     thing the page offers: you can see the blast radius of your working tree
 *     on a machine that is not allowed to run a single test.
 *  3. **Test libraries are visible.** The API has always been able to list,
 *     register and remove external pytest directories; nothing in the UI ever
 *     called it, so a repo whose tests live outside the tree looked like a repo
 *     with no tests. The panel is on this page because this is where the
 *     consequence shows up.
 */

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  ArrowRight,
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Crosshair,
  Library,
  Loader2,
  Play,
  Plus,
  Prohibit,
  Stop,
  Terminal,
  TestTube,
  Trash,
} from "@/components/icons";
import {
  Callout,
  Chip,
  CodeBlock,
  Divider,
  Empty,
  ErrorNote,
  Eyebrow,
  Grid,
  Metric,
  Mono,
  Page,
  PageHeader,
  Panel,
  Segmented,
  Skeleton,
  Spinner,
  Stack,
} from "@/components/ds";
import { FileLink, Receipts, SymLink } from "@/components/kit";
import { RunList } from "@/components/run-list";
import { SuspectRow } from "@/components/suspect-row";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  api,
  runStreamUrl,
  type RunDone,
  type RunMode,
  type RunSelected,
  type TestLibrary,
  type TestRow,
} from "@/lib/api";
import { ms, num } from "@/lib/format";
import { useAction, useQuery, useRepo } from "@/lib/hooks";
import { postStream } from "@/lib/sse";
import { cn } from "@/lib/utils";

const MODES: { key: RunMode; label: string; hint: string; selectable: boolean }[] = [
  { key: "diff", label: "Working tree", hint: "the tests your uncommitted changes reach", selectable: true },
  { key: "targets", label: "Symbols", hint: "the tests that reach the symbols you pick", selectable: true },
  { key: "all", label: "Whole suite", hint: "every test, no selection", selectable: false },
  { key: "coverage", label: "Record coverage", hint: "whole suite under per-test coverage; later selections use it", selectable: false },
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
const headline = (m = "") =>
  m
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .at(-1)
    ?.replace(/^E\s+/, "") ?? "";

/* -------------------------------------------------------------------------- */
/* The run gate                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Why the Run button is off, and the two ways to turn it on.
 *
 * Deliberately a banner, not a wall: everything else on this page works without
 * the runner, and the previous version hid all of it behind this message.
 */
function RunGate({ repo, reason }: { repo: string; reason: string | null }) {
  const serve = "AFTERSHOCK_ALLOW_RUN=1 aftershock serve";
  const cli = `aftershock run ${repo} --diff`;
  return (
    <Panel tone="emphasis" title="Running is off" className="mb-[var(--stack-gap)]">
      <div className="flex items-start gap-2.5">
        <Prohibit className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
        <p className="min-w-0 text-body-sm text-ink">
          {reason ?? "The API refused."} Running a repo&apos;s tests executes its code, so it is opt-in and only works
          from the machine the API runs on. Everything below that reads the graph — libraries, selection, history —
          works either way.
        </p>
      </div>
      <Grid cols={2} className="mt-3">
        <CodeBlock title="restart the API with the runner on" code={serve} />
        <CodeBlock title="or run it from a terminal instead" code={cli} />
      </Grid>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Test libraries                                                              */
/* -------------------------------------------------------------------------- */

/**
 * External pytest directories registered against this repo.
 *
 * `library_set` writes config, not graph: a newly added library contributes no
 * tests until the repo is re-indexed, and the API says so in `note`. That note
 * is surfaced verbatim rather than paraphrased — it is the difference between
 * "nothing happened" and "nothing has happened *yet*".
 */
function Libraries({ repo }: { repo: string }) {
  const q = useQuery(`libs:${repo}`, () => api.libraries(repo));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const add = useAction(api.libraryAdd);
  const remove = useAction(api.libraryRemove);
  const busy = add.loading || remove.loading;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) return;
    const res = await add.run(repo, name.trim(), path.trim());
    if (!res) return;
    setName("");
    setPath("");
    setAdding(false);
    q.reload();
    toast.success(`Added ${name.trim()}`, { description: res.note });
  };

  const drop = async (lib: TestLibrary) => {
    const res = await remove.run(repo, lib.name);
    if (!res) return;
    q.reload();
    toast.success(`Removed ${lib.name}`, { description: res.note });
  };

  const libs = q.data?.libraries ?? [];

  return (
    <Panel
      title="Test libraries"
      note="pytest directories outside the repo tree"
      action={
        <Button variant="ghost" size="sm" className="h-7" onClick={() => setAdding((v) => !v)} disabled={busy}>
          <Plus className={cn("size-3.5 transition-transform duration-[var(--dur-fast)]", adding && "rotate-45")} />
          {adding ? "Cancel" : "Add"}
        </Button>
      }
      bodyClassName="flex flex-col gap-2.5"
    >
      {adding && (
        <form onSubmit={submit} className="grid gap-2 rounded-nested border border-line-strong bg-surface-raised p-2.5">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,160px)_minmax(0,1fr)]">
            <div>
              <Label htmlFor="lib-name" className="mb-1 block">
                <Eyebrow>Name</Eyebrow>
              </Label>
              <Input
                id="lib-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="integration"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div>
              <Label htmlFor="lib-path" className="mb-1 block">
                <Eyebrow>Absolute path</Eyebrow>
              </Label>
              <Input
                id="lib-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/srv/qa/integration-tests"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                required
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || !name.trim() || !path.trim()}>
              {add.loading ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Register
            </Button>
            <span className="text-caption text-ink-muted">
              Must be a directory outside the repo. Re-index afterwards to pick up its tests.
            </span>
          </div>
          {add.error && <ErrorNote error={add.error} />}
        </form>
      )}

      {q.loading && !q.data ? (
        <Skeleton className="h-[var(--row-h)]" />
      ) : q.error ? (
        <ErrorNote error={q.error} onRetry={q.reload} />
      ) : libs.length === 0 ? (
        <p className="text-body-sm text-ink-muted">
          None. The repo&apos;s own <Mono className="text-ink">tests/</Mono> directory is always indexed — register a
          library only when tests live somewhere else on disk.
        </p>
      ) : (
        <ul className="flex flex-col">
          {libs.map((lib) => (
            <li
              key={lib.name}
              className="flex min-h-[var(--row-h)] items-center gap-2.5 border-b border-line/60 py-1 last:border-0"
            >
              <Library className="size-4 shrink-0 text-ink-faint" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-body-sm text-ink-strong">{lib.name}</span>
                  {!lib.on_disk && (
                    <Chip tone="warn" dot>
                      missing
                    </Chip>
                  )}
                </div>
                <Mono className="block truncate text-caption text-ink-muted">{lib.path}</Mono>
              </div>
              {lib.on_disk && (
                <Mono className="shrink-0 text-caption text-ink-muted">
                  {num(lib.tests ?? 0)} tests · {num(lib.files ?? 0)} files
                </Mono>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={`Remove ${lib.name}`}
                disabled={busy}
                onClick={() => drop(lib)}
              >
                <Trash className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {remove.error && <ErrorNote error={remove.error} />}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Selection preview — what a run *would* do. Works with the gate off.         */
/* -------------------------------------------------------------------------- */

function SelectionPreview({ repo, sel }: { repo: string; sel: RunSelected }) {
  const [open, setOpen] = useState(false);
  const shown = open ? sel.tests : sel.tests.slice(0, 8);
  return (
    <Panel
      title="Selection"
      note="what a run would execute — nothing has been run"
      action={
        <Mono className="text-caption text-ink-muted">
          {num(sel.count)} of {num(sel.suite_tests)}
        </Mono>
      }
      bodyClassName="flex flex-col gap-3"
    >
      {sel.note && <p className="text-body-sm text-ink-muted">{sel.note}</p>}

      {sel.tests.length === 0 ? (
        <p className="text-body-sm text-ink-muted">No test in the graph reaches this change.</p>
      ) : (
        <>
          <ul className="flex flex-col">
            {shown.map((t) => (
              <li key={t.id} className="flex min-h-[var(--row-h)] items-center gap-2.5 border-b border-line/60 py-1 last:border-0">
                <TestTube className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                <SymLink repo={repo} id={t.id} name={t.name} className="min-w-0 flex-1 truncate text-body-sm" />
                {t.reach && (
                  <Chip tone="pass" size="sm">
                    ran it
                  </Chip>
                )}
                <Mono className="shrink-0 text-caption text-ink-muted">
                  {t.hop === null ? "—" : `${t.hop} hop${t.hop === 1 ? "" : "s"}`}
                </Mono>
              </li>
            ))}
          </ul>
          {sel.tests.length > 8 && (
            <button
              type="button"
              data-hit
              onClick={() => setOpen((v) => !v)}
              className="self-start font-mono text-micro uppercase text-ink-muted transition-colors duration-[var(--dur-fast)] hover:text-ink-strong"
            >
              {open ? "Show fewer" : `Show all ${num(sel.tests.length)}`}
            </button>
          )}
        </>
      )}

      {sel.untested_seeds.length > 0 && (
        <Callout tone="warn" icon={<CircleAlert className="text-warn" aria-hidden />}>
          No test reaches {sel.untested_seeds.length} changed symbol{sel.untested_seeds.length === 1 ? "" : "s"}:{" "}
          {sel.untested_seeds.slice(0, 6).map((s, i) => (
            <span key={s.id}>
              {i > 0 && ", "}
              <SymLink repo={repo} id={s.id} />
            </span>
          ))}
          {sel.untested_seeds.length > 6 && ` and ${sel.untested_seeds.length - 6} more`}.
        </Callout>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Live results                                                                */
/* -------------------------------------------------------------------------- */

function ResultRow({ repo, r, open, onToggle }: { repo: string; r: TestRow; open: boolean; onToggle: () => void }) {
  const failed = r.outcome === "failed";
  const [file, ...rest] = r.nodeid.split("::");
  return (
    <li className={cn("rounded-control", open && "bg-surface")}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!r.message}
        aria-expanded={r.message ? open : undefined}
        data-hit
        className="flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left enabled:hover:bg-accent/60"
      >
        {failed ? (
          <CircleAlert className="size-4 shrink-0 text-fail" aria-label="failed" />
        ) : r.outcome === "skipped" ? (
          <span className="grid size-4 shrink-0 place-items-center font-mono text-micro text-ink-faint" aria-label="skipped">
            –
          </span>
        ) : (
          <CircleCheck className="size-4 shrink-0 text-pass" aria-label="passed" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-code">
          <span className="text-ink-faint">{file}::</span>
          <span className={failed ? "text-ink-strong" : "text-ink"}>{rest.join("::")}</span>
          {r.when !== "call" && <span className="ml-1.5 text-micro text-brand">in {r.when}</span>}
        </span>
        {failed && !open && (
          <span className="hidden max-w-[40%] truncate font-mono text-micro text-fail/80 md:inline">{headline(r.message)}</span>
        )}
        <Mono className="w-14 shrink-0 text-right text-micro text-ink-faint">{ms(r.seconds * 1000)}</Mono>
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-[var(--dur-fast)]",
            r.message ? "text-ink-faint" : "invisible",
            open && "rotate-90",
          )}
        />
      </button>
      {open && r.message && (
        <div className="px-2 pb-2 pl-8">
          <CodeBlock code={r.message} title={file} maxHeight={320} wrap />
          <div className="mt-1.5">
            <FileLink repo={repo} path={file} className="text-caption" />
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
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-line-strong"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={of}
      aria-valuenow={passed + failed + skipped}
    >
      <div className="flex h-full">
        <div className="bg-pass transition-[width] duration-[var(--dur-base)]" style={{ width: w(passed) }} />
        <div className="bg-fail transition-[width] duration-[var(--dur-base)]" style={{ width: w(failed) }} />
        <div className="bg-ink-faint/50 transition-[width] duration-[var(--dur-base)]" style={{ width: w(skipped) }} />
        {live && <div className="h-full flex-1 animate-pulse bg-brand/20" />}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function TestsPage() {
  const repo = useRepo();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const runtime = useQuery("runtime", api.runtime);
  const history = useQuery(`runs:${repo}`, () => api.runs(repo, 10));

  const [mode, setMode] = useState<RunMode>(() =>
    MODES.some((m) => m.key === sp.get("mode")) ? (sp.get("mode") as RunMode) : "diff",
  );
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

  /** The read-only half: which tests the change selects, without executing one. */
  const preview = useAction(api.selectTests);

  const running = phase === "running";
  const enabled = runtime.data?.enabled ?? false;
  const current = MODES.find((m) => m.key === mode)!;
  const needsTargets = mode === "targets" && targets.length === 0;

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

  /** Keep the URL shareable: the mode, the targets and the base ref fully describe the screen. */
  const syncUrl = () => {
    const qs = new URLSearchParams({ mode });
    if (mode === "targets") targets.forEach((t) => qs.append("t", t));
    if (mode === "diff" && rev) qs.set("rev", rev);
    router.replace(`${pathname}?${qs}`, { scroll: false });
  };

  const runPreview = async () => {
    syncUrl();
    await preview.run(repo, {
      targets: mode === "targets" ? targets : undefined,
      rev: mode === "diff" ? rev : undefined,
    });
  };

  const start = async () => {
    if (needsTargets) return;
    syncUrl();
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
    preview.reset(); // the live run supersedes the preview; two selections on screen is one too many
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

  return (
    <Page>
      <PageHeader
        eyebrow="What does this change break"
        title="Tests"
        sub="See which tests a change reaches before you run anything, run them and watch the results stream in, then get the code most likely responsible for each failure."
      >
        {culprits?.receipts && <Receipts r={culprits.receipts} />}
      </PageHeader>

      {runtime.loading && !runtime.data ? (
        <Spinner label="Checking the runner" className="mb-[var(--stack-gap)]" />
      ) : runtime.error ? (
        <ErrorNote error={runtime.error} onRetry={runtime.reload} className="mb-[var(--stack-gap)]" />
      ) : !enabled ? (
        <RunGate repo={repo} reason={runtime.data?.reason ?? null} />
      ) : null}

      <Stack>
        <Grid cols="main-aside">
          <Panel title="Run" note={current.hint}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!running && enabled) start();
              }}
              className="flex flex-col gap-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label="What to run"
                  value={mode}
                  onChange={(m) => setMode(m)}
                  // No per-option `title`: the selected mode's hint is already the panel's note, and a tooltip
                  // that differs from the visible label becomes the control's accessible name (WCAG 2.5.3).
                  options={MODES.map((m) => ({ value: m.key, label: m.label }))}
                />
                {mode === "diff" && rev && (
                  <Chip tone="brand">
                    against <Mono className="ml-1">{rev}</Mono>
                  </Chip>
                )}
              </div>

              {mode === "targets" && (
                <div>
                  <Label htmlFor="run-targets" className="mb-1.5 block">
                    <Eyebrow>Symbols or files you changed</Eyebrow>
                  </Label>
                  <SymbolPicker id="run-targets" repo={repo} value={targets} onChange={setTargets} />
                </div>
              )}

              <Divider />

              <div className="flex flex-wrap items-center gap-2">
                {/* Reading the graph is always allowed; executing the repo's code is not. */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={runPreview}
                  disabled={!current.selectable || needsTargets || preview.loading || running}
                >
                  {preview.loading ? <Loader2 className="size-4 animate-spin" /> : <Crosshair className="size-4" />}
                  Preview selection
                </Button>

                {running ? (
                  <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
                    <Stop className="size-4" /> Stop
                  </Button>
                ) : (
                  <Button type="submit" disabled={!enabled || needsTargets}>
                    <Play className="size-4" /> {mode === "coverage" ? "Record" : "Run"}
                  </Button>
                )}

                {/* Why a control is unavailable is said in text next to it, never only in a tooltip: a disabled
                 *  button does not reliably fire the hover that would reveal one. */}
                {needsTargets ? (
                  <span className="text-caption text-ink-muted">Pick at least one symbol.</span>
                ) : !current.selectable && !enabled ? (
                  <span className="flex items-center gap-1.5 text-caption text-ink-muted">
                    <Terminal className="size-3.5" aria-hidden /> this mode runs the whole suite — nothing to preview,
                    and running is off
                  </span>
                ) : !current.selectable ? (
                  <span className="text-caption text-ink-muted">
                    This mode runs the whole suite, so there is no selection to preview.
                  </span>
                ) : !enabled ? (
                  <span className="flex items-center gap-1.5 text-caption text-ink-muted">
                    <Terminal className="size-3.5" aria-hidden /> preview works, running does not
                  </span>
                ) : null}
              </div>
            </form>
          </Panel>

          <Libraries repo={repo} />
        </Grid>

        {preview.error && <ErrorNote error={preview.error} onRetry={runPreview} />}
        {preview.data && !running && phase === "idle" && <SelectionPreview repo={repo} sel={preview.data} />}

        {phase === "idle" && !preview.data && (
          <Empty title="Nothing has run yet" icon={<TestTube className="size-6" />}>
            <em>Working tree</em> selects the tests your uncommitted changes reach — the same selection as{" "}
            <Mono className="text-ink">aftershock run {repo} --diff</Mono>. Preview it first if you only want to know
            what would run.
          </Empty>
        )}

        {phase !== "idle" && (
          <>
            <Panel aria-live="polite">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-8 gap-y-3">
                <Metric label="Passed" value={num(counts.passed)} tone={counts.passed ? "text-pass" : undefined} />
                <Metric label="Failed" value={num(counts.failed)} tone={counts.failed ? "text-fail" : undefined} />
                <Metric label="Skipped" value={num(counts.skipped)} />
                <Metric
                  label="Selected"
                  value={selected ? num(selected.count) : mode === "all" || mode === "coverage" ? "all" : "…"}
                  hint={selected && selected.suite_tests ? `of ${num(selected.suite_tests)} in the graph` : undefined}
                />
                <Metric label="Elapsed" value={`${elapsed.toFixed(1)}s`} />
                <div className="ml-auto flex items-center gap-2 text-caption text-ink-muted">
                  {running ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />{" "}
                      {stage === "culprits" ? "ranking culprits" : stage === "map" ? "mapping coverage" : "running"}
                    </>
                  ) : phase === "stopped" ? (
                    <Chip tone="warn">stopped</Chip>
                  ) : phase === "error" ? (
                    <Chip tone="fail">failed to run</Chip>
                  ) : (
                    <Chip tone={done?.exit_code ? "fail" : "pass"} dot>
                      exit {done?.exit_code ?? "–"}
                    </Chip>
                  )}
                </div>
              </div>
              <Progress {...counts} total={expected} live={running} />
              {selected?.note && <p className="mt-2 text-caption text-ink-muted">{selected.note}</p>}
              {selected && selected.untested_seeds.length > 0 && (
                <p className="mt-2 text-caption text-warn">
                  No test reaches {selected.untested_seeds.length} changed symbol
                  {selected.untested_seeds.length === 1 ? "" : "s"}:{" "}
                  {selected.untested_seeds.slice(0, 6).map((s, i) => (
                    <span key={s.id}>
                      {i > 0 && ", "}
                      <SymLink repo={repo} id={s.id} />
                    </span>
                  ))}
                </p>
              )}
              {done?.mode === "coverage" && done.edges !== undefined && (
                <p className="mt-2 text-caption text-ink-muted">
                  Recorded {num(done.edges)} test → code edges over {num(done.symbols_covered ?? 0)} symbols. Impact and
                  selection now include tests that actually ran the code.
                </p>
              )}
            </Panel>

            {done?.run_id && (done.failed ?? 0) > 0 && (
              <Callout tone="fail" icon={<CircleAlert className="text-fail" aria-hidden />}>
                <div className="flex flex-wrap items-center gap-3">
                  <p className="min-w-0 flex-1">
                    {done.failed} failing test{done.failed === 1 ? "" : "s"} recorded as run{" "}
                    <Mono className="text-ink-strong">{done.run_id.slice(-8)}</Mono>. Open it to see the chain from each
                    failure to its likely culprit.
                  </p>
                  <Button asChild variant="outline">
                    <Link href={`/r/${encodeURIComponent(repo)}/culprit?run=${done.run_id}`}>
                      Investigate <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                  <Button asChild>
                    <Link href={`/r/${encodeURIComponent(repo)}/culprit?run=${done.run_id}&heal=1`}>
                      <Bot className="size-4" /> Fix with AI
                    </Link>
                  </Button>
                </div>
              </Callout>
            )}

            {error && <ErrorNote error={error} onRetry={running ? undefined : start} />}
            {done?.output_tail && <CodeBlock title="pytest output" code={done.output_tail} maxHeight={256} wrap />}

            {phase === "done" && selected && selected.count === 0 && (
              <Empty title="No tests to run" icon={<TestTube className="size-6" />}>
                {selected.note ?? "Nothing the change reaches has a test."}
              </Empty>
            )}

            {(results.length > 0 || culprits) && (
              <div className={cn("grid gap-[var(--stack-gap)]", culprits && "lg:grid-cols-[minmax(0,1fr)_380px]")}>
                <Panel
                  title={`Results · ${num(results.length)}`}
                  bodyClassName="p-2"
                  action={
                    <Segmented
                      size="sm"
                      label="Filter results"
                      value={filter}
                      onChange={setFilter}
                      options={(["all", "failed", "passed", "skipped"] as Filter[]).map((f) => ({
                        value: f,
                        label: f === "all" ? "All" : `${f} ${counts[f]}`,
                      }))}
                    />
                  }
                >
                  {groups.length ? (
                    <div className="flex flex-col gap-3">
                      {groups.map(([file, rs]) => (
                        <section key={file}>
                          <h3 className="px-2 pb-1">
                            <Eyebrow className="normal-case">
                              {file} <span className="text-ink-faint">· {rs.length}</span>
                            </Eyebrow>
                          </h3>
                          <ul className="flex flex-col gap-0.5">
                            {rs.map((r) => (
                              <ResultRow
                                key={r.nodeid}
                                repo={repo}
                                r={r}
                                open={open === r.nodeid}
                                onToggle={() => setOpen(open === r.nodeid ? null : r.nodeid)}
                              />
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  ) : (
                    <p className="p-3 text-body-sm text-ink-muted">No {filter} tests.</p>
                  )}
                </Panel>

                {culprits && (
                  <Panel
                    title={`Likely culprits · ${culprits.suspects.length}`}
                    bodyClassName="p-2"
                    className="lg:sticky lg:top-20 lg:self-start"
                  >
                    {culprits.suspects.length ? (
                      <ul className="flex flex-col gap-0.5">
                        {culprits.suspects.map((s, i) => (
                          <SuspectRow
                            key={s.id}
                            repo={repo}
                            s={s}
                            rank={i + 1}
                            open={suspect === s.id}
                            onToggle={() => setSuspect(suspect === s.id ? null : s.id)}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="p-3 text-body-sm text-ink-muted">
                        No suspects: the failing tests reach no resolved code.
                      </p>
                    )}
                    <p className="px-2 pt-2 text-caption text-ink-muted">
                      Ranked from this run: code many failing tests reach and few passing tests reach rises; symbols you
                      changed get a boost.
                    </p>
                  </Panel>
                )}
              </div>
            )}
          </>
        )}

        {/* History is graph data, not runtime: it stays visible whether or not running is allowed. */}
        <Panel title="Recent runs" bodyClassName="p-2">
          {history.loading && !history.data ? (
            <Skeleton className="h-[var(--row-h)]" />
          ) : history.error ? (
            <ErrorNote error={history.error} onRetry={history.reload} />
          ) : history.data?.runs.length ? (
            <RunList repo={repo} runs={history.data.runs} current={done?.run_id} />
          ) : (
            <p className="p-3 text-body-sm text-ink-muted">No run has been recorded for this repo yet.</p>
          )}
        </Panel>
      </Stack>
    </Page>
  );
}
