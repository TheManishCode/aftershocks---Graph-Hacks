"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { AlertTriangle, ArrowRight, Bug, Flow, GitDiff, MessageSquareText, Refresh, Zap } from "@/components/icons";
import { GraphCanvas, type GEdge, type GNode } from "@/components/graph-canvas";
import { JobProgress, useIndexJob } from "@/components/index-job";
import { Empty, ErrorNote, FileLink, Meter, Page, Receipts, Spinner, Stat, SymLink, Tile } from "@/components/kit";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { api, type Overview } from "@/lib/api";
import { HOW, num, pct, relTime, symName, tint } from "@/lib/format";
import { useAction, useQuery, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const QUICK = [
  { href: "/impact", icon: Zap, title: "What breaks if I change…", sub: "ranked blast radius with why-chains" },
  { href: "/diff", icon: GitDiff, title: "Review a change set", sub: "symbols changed and their impact" },
  { href: "/path", icon: Flow, title: "Why does A depend on B?", sub: "the evidence chain, edge by edge" },
  { href: "/culprit", icon: Bug, title: "Tests are failing", sub: "rank suspects by reachability" },
  { href: "/ask", icon: MessageSquareText, title: "Ask in plain English", sub: "an agent over the same tools" },
];

function Subsystems({ repo, d }: { repo: string; d: Overview }) {
  const [sel, setSel] = useState<number | null>(null);
  const linked = new Set(d.links.flatMap((l) => [l.src, l.dst]));
  const { nodes, edges } = useMemo(() => {
    const ns: GNode[] = d.subsystems
      .filter((s) => linked.has(s.id))
      .map((s) => ({ id: String(s.id), label: s.name, sub: `${s.size} files`, tone: "bg-smoke", group: s.name, value: s.size / Math.max(...d.subsystems.map((x) => x.size)) }));
    const es: GEdge[] = d.links.map((l) => ({ src: String(l.src), dst: String(l.dst), weight: Math.log2(1 + l.weight), label: String(l.weight) }));
    return { nodes: ns, edges: es };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  const max = Math.max(1, ...d.subsystems.map((s) => s.size));
  const chosen = d.subsystems.find((s) => s.id === sel);
  return (
    <Tile title={`Subsystems · ${d.subsystems.length}`} action={<span className="text-[11px] text-fog">label propagation over the import graph</span>} bodyClassName="p-3">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {nodes.length > 1 ? (
          <GraphCanvas nodes={nodes} edges={edges} height={360} selected={sel !== null ? String(sel) : undefined} onSelect={(id) => setSel(Number(id))} />
        ) : (
          <div className="grid h-[360px] place-items-center rounded-lg border border-dashed border-graphite text-sm text-fog">No links between subsystems to draw.</div>
        )}
        <div className="min-w-0">
          {chosen ? (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="size-2.5 rounded-sm" style={{ background: tint(chosen.name) }} />
                <span className="font-mono text-sm text-paper">{chosen.name}</span>
                <span className="text-xs text-fog">
                  {chosen.size} files{chosen.size > chosen.files.length ? `, first ${chosen.files.length} shown` : ""}
                </span>
                <Button variant="ghost" size="sm" className="ml-auto h-6 text-[11px]" onClick={() => setSel(null)}>
                  All
                </Button>
              </div>
              <ul className="max-h-[310px] space-y-0.5 overflow-y-auto text-xs">
                {chosen.files.map((f) => (
                  <li key={f} className="truncate px-1 py-0.5">
                    <FileLink repo={repo} path={f} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="max-h-[360px] space-y-1.5 overflow-y-auto pr-1">
              {d.subsystems.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setSel(s.id)} className="group w-full text-left">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="size-2 shrink-0 rounded-sm" style={{ background: tint(s.name) }} />
                      <span className="truncate font-mono text-mist group-hover:text-paper">{s.name}</span>
                      <span className="ml-auto font-mono text-[11px] text-fog">{s.size}</span>
                    </div>
                    <div className="mt-1 ml-4 h-1 overflow-hidden rounded-full bg-graphite">
                      <div className="h-full rounded-full" style={{ width: `${(s.size / max) * 100}%`, background: tint(s.name, 0.7) }} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Tile>
  );
}

export default function OverviewPage() {
  const repo = useRepo();
  const q = useQuery(repo ? `overview:${repo}` : null, () => api.overview(repo));
  const reindex = useAction(api.index);
  const [job, setJob] = useState<number | null>(null);
  const state = useIndexJob(job !== null ? repo : null, job ?? 0, q.reload);
  const d = q.data;

  if (q.error) return <Page>{q.error.status === 404 ? <Empty title={`No repository named “${repo}”`}>Index it from the home page.</Empty> : <ErrorNote error={q.error} />}</Page>;
  if (!d) return <Page><Spinner /></Page>;

  const r = d.repo;
  const edgeTotal = Object.values(r.edge_mix).reduce((a, b) => a + b, 0) || 1;
  const langTotal = Object.values(r.langs).reduce((a, b) => a + b, 0) || 1;

  return (
    <Page>
      <div className="mb-6 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="mb-2 font-mono text-[11px] tracking-[0.12em] text-gold uppercase">Repository</p>
          <h1 className="font-mono text-[34px] leading-none not-italic">{r.name}</h1>
          <p className="mt-2 font-mono text-xs text-fog">
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
      {reindex.error && <ErrorNote error={reindex.error} className="mb-4" />}
      {job !== null && state && <div className="mb-4"><JobProgress repo={repo} job={state} /></div>}

      <div className="mb-4 grid grid-cols-2 gap-4 rounded-xl border border-border bg-card/50 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Files" value={num(d.counts.files)} />
        <Stat label="Symbols" value={num(d.counts.symbols)} />
        <Stat label="Call edges" value={num(d.counts.calls)} />
        <Stat label="Import edges" value={num(d.counts.imports)} />
        <Stat label="Call sites resolved" value={pct(r.resolution_rate)} hint={r.repo_resolution_rate != null ? `${pct(r.repo_resolution_rate)} excl. ${num(r.external_sites ?? 0)} library/builtin calls` : `${num(r.resolved_sites)} of ${num(r.call_sites)}`} tone="text-gold" />
        <Stat label="Import cycles" value={num(d.cycle_count)} tone={d.cycle_count ? "text-ov-missed" : undefined} />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {QUICK.map((x) => (
          <Link
            key={x.href}
            href={repoHref(repo, x.href)}
            className="group rounded-xl border border-border bg-card/40 p-3.5 transition-colors hover:border-gold/40 hover:bg-card/70"
          >
            <x.icon className="mb-2 size-5 text-fog group-hover:text-gold" />
            <div className="text-sm text-paper">{x.title}</div>
            <div className="mt-0.5 text-xs text-fog">{x.sub}</div>
          </Link>
        ))}
      </div>

      <div className="mb-4">
        <Subsystems repo={repo} d={d} />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Tile title="Load-bearing symbols" action={<span className="text-[11px] text-fog">PageRank over calls</span>} bodyClassName="p-2">
          <ul className="space-y-0.5">
            {d.central.slice(0, 12).map((s) => (
              <li key={s.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-white/[0.03]">
                <SymLink repo={repo} id={s.id} name={s.qname} className="min-w-0 truncate text-[12.5px]" />
                <span className="hidden truncate font-mono text-[10.5px] text-fog sm:inline">{s.file}</span>
                <span className="ml-auto shrink-0 font-mono text-[10.5px] text-fog">{s.fan_in}↙</span>
                <Link
                  href={repoHref(repo, `/impact?t=${encodeURIComponent(s.id)}&change=signature`)}
                  className="shrink-0 rounded p-0.5 text-fog hover:text-gold"
                  aria-label={`Impact of changing ${symName(s.qname)}`}
                  title="Impact of a signature change"
                >
                  <Zap className="size-3.5" />
                </Link>
              </li>
            ))}
          </ul>
        </Tile>
        <Tile title="Hotspots" action={<span className="text-[11px] text-fog">churn × complexity</span>} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-[11px] text-fog">
                <tr className="border-b border-border/70">
                  <th className="px-3 py-2 font-normal">File</th>
                  <th className="w-px whitespace-nowrap px-2 py-2 text-right font-normal">Churn</th>
                  <th className="w-px whitespace-nowrap px-2 py-2 text-right font-normal">Commits</th>
                  <th className="w-px whitespace-nowrap px-2 py-2 text-right font-normal">Complexity</th>
                  <th className="w-px whitespace-nowrap px-3 py-2 text-right font-normal">Fan-in</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {d.hotspots.slice(0, 12).map((h) => (
                  <tr key={h.path} className="border-b border-border/40 last:border-0">
                    <td className="w-full max-w-0 truncate px-3 py-1.5">
                      <FileLink repo={repo} path={h.path} />
                    </td>
                    <td className="px-2 py-1.5 text-right text-mist">{num(h.churn)}</td>
                    <td className="px-2 py-1.5 text-right">{num(h.commits)}</td>
                    <td className="px-2 py-1.5 text-right">{num(h.complexity)}</td>
                    <td className="px-3 py-1.5 text-right">{num(h.fan_in)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Tile>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Tile title="How call edges were resolved">
          <ul className="space-y-2.5">
            {Object.entries(r.edge_mix)
              .sort((a, b) => b[1] - a[1])
              .map(([how, n]) => (
                <li key={how} className="text-xs">
                  <div className="mb-1 flex justify-between">
                    <span className="text-mist">{HOW[how] ?? how}</span>
                    <span className="font-mono text-fog">
                      {num(n)} · {pct(n / edgeTotal)}
                    </span>
                  </div>
                  <Meter value={n / edgeTotal} barClassName="bg-gold/70" />
                </li>
              ))}
          </ul>
        </Tile>
        <Tile title="Languages">
          <ul className="space-y-2.5">
            {Object.entries(r.langs)
              .sort((a, b) => b[1] - a[1])
              .map(([lang, n]) => (
                <li key={lang} className="text-xs">
                  <div className="mb-1 flex justify-between">
                    <span className="text-mist">{lang}</span>
                    <span className="font-mono text-fog">{num(n)} files</span>
                  </div>
                  <Meter value={n / langTotal} barClassName="bg-mist/60" />
                </li>
              ))}
          </ul>
        </Tile>
        <Tile title="Where resolution is weakest" action={<span className="text-[11px] text-fog">unresolved call sites</span>} bodyClassName="p-2">
          {r.unresolved_top.length ? (
            <ul className="space-y-0.5">
              {r.unresolved_top.slice(0, 10).map(([f, n]) => (
                <li key={f} className="flex items-center gap-2 px-2 py-0.5 text-xs">
                  <FileLink repo={repo} path={f} className="min-w-0 truncate" />
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-fog">{n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-2 text-sm text-muted-foreground">Every call site resolved.</p>
          )}
          <p className="mt-2 px-2 text-[11px] text-fog">
            {r.external_sites != null
              ? "Calls whose target could be repo code but was not found. Calls provably into libraries, builtins and literals are excluded."
              : "Mostly calls into libraries and builtins, which are outside the repo by design. Re-index to separate them."}
          </p>
        </Tile>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Tile title={`Import cycles · ${d.cycle_count}`} bodyClassName="p-2">
          {d.cycles.length ? (
            <ul className="space-y-2">
              {d.cycles.slice(0, 10).map((c, i) => (
                <li key={i} className="flex flex-wrap items-center gap-1.5 px-2 text-xs">
                  {(c.example.length ? c.example : c.files).map((f, j) => (
                    <span key={j} className="flex items-center gap-1.5">
                      {j > 0 && <ArrowRight className="size-3 text-fog" />}
                      <FileLink repo={repo} path={f} />
                    </span>
                  ))}
                  {c.size > 2 && <span className="text-muted-foreground">· {num(c.size)} files in the cycle</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-2 text-sm text-muted-foreground">No import cycles.</p>
          )}
        </Tile>
        <Tile title={`Probably dead · ${d.dead_code.length}`} bodyClassName="max-h-80 overflow-y-auto p-2">
          {d.dead_code.length ? (
            <ul className="space-y-0.5">
              {d.dead_code.map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs" title={s.reason}>
                  <SymLink repo={repo} id={s.id} name={s.qname} className="min-w-0 truncate text-[12.5px]" />
                  <span className="hidden truncate font-mono text-[10.5px] text-fog sm:inline">{s.file}</span>
                  <span className={cn("ml-auto shrink-0 rounded px-1.5 text-[10px]", s.category === "private" ? "bg-white/5 text-fog" : "bg-ov-missed/10 text-ov-missed")}>
                    {s.category}
                  </span>
                  <span className="w-10 shrink-0 text-right font-mono text-[10.5px] text-fog">{s.loc}L</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-2 text-sm text-muted-foreground">Nothing unreferenced.</p>
          )}
          <p className="mt-2 flex items-start gap-1.5 px-2 text-[11px] text-fog">
            <AlertTriangle className="mt-px size-3.5 shrink-0" /> Static analysis: code reached by reflection, string dispatch or external callers looks dead here.
          </p>
        </Tile>
      </div>
    </Page>
  );
}
