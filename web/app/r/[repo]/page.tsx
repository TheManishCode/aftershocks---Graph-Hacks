"use client";

/**
 * Repository overview — the flagship page, and the one that teaches the system.
 *
 * Reading order is deliberate: identity → the six numbers that describe the
 * index → where to go next → structure → debt. Nothing here invents a box or a
 * colour; it composes components/ds. The "where to go next" cards are generated
 * from the nav registry, so a new page appears here the day it is declared.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { AlertTriangle, ArrowRight, Refresh, Zap } from "@/components/icons";
import {
  Bento,
  Distribution,
  Empty,
  ErrorNote,
  Grid,
  Meter,
  Metric,
  Page,
  Panel,
  Scroller,
  Slab,
  Spinner,
  Stack,
} from "@/components/ds";
import { GraphCanvas, type GEdge, type GNode } from "@/components/graph-canvas";
import { JobProgress, useIndexJob } from "@/components/index-job";
import { FileLink, Receipts, SymLink } from "@/components/kit";
import { REPO_NAV, repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { api, type Overview } from "@/lib/api";
import { HOW, num, pct, relTime, symName, tint } from "@/lib/format";
import { useAction, useQuery, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** Every page except this one, in rail order. Grows with the nav registry. */
const QUICK = REPO_NAV.filter((n) => n.href !== "");

/** Written out, not built from a template: Tailwind only sees literal classes. */
const SERIES = ["bg-data-1", "bg-data-2", "bg-data-3", "bg-data-4", "bg-data-5", "bg-data-6"];

function Subsystems({ repo, d }: { repo: string; d: Overview }) {
  const [sel, setSel] = useState<number | null>(null);
  const linked = new Set(d.links.flatMap((l) => [l.src, l.dst]));
  const { nodes, edges } = useMemo(() => {
    const ns: GNode[] = d.subsystems
      .filter((s) => linked.has(s.id))
      .map((s) => ({
        id: String(s.id),
        label: s.name,
        sub: `${s.size} files`,
        tone: "bg-surface-raised",
        group: s.name,
        value: s.size / Math.max(...d.subsystems.map((x) => x.size)),
      }));
    const es: GEdge[] = d.links.map((l) => ({ src: String(l.src), dst: String(l.dst), weight: Math.log2(1 + l.weight), label: String(l.weight) }));
    return { nodes: ns, edges: es };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  const max = Math.max(1, ...d.subsystems.map((s) => s.size));
  const chosen = d.subsystems.find((s) => s.id === sel);
  return (
    <Panel
      title={`Subsystems · ${d.subsystems.length}`}
      note="label propagation over the import graph"
      bodyClassName="p-3"
    >
      <Grid cols="main-aside">
        {nodes.length > 1 ? (
          <GraphCanvas nodes={nodes} edges={edges} height={380} selected={sel !== null ? String(sel) : undefined} onSelect={(id) => setSel(Number(id))} />
        ) : (
          <div className="grid h-[380px] place-items-center rounded-nested border border-dashed border-line-strong text-body-sm text-ink-muted">
            No links between subsystems to draw.
          </div>
        )}
        <div className="min-w-0">
          {chosen ? (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="size-2.5 rounded-full" style={{ background: tint(chosen.name) }} />
                <span className="font-mono text-body-sm text-ink-strong">{chosen.name}</span>
                <span className="text-caption text-ink-muted">
                  {chosen.size} files{chosen.size > chosen.files.length ? `, first ${chosen.files.length} shown` : ""}
                </span>
                <Button variant="ghost" size="sm" className="ml-auto h-6 text-micro" onClick={() => setSel(null)}>
                  All
                </Button>
              </div>
              <Scroller className="max-h-[330px] space-y-0.5 text-caption">
                {chosen.files.map((f) => (
                  <div key={f} className="truncate px-1 py-0.5">
                    <FileLink repo={repo} path={f} />
                  </div>
                ))}
              </Scroller>
            </div>
          ) : (
            <Scroller className="max-h-[380px] space-y-1.5 pr-1">
              {d.subsystems.map((s) => (
                <button key={s.id} type="button" onClick={() => setSel(s.id)} className="group block w-full text-left">
                  <div className="flex items-center gap-2 text-caption">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: tint(s.name) }} />
                    <span className="truncate font-mono text-ink group-hover:text-ink-strong">{s.name}</span>
                    <span className="ml-auto font-mono text-micro text-ink-muted tabular-nums">{s.size}</span>
                  </div>
                  <div className="mt-1 ml-4 h-1 overflow-hidden rounded-full bg-line-strong">
                    <div className="h-full rounded-full" style={{ width: `${(s.size / max) * 100}%`, background: tint(s.name, 0.7) }} />
                  </div>
                </button>
              ))}
            </Scroller>
          )}
        </div>
      </Grid>
    </Panel>
  );
}

