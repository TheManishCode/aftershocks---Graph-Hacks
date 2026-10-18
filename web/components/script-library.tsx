"use client";

/**
 * The built-in script library (D28): checks, graph questions, linters, type checkers and test suites that ship with
 * Aftershock. Nobody writes or registers scripts; you tick the ones you want, or ask the agent to pick.
 *
 *  1. **One fetch, local filters.** The whole catalog (under 200 rows, with `applies` and `available` computed for
 *     this repo) is loaded once; search, category, ecosystem and "applies here" filter it in the browser.
 *  2. **The run gate is per script, not per page.** `check` and `graph` scripts only read, so they run with the gate
 *     off. `command` scripts execute the repo's code or a tool: unticked and disabled while `can_exec` is false,
 *     with the reason in text.
 *  3. **Results stream per script** (`script` → running, `result` → done) and stay attached to their row, so a
 *     finding is read where the script is.
 *  4. **Results outlive the page (D29).** Every batch is recorded on the server; on load the newest one is shown in
 *     the rows, labelled with when and from where it ran.
 *  5. **Missing means installable (D29).** A script whose tool is absent offers Install (a fixed pip/npm recipe),
 *     Set up (the repo has no test interpreter yet) or the command for the operator (system packages). Installs
 *     stream into a log here and the listing reloads when they finish.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Chip, CodeBlock, ErrorNote, Figure, Mono, Sheet, Skeleton } from "@/components/gt";
import { ChevronRight, CircleAlert, CircleCheck, Download, Loader2, Play, Search, Stop, TriangleAlert } from "@/components/icons";
import { FileLink } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  api,
  installStreamUrl,
  scriptsStreamUrl,
  setupStreamUrl,
  type Script,
  type ScriptInstall,
  type ScriptResult,
  type ScriptRunSummary,
  type ScriptStatus,
} from "@/lib/api";
import { num, relTime } from "@/lib/format";
import { useQuery } from "@/lib/hooks";
import { postStream } from "@/lib/sse";
import { cn } from "@/lib/utils";

const MAX = 60; // ScriptsBody.ids on the server
const PAD = "px-[clamp(14px,2vw,24px)]";

type Live = ScriptResult | "running";

function StatusIcon({ s }: { s?: Live }) {
  if (s === "running") return <Loader2 className="size-4 animate-spin text-mark" aria-label="running" />;
  if (!s) return <span className="size-4" aria-hidden />;
  const by: Record<ScriptStatus, React.ReactNode> = {
    passed: <CircleCheck className="size-4 text-pass" aria-label="passed" />,
    warned: <TriangleAlert className="size-4 text-warn" aria-label="warned" />,
    failed: <CircleAlert className="size-4 text-fail" aria-label="failed" />,
    error: <CircleAlert className="size-4 text-fail" aria-label="error" />,
    skipped: (
      <span className="grid size-4 place-items-center font-mono text-[11px] text-ink-faint" aria-label="skipped">
        –
      </span>
    ),
  };
  return by[s.status];
}

const KIND_TONE = { check: "neutral", graph: "info", command: "mark" } as const;
const TRIGGER: Record<string, string> = { web: "this page", ask: "the agent", cli: "the CLI" };

/* ---- installs and environment setup (D29) ---------------------------------------------------------------------- */

interface Job {
  title: string;
  running: boolean;
  steps: { name: string; status: string }[];
  lines: string[];
  error?: string;
  outcome?: string;
}

