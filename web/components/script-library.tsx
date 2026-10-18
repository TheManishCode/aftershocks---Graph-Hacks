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
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { Chip, CodeBlock, ErrorNote, Figure, Mono, Sheet, Skeleton } from "@/components/gt";
import { ChevronRight, CircleAlert, CircleCheck, Loader2, Play, Search, Stop, TriangleAlert } from "@/components/icons";
import { FileLink } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { api, scriptsStreamUrl, type Script, type ScriptResult, type ScriptStatus } from "@/lib/api";
import { num } from "@/lib/format";
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
}) {
  const res = live && live !== "running" ? live : undefined;
  const detail = res && (res.findings.length > 0 || res.output_tail || res.reason || res.command);
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
            {!s.applies && <Chip>n/a here</Chip>}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-ink-dim">{s.summary}</span>
        </button>
        <Mono className={cn("hidden max-w-[34ch] truncate text-right text-[11px] sm:block", res?.status === "failed" || res?.status === "error" ? "text-fail" : "text-ink-dim")}>
          {tally}
        </Mono>
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", detail ? "text-ink-faint" : "invisible", open && "rotate-90")} />
      </div>
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
  const blocked = (s: Script) => !s.applies || (s.executes && !canExec);

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
        onRan?.();
      }
    }
  };

  return (
    <Sheet
      no="B · Script library"
      title={data ? `${num(data.applicable)} of ${num(data.total)} built-in scripts apply here` : "Built-in scripts"}
      note="Checks, graph questions, linters, type checkers and test suites. Tick what you want, or ask the agent to pick. Tools are used if installed, never downloaded."
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
                        why={!s.applies ? "nothing in this repo for it to look at" : s.executes && !canExec ? (data?.exec_reason ?? undefined) : undefined}
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