export default function OverviewPage() {
  const repo = useRepo();
  const q = useQuery(repo ? `overview:${repo}` : null, () => api.overview(repo));
  const reindex = useAction(api.index);
  const [job, setJob] = useState<number | null>(null);
  const state = useIndexJob(job !== null ? repo : null, job ?? 0, q.reload);
  const d = q.data;

  if (q.error)
    return (
      <Page>
        {q.error.status === 404 ? <Empty title={`No repository named “${repo}”`}>Index it from the home page.</Empty> : <ErrorNote error={q.error} />}
      </Page>
    );
  if (!d)
    return (
      <Page>
        <Spinner />
      </Page>
    );

  const r = d.repo;
  const edgeTotal = Object.values(r.edge_mix).reduce((a, b) => a + b, 0) || 1;
  const langTotal = Object.values(r.langs).reduce((a, b) => a + b, 0) || 1;

  return (
    <Page>
      <div className="mb-[var(--section-gap)] flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="mb-2 font-mono text-micro uppercase text-brand">Repository</p>
          <h1 className="font-mono text-display leading-none">{r.name}</h1>
          <p className="mt-2 font-mono text-caption text-ink-muted">
            {r.commit ? r.commit.slice(0, 12) : "no commit"} · indexed {relTime(r.indexed_at)}
            {r.history_commits ? ` · ${r.history_commits} commits of history` : ""}
            {r.url ? ` · ${r.url}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Receipts r={d.receipts} />
          {r.url && (
            <Button
              variant="outline"
              size="sm"
              disabled={reindex.loading || state?.status === "running"}
              onClick={async () => {
                const res = await reindex.run({ url: r.url, name: r.name });
                if (res) setJob(res.after);
              }}
            >
              <Refresh className="size-4" /> Re-index
            </Button>
          )}
        </div>
      </div>

      <Stack>
        {reindex.error && <ErrorNote error={reindex.error} />}
        {job !== null && state && <JobProgress repo={repo} job={state} />}

        {/* The six numbers that describe the index. Resolution carries its own
            bar because it is the one figure that says how much to trust the rest. */}
        <Panel tone="raised">
          <Grid cols={6}>
            <Metric label="Files" value={num(d.counts.files)} />
            <Metric label="Symbols" value={num(d.counts.symbols)} />
            <Metric label="Call edges" value={num(d.counts.calls)} />
            <Metric label="Import edges" value={num(d.counts.imports)} />
            <Metric
              label="Call sites resolved"
              value={pct(r.resolution_rate)}
              tone="text-brand"
              hint={
                r.repo_resolution_rate != null
                  ? `${pct(r.repo_resolution_rate)} excl. ${num(r.external_sites ?? 0)} library calls`
                  : `${num(r.resolved_sites)} of ${num(r.call_sites)}`
              }
              aside={<Meter value={r.resolution_rate} barClassName="bg-brand" />}
            />
            <Metric label="Import cycles" value={num(d.cycle_count)} tone={d.cycle_count ? "text-sev-medium" : undefined} hint={d.cycle_count ? "worth untangling" : "none"} />
          </Grid>
        </Panel>

        <Slab title="Ask the graph" description="Every answer carries its evidence: the hops, how each edge resolved, and what the query cost.">
          <Grid cols={3}>
            {QUICK.map((x) => (
              <Bento key={x.href} as={Link} href={repoHref(repo, x.href)}>
                <x.Icon className="mb-2.5 size-5 text-ink-muted transition-colors group-hover:text-brand" aria-hidden />
                <div className="text-body text-ink-strong">{x.label}</div>
                <div className="mt-1 text-body-sm text-ink-muted">{x.blurb}</div>
              </Bento>
            ))}
          </Grid>
        </Slab>

        <Subsystems repo={repo} d={d} />

        <Grid cols={2}>
          <Panel title="Load-bearing symbols" note="PageRank over calls" bodyClassName="p-2">
            <div className="space-y-0.5">
              {d.central.slice(0, 12).map((s) => (
                <div key={s.id} className="flex min-h-[var(--row-h)] items-center gap-2 rounded-inner px-2 text-caption hover:bg-accent">
                  <SymLink repo={repo} id={s.id} name={s.qname} className="min-w-0 truncate text-body-sm" />
                  <span className="hidden truncate font-mono text-micro text-ink-faint sm:inline">{s.file}</span>
                  <span className="ml-auto shrink-0 font-mono text-micro text-ink-muted tabular-nums">{s.fan_in}↙</span>
                  <Link
                    href={repoHref(repo, `/impact?t=${encodeURIComponent(s.id)}&change=signature`)}
                    className="shrink-0 rounded p-0.5 text-ink-faint hover:text-brand"
                    // No title: it would differ from the accessible name, and a tooltip
                    // is not where a control should explain itself.
                    aria-label={`Impact of a signature change to ${symName(s.qname)}`}
                  >
                    <Zap className="size-3.5" />
                  </Link>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Hotspots" note="churn × complexity" flush>
            <div className="overflow-x-auto">
              <table className="w-full text-caption">
                <thead className="text-left font-mono text-micro uppercase text-ink-muted">
                  <tr className="border-b border-line">
                    <th className="px-3 py-2 font-normal">File</th>
                    <th className="w-px px-2 py-2 text-right font-normal whitespace-nowrap">Churn</th>
                    <th className="w-px px-2 py-2 text-right font-normal whitespace-nowrap">Commits</th>
                    <th className="w-px px-2 py-2 text-right font-normal whitespace-nowrap">Complexity</th>
                    <th className="w-px px-3 py-2 text-right font-normal whitespace-nowrap">Fan-in</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {d.hotspots.slice(0, 12).map((h) => (
                    <tr key={h.path} className="border-b border-line/50 last:border-0 hover:bg-accent">
                      <td className="w-full max-w-0 truncate px-3 py-1.5">
                        <FileLink repo={repo} path={h.path} />
                      </td>
                      <td className="px-2 py-1.5 text-right text-ink">{num(h.churn)}</td>
                      <td className="px-2 py-1.5 text-right text-ink-muted">{num(h.commits)}</td>
                      <td className="px-2 py-1.5 text-right text-ink-muted">{num(h.complexity)}</td>
                      <td className="px-3 py-1.5 text-right text-ink-muted">{num(h.fan_in)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </Grid>

        <Grid cols={3}>
          <Panel title="How call edges were resolved">
            <ul className="space-y-2.5">
              {Object.entries(r.edge_mix)
                .sort((a, b) => b[1] - a[1])
                .map(([how, n]) => (
                  <li key={how} className="text-caption">
                    <div className="mb-1 flex justify-between gap-2">
                      <span className="truncate text-ink">{HOW[how] ?? how}</span>
                      <span className="shrink-0 font-mono text-ink-muted tabular-nums">
                        {num(n)} · {pct(n / edgeTotal)}
                      </span>
                    </div>
                    <Meter value={n / edgeTotal} barClassName="bg-brand/70" />
                  </li>
                ))}
            </ul>
          </Panel>
          <Panel title="Languages">
            <Distribution
              className="mb-3"
              parts={Object.entries(r.langs)
                .sort((a, b) => b[1] - a[1])
                .map(([lang, n], i) => ({ key: lang, value: n, className: SERIES[i % SERIES.length], label: `${lang}: ${n} files` }))}
            />
            <ul className="space-y-2">
              {Object.entries(r.langs)
                .sort((a, b) => b[1] - a[1])
                .map(([lang, n], i) => (
                  <li key={lang} className="flex items-center gap-2 text-caption">
                    <span className={cn("size-2 shrink-0 rounded-full", SERIES[i % SERIES.length])} aria-hidden />
                    <span className="truncate text-ink">{lang}</span>
                    <span className="ml-auto shrink-0 font-mono text-ink-muted tabular-nums">
                      {num(n)} · {pct(n / langTotal)}
                    </span>
                  </li>
                ))}
            </ul>
          </Panel>
          <Panel title="Where resolution is weakest" note="unresolved call sites" bodyClassName="p-2">
            {r.unresolved_top.length ? (
              <ul className="space-y-0.5">
                {r.unresolved_top.slice(0, 10).map(([f, n]) => (
                  <li key={f} className="flex items-center gap-2 px-2 py-0.5 text-caption">
                    <FileLink repo={repo} path={f} className="min-w-0 truncate" />
                    <span className="ml-auto shrink-0 font-mono text-micro text-ink-muted tabular-nums">{n}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">Every call site resolved.</p>
            )}
            <p className="mt-2 px-2 text-micro text-ink-faint">
              {r.external_sites != null
                ? "Calls whose target could be repo code but was not found. Calls provably into libraries, builtins and literals are excluded."
                : "Mostly calls into libraries and builtins, which are outside the repo by design. Re-index to separate them."}
            </p>
          </Panel>
        </Grid>

        <Grid cols={2}>
          <Panel title={`Import cycles · ${d.cycle_count}`} bodyClassName="p-2">
            {d.cycles.length ? (
              <ul className="space-y-2">
                {d.cycles.slice(0, 10).map((c, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1.5 px-2 text-caption">
                    {(c.example.length ? c.example : c.files).map((f, j) => (
                      <span key={j} className="flex items-center gap-1.5">
                        {j > 0 && <ArrowRight className="size-3 text-ink-faint" />}
                        <FileLink repo={repo} path={f} />
                      </span>
                    ))}
                    {c.size > 2 && <span className="text-ink-muted">· {num(c.size)} files in the cycle</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">No import cycles.</p>
            )}
          </Panel>
          <Panel title={`Probably dead · ${d.dead_code.length}`} bodyClassName="p-2">
            {d.dead_code.length ? (
              <Scroller className="max-h-80 space-y-0.5">
                {d.dead_code.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 rounded-inner px-2 py-1 text-caption" title={s.reason}>
                    <SymLink repo={repo} id={s.id} name={s.qname} className="min-w-0 truncate text-body-sm" />
                    <span className="hidden truncate font-mono text-micro text-ink-faint sm:inline">{s.file}</span>
                    <span
                      className={cn(
                        "ml-auto shrink-0 rounded-full px-1.5 font-mono text-micro uppercase",
                        s.category === "private" ? "bg-surface text-ink-muted" : "bg-sev-medium/12 text-sev-medium",
                      )}
                    >
                      {s.category}
                    </span>
                    <span className="w-10 shrink-0 text-right font-mono text-micro text-ink-faint tabular-nums">{s.loc}L</span>
                  </div>
                ))}
              </Scroller>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">Nothing unreferenced.</p>
            )}
            <p className="mt-2 flex items-start gap-1.5 px-2 text-micro text-ink-faint">
              <AlertTriangle className="mt-px size-3.5 shrink-0" /> Static analysis: code reached by reflection, string dispatch or external callers looks dead here.
            </p>
          </Panel>
        </Grid>
      </Stack>
    </Page>
  );
}