/** One install or setup at a time, streamed into a log. `onDone` runs after success or failure (to reload). */
function useJob(onDone: () => void) {
  const [job, setJob] = useState<Job | null>(null);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const run = async (title: string, url: string, body: unknown, describe: (d: Record<string, unknown>) => string) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setJob({ title, running: true, steps: [], lines: [] });
    const patch = (f: (j: Job) => Job) => setJob((j) => (j ? f(j) : j));
    try {
      await postStream(
        url,
        body,
        (event, d) => {
          const x = d as Record<string, unknown>;
          if (event === "step")
            patch((j) => {
              const name = String(x.name);
              const rest = j.steps.filter((s) => s.name !== name);
              return { ...j, steps: [...rest, { name, status: String(x.status) }] };
            });
          else if (event === "output") patch((j) => ({ ...j, lines: [...j.lines.slice(-299), String(x.line)] }));
          else if (event === "done") patch((j) => ({ ...j, outcome: describe(x) }));
          else if (event === "error") patch((j) => ({ ...j, error: String(x.detail) }));
        },
        c.signal,
      );
    } catch (e) {
      if (!c.signal.aborted) patch((j) => ({ ...j, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      if (ctl.current === c) {
        patch((j) => ({ ...j, running: false }));
        onDone();
      }
    }
  };
  return { job, run, stop: () => ctl.current?.abort(), clear: () => setJob(null) };
}

function JobLog({ job, onStop, onClose }: { job: Job; onStop: () => void; onClose: () => void }) {
  return (
    <div className="grid gap-2 border border-line bg-deep p-3" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        {job.running ? (
          <Loader2 className="size-4 animate-spin text-mark" aria-hidden />
        ) : job.error ? (
          <CircleAlert className="size-4 text-fail" aria-hidden />
        ) : (
          <CircleCheck className="size-4 text-pass" aria-hidden />
        )}
        <span className="text-[13px] text-ink">{job.title}</span>
        <span className="ml-auto">
          {job.running ? (
            <Button variant="outline" size="sm" onClick={onStop}>
              <Stop className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Dismiss
            </Button>
          )}
        </span>
      </div>
      {job.steps.length > 0 && (
        <ul className="grid gap-0.5 text-[12px]">
          {job.steps.map((s) => (
            <li key={s.name} className="flex items-center gap-2">
              <Mono className={cn("w-[7ch] text-[11px]", s.status === "failed" ? "text-fail" : s.status === "done" ? "text-pass" : "text-mark")}>{s.status}</Mono>
              <span className="text-ink-dim">{s.name}</span>
            </li>
          ))}
        </ul>
      )}
      {job.outcome && <p className="text-[12.5px] text-ink">{job.outcome}</p>}
      {job.error && <ErrorNote error={job.error} />}
      {job.lines.length > 0 && <CodeBlock title="log (tail)" code={job.lines.slice(-120).join("\n")} maxHeight={220} wrap />}
    </div>
  );
}

const installed = (d: Record<string, unknown>) => {
  const tools = (d.tools ?? {}) as Record<string, { status: string; hint?: string }>;
  const by = (k: string) => Object.entries(tools).filter(([, v]) => v.status === k).map(([t]) => t);
  const parts = [
    by("installed").length && `installed ${by("installed").join(", ")}`,
    by("failed").length && `failed: ${by("failed").join(", ")}`,
    by("needs-setup").length && `${by("needs-setup").join(", ")} need the test environment first`,
    by("manual").length && `install by hand: ${by("manual").map((t) => `${t} (${tools[t].hint})`).join("; ")}`,
  ].filter(Boolean);
  return parts.join(" · ") || "nothing to install";
};

const setUp = (d: Record<string, unknown>) => {
  const failed = (d.failed as string[] | undefined) ?? [];
  return `${d.created ? "Created the environment and installed" : "Installed"} the repo's test requirements, pytest and coverage.${
    failed.length ? ` Optional steps that failed: ${failed.join(", ")}.` : ""
  }`;
};

function InstallAction({ install, disabled, why, onInstall }: { install: ScriptInstall; disabled: boolean; why?: string; onInstall: () => void }) {
  if (install.method === "manual")
    return (
      <Mono className="hidden max-w-[34ch] truncate text-right text-[11px] text-ink-faint sm:block" title={install.hint}>
        {install.hint}
      </Mono>
    );
  return (
    <Button variant="outline" size="sm" className="h-7 px-2 text-[12px]" onClick={onInstall} disabled={disabled} title={why ?? (install.method === "setup" ? install.hint : `${install.method} install ${install.package}`)}>
      <Download className="size-3.5" /> {install.method === "setup" ? "Set up" : "Install"}
    </Button>
  );
}

function Row({
  repo,
  s,
  live,
  checked,
  disabled,
  why,
  open,
  onCheck,
  onToggle,
  installBlocked,
  onInstall,
}: {
  repo: string;
  s: Script;
  live?: Live;
  checked: boolean;
  disabled: boolean;
  why?: string;
  open: boolean;
  onCheck: (v: boolean) => void;
  onToggle: () => void;
  installBlocked?: string;
  onInstall: (i: ScriptInstall) => void;
}) {
  const res = live && live !== "running" ? live : undefined;
  const install = s.applies && s.available === false ? s.install : null;
  const detail = (res && (res.findings.length > 0 || res.output_tail || res.reason || res.command)) || install?.method === "manual";
  const tally = res
    ? res.reason && res.status !== "failed"
      ? res.reason
      : res.summary
        ? Object.entries(res.summary)
            .map(([k, v]) => `${num(v)} ${k}`)
            .join(" · ")
        : res.count
          ? `${num(res.count)} finding${res.count === 1 ? "" : "s"}`
          : res.status
    : "";
  return (
    <li className={cn(open && "bg-deep", !s.applies && "opacity-60")}>
      <div className={cn("gt-row grid-cols-[18px_16px_minmax(0,1fr)_auto_14px] items-center", PAD)}>
        <input
          type="checkbox"
          className="size-3.5 accent-mark"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onCheck(e.target.checked)}
          aria-label={`Select ${s.name}`}
          title={why}
        />
        <StatusIcon s={live} />
        <button type="button" onClick={onToggle} disabled={!detail} aria-expanded={detail ? open : undefined} className="min-w-0 text-left">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] text-ink">{s.name}</span>
            <Mono className="text-[11px] text-ink-faint">{s.id}</Mono>
            {s.kind !== "check" && <Chip tone={KIND_TONE[s.kind]}>{s.kind === "command" ? (s.tool ?? "runs code") : "graph"}</Chip>}
            {s.applies && s.available === false && <Chip tone="warn">not installed</Chip>}
            {s.local_only && <Chip title="spends model credit and writes into the checkout">operator only</Chip>}
            {!s.applies && <Chip>n/a here</Chip>}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-ink-dim">{s.summary}</span>
        </button>
        {install && !res ? (
          <InstallAction install={install} disabled={!!installBlocked} why={installBlocked} onInstall={() => onInstall(install)} />
        ) : (
          <Mono className={cn("hidden max-w-[34ch] truncate text-right text-[11px] sm:block", res?.status === "failed" || res?.status === "error" ? "text-fail" : "text-ink-dim")}>
            {tally}
          </Mono>
        )}
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", detail ? "text-ink-faint" : "invisible", open && "rotate-90")} />
      </div>
      {open && !res && install?.method === "manual" && (
        <div className={cn("grid gap-2 pb-3 pl-[52px]", PAD)}>
          <p className="text-[12.5px] text-ink-dim">{s.tool} needs the system package manager, so it is the server operator&apos;s to install:</p>
          <CodeBlock title="install" code={install.hint} wrap />
        </div>
      )}
      {open && res && (
        <div className={cn("grid gap-2 pb-3 pl-[52px]", PAD)}>
          {res.reason && <p className="text-[12.5px] text-ink-dim">{res.reason}</p>}
          {res.command && <CodeBlock title="command" code={res.command} wrap />}
          {res.findings.length > 0 && (
            <ul className="grid gap-1">
              {res.findings.slice(0, 100).map((f, i) => (
                <li key={i} className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 text-[12px]">
                  {f.file ? <FileLink repo={repo} path={f.file} className="truncate text-[11.5px]" /> : <span />}
                  <span className="min-w-0 break-words text-ink">
                    {f.line ? <Mono className="mr-1.5 text-ink-faint">:{f.line}</Mono> : null}
                    {f.message}
                  </span>
                </li>
              ))}
              {res.count > res.findings.length && <li className="text-[12px] text-ink-faint">… {num(res.count - res.findings.length)} more</li>}
            </ul>
          )}
          {res.output_tail && <CodeBlock title="output (tail)" code={res.output_tail} maxHeight={260} wrap />}
        </div>
      )}
    </li>
  );
}

export function ScriptLibrary({ repo, onRan }: { repo: string; onRan?: () => void }) {
  const q = useQuery(`scripts:${repo}`, () => api.scripts(repo));
  const runtime = useQuery(`runtime:${repo}`, () => api.runtime(repo));
  const history = useQuery(`script-runs:${repo}`, () => api.scriptRuns(repo, 5));
  const [shownRun, setShownRun] = useState<ScriptRunSummary | null>(null);
  const job = useJob(() => q.reload());
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [eco, setEco] = useState("");
  const [onlyApplies, setOnlyApplies] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [live, setLive] = useState<Record<string, Live>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const data = q.data;
  const canExec = data?.can_exec ?? false;
  const all = useMemo(() => data?.scripts ?? [], [data]);
  const operator = canExec && !data?.public;
  const blocked = (s: Script) => !s.applies || (s.executes && !canExec) || (s.local_only && !operator);
  const installBlocked = !canExec ? (data?.exec_reason ?? "installs need the run gate") : job.job?.running ? "an install is running" : running ? "scripts are running" : undefined;

  // the newest recorded batch fills the rows until something runs here
  const latest = history.data?.runs[0];
  const loadedRun = useRef<string | null>(null);
  useEffect(() => {
    if (!latest || running || loadedRun.current === latest.id) return;
    loadedRun.current = latest.id;
    let live = true;
    api
      .scriptRun(repo, latest.id)
      .then((r) => {
        if (!live) return;
        setLive(Object.fromEntries(r.results.map((x) => [x.id, x])));
        setShownRun(latest);
        const bad = r.results.find((x) => x.status === "failed" || x.status === "error");
        setOpen((o) => o ?? bad?.id ?? null);
      })
      .catch(() => {
        /* the rows simply stay empty; the run list below still names it */
      });
    return () => {
      live = false;
    };
  }, [latest, repo, running]);

  const missing = useMemo(
    () => [...new Set(all.filter((s) => s.applies && s.available === false && (s.install?.method === "pip" || s.install?.method === "npm")).map((s) => s.install!.tool ?? s.tool!))].slice(0, 20),
    [all],
  );
  const needsSetup = !!data && (!data.env.python || !data.env.pytest) && all.some((s) => s.applies && s.install?.method === "setup");
  const onInstall = (i: ScriptInstall) => {
    if (i.method === "setup") void job.run("Setting up the test environment", setupStreamUrl(repo), {}, setUp);
    else if (i.tool) void job.run(`Installing ${i.tool}`, installStreamUrl(repo), { tools: [i.tool] }, installed);
  };

  const ecosystems = useMemo(() => [...new Set(all.filter((s) => !onlyApplies || s.applies).map((s) => s.ecosystem))].sort(), [all, onlyApplies]);
  const shown = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((s) => {
      if (onlyApplies && !s.applies) return false;
      if (category && s.category !== category) return false;
      if (eco && s.ecosystem !== eco) return false;
      const hay = `${s.id} ${s.name} ${s.summary} ${s.ecosystem} ${s.tags.join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [all, text, category, eco, onlyApplies]);
  const groups = useMemo(() => {
    const by = new Map<string, Script[]>();
    for (const s of shown) by.set(s.category, [...(by.get(s.category) ?? []), s]);
    return (data?.categories ?? []).filter((c) => by.has(c.id)).map((c) => [c, by.get(c.id)!] as const);
  }, [shown, data]);

  const tally = useMemo(() => {
    const c: Record<ScriptStatus, number> = { passed: 0, warned: 0, failed: 0, error: 0, skipped: 0 };
    for (const v of Object.values(live)) if (v !== "running") c[v.status]++;
    return c;
  }, [live]);
  const ran = Object.keys(live).length > 0;

  const set = (ids: string[], on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      for (const i of ids) {
        if (on) n.add(i);
        else n.delete(i);
      }
      return n;
    });
  const pickable = shown.filter((s) => !blocked(s));
  const quick = all.filter((s) => s.applies && !s.executes).map((s) => s.id);

  const start = async (ids = [...picked]) => {
    if (!ids.length || ids.length > MAX) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setError(undefined);
    setOpen(null);
    setLive({});
    setShownRun(null);
    setRunning(true);
    try {
      await postStream(
        scriptsStreamUrl(repo),
        { ids },
        (event, d) => {
          if (event === "script") setLive((l) => ({ ...l, [(d as { id: string }).id]: "running" }));
          else if (event === "result") {
            const r = d as ScriptResult;
            setLive((l) => ({ ...l, [r.id]: r }));
            if (r.status === "failed" || r.status === "error") setOpen((o) => o ?? r.id);
          } else if (event === "error") setError((d as { detail: string }).detail);
        },
        ctl.signal,
      );
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === ctl) {
        setRunning(false);
        // a stopped run leaves "running" rows; drop them rather than show a spinner forever
        setLive((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== "running")));
        loadedRun.current = null;
        history.reload();
        onRan?.();
      }
    }
  };

  return (
    <Sheet
      no="B · Script library"
      title={data ? `${num(data.applicable)} of ${num(data.total)} built-in scripts apply here` : "Built-in scripts"}
      note="Checks, graph questions, linters, type checkers, test suites and Aftershock's own probes. Tick what you want, or ask the agent to pick. A missing tool installs from a fixed recipe; nothing else is downloaded."
      tone="library"
      flush
      action={
        running ? (
          <Button variant="outline" size="sm" onClick={() => abort.current?.abort()}>
            <Stop className="size-3.5" /> Stop
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => start(quick.slice(0, MAX))} disabled={!quick.length}>
              Run all quick checks
            </Button>
            <Button size="sm" onClick={() => start()} disabled={!picked.size || picked.size > MAX}>
              <Play className="size-3.5" /> Run {picked.size ? num(picked.size) : ""} selected
            </Button>
          </>
        )
      }
    >
      {q.loading && !data ? (
        <Skeleton className="mx-[clamp(14px,2vw,24px)] mb-4 h-40" />
      ) : q.error ? (
        <div className={cn(PAD, "pb-4")}>
          <ErrorNote error={q.error} onRetry={q.reload} />
        </div>
      ) : (
        <>
          <div className={cn(PAD, "grid items-center gap-2 pb-3 sm:grid-cols-[minmax(0,1fr)_200px_auto]")}>
            <label className="relative min-w-0">
              <span className="sr-only">Search scripts</span>
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="secrets, mypy, flaky, docker…" spellCheck={false} className="gt-field w-full !pl-8" />
            </label>
            <label className="sr-only" htmlFor="script-eco">
              Ecosystem
            </label>
            <select id="script-eco" value={eco} onChange={(e) => setEco(e.target.value)} className="gt-field w-full">
              <option value="">every ecosystem</option>
              {ecosystems.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-[12.5px] whitespace-nowrap text-ink-dim">
              <input type="checkbox" className="size-3.5 accent-mark" checked={onlyApplies} onChange={(e) => setOnlyApplies(e.target.checked)} />
              applies here
            </label>
          </div>

          <div className={cn(PAD, "flex flex-wrap gap-1.5 pb-3")} role="group" aria-label="Category">
            {[{ id: "", label: "All", applicable: data?.applicable ?? 0 }, ...(data?.categories ?? [])].map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                aria-pressed={category === c.id}
                title={c.id ? c.label : undefined}
                className={cn(
                  "border px-2 py-1 font-mono text-[11px] tracking-[.06em] uppercase transition-colors",
                  category === c.id ? "border-mark text-mark" : "border-line text-ink-dim hover:text-ink",
                )}
              >
                {c.id || "all"} <span className="text-ink-faint">{c.applicable}</span>
              </button>
            ))}
          </div>

          {!canExec && (
            <p className={cn(PAD, "pb-3 text-[12.5px] text-ink-dim")}>
              <Chip tone="mark">runs code</Chip> scripts are off: {data?.exec_reason ?? "the run gate is closed"} Checks and graph scripts still run.
            </p>
          )}
          {data?.public && (
            <p className={cn(PAD, "pb-3 text-[12.5px] text-ink-dim")}>
              <Chip tone="info">showcase</Chip> Anyone can run, set up and install tools for this repo. One public run at a time across the site
              {runtime.data?.timeout ? `, ${num(runtime.data.timeout)} s at most` : ""}; operator-only scripts stay off.
            </p>
          )}

          {(needsSetup || missing.length > 0 || job.job) && (
            <div className={cn(PAD, "grid gap-2 pb-4")}>
              {(needsSetup || missing.length > 0) && !job.job?.running && (
                <div className="flex flex-wrap items-center gap-2 border border-dashed border-line px-3 py-2 text-[12.5px] text-ink-dim">
                  <span className="min-w-0 flex-1">
                    {needsSetup
                      ? "This repo has no test environment yet: test suites, coverage and the flaky/isolation probes need one."
                      : `${num(missing.length)} tool${missing.length === 1 ? "" : "s"} these scripts use ${missing.length === 1 ? "is" : "are"} not installed: ${missing.join(", ")}.`}
                  </span>
                  {needsSetup && (
                    <Button size="sm" onClick={() => onInstall({ method: "setup", package: "", hint: "" })} disabled={!!installBlocked} title={installBlocked}>
                      <Download className="size-3.5" /> Set up test environment
                    </Button>
                  )}
                  {missing.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => void job.run(`Installing ${missing.join(", ")}`, installStreamUrl(repo), { tools: missing }, installed)} disabled={!!installBlocked} title={installBlocked}>
                      <Download className="size-3.5" /> Install {missing.length === 1 ? missing[0] : `all ${num(missing.length)}`}
                    </Button>
                  )}
                </div>
              )}
              {job.job && <JobLog job={job.job} onStop={job.stop} onClose={job.clear} />}
            </div>
          )}

          {shownRun && !running && (
            <p className={cn(PAD, "pb-2 text-[12px] text-ink-dim")}>
              Showing the last run: {relTime(shownRun.started)}, from {TRIGGER[shownRun.trigger] ?? shownRun.trigger}, {num(shownRun.scripts)} script
              {shownRun.scripts === 1 ? "" : "s"} in {shownRun.seconds < 10 ? shownRun.seconds.toFixed(1) : num(shownRun.seconds)} s{shownRun.stopped ? " (stopped)" : ""}.
            </p>
          )}

          {ran && (
            <div className={cn(PAD, "grid grid-cols-3 gap-x-8 gap-y-3 pb-4 sm:grid-cols-5")} aria-live="polite">
              <Figure label="Passed" value={num(tally.passed)} tone={tally.passed ? "text-pass" : undefined} />
              <Figure label="Warned" value={num(tally.warned)} tone={tally.warned ? "text-warn" : undefined} />
              <Figure label="Failed" value={num(tally.failed)} tone={tally.failed ? "text-fail" : undefined} />
              <Figure label="Errors" value={num(tally.error)} tone={tally.error ? "text-fail" : undefined} />
              <Figure label="Skipped" value={num(tally.skipped)} />
            </div>
          )}
          {error && (
            <div className={cn(PAD, "pb-3")}>
              <ErrorNote error={error} />
            </div>
          )}

          <div className={cn(PAD, "flex flex-wrap items-center gap-3 border-t border-line py-2 text-[12px] text-ink-dim")}>
            <span>
              {num(shown.length)} shown · {num(picked.size)} selected{picked.size > MAX ? ` — at most ${MAX} per run` : ""}
            </span>
            <button type="button" className="underline-offset-2 hover:text-mark hover:underline" onClick={() => set(pickable.map((s) => s.id), true)} disabled={!pickable.length}>
              select shown
            </button>
            <button type="button" className="underline-offset-2 hover:text-mark hover:underline" onClick={() => setPicked(new Set())} disabled={!picked.size}>
              clear
            </button>
          </div>

          {groups.length ? (
            <div className="flex max-h-[720px] flex-col gap-3 overflow-y-auto pb-2">
              {groups.map(([c, rows]) => (
                <section key={c.id}>
                  <h3 className={cn("gt-label sticky top-0 z-[1] bg-[var(--gt-library)] pt-2 pb-1 normal-case", PAD)}>
                    {c.label} <span className="text-ink-faint">· {rows.length}</span>
                  </h3>
                  <ul>
                    {rows.map((s) => (
                      <Row
                        key={s.id}
                        repo={repo}
                        s={s}
                        live={live[s.id]}
                        checked={picked.has(s.id)}
                        disabled={running || blocked(s)}
                        why={
                          !s.applies
                            ? "nothing in this repo for it to look at"
                            : s.executes && !canExec
                              ? (data?.exec_reason ?? undefined)
                              : s.local_only && !operator
                                ? "operator only: runs on the server operator's own machine"
                                : undefined
                        }
                        installBlocked={installBlocked}
                        onInstall={onInstall}
                        open={open === s.id}
                        onCheck={(v) => set([s.id], v)}
                        onToggle={() => setOpen(open === s.id ? null : s.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className={cn(PAD, "pb-5 text-[13px] text-ink-dim")}>No script matches. {onlyApplies && "Untick “applies here” to search the whole library."}</p>
          )}
        </>
      )}
    </Sheet>
  );
}
