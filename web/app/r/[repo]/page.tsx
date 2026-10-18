"use client";

/**
 * Overview: what the graph knows about one repository.
 *
 * Six figures first, because they say how far to trust everything below —
 * resolution most of all, which is why it alone carries a bar. Then the ways
 * into the graph, then its shape (subsystems, the file map), then what is
 * load-bearing, churning, unresolved, cyclic or unreferenced. Every number on
 * the page is read from `/overview` or `/graph`; nothing here is a sample.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Chip, Cols, Empty, ErrorNote, Figure, Head, Measuring, Meter, Mono, Page, Sheet, Stack, no2 } from "@/components/gt";
import { GraphCanvas, type GEdge, type GNode } from "@/components/graph-canvas";
import { AlertTriangle, ArrowRight, Network, Refresh, Zap } from "@/components/icons";
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
const SERIES = ["bg-mark", "bg-info", "bg-pass", "bg-warn", "bg-hot", "bg-ink-dim"];

/** The file map draws at most this many files; past it the layout stops being readable. */
const MAP_CAP = 150;

function Subsystems({ repo, d }: { repo: string; d: Overview }) {
  const [sel, setSel] = useState<number | null>(null);
  const { nodes, edges } = useMemo(() => {
    const linked = new Set(d.links.flatMap((l) => [l.src, l.dst]));
    const biggest = Math.max(1, ...d.subsystems.map((x) => x.size));
    const ns: GNode[] = d.subsystems
      .filter((s) => linked.has(s.id))
      .map((s) => ({ id: String(s.id), label: s.name, sub: `${s.size} files`, group: s.name, value: s.size / biggest }));
    const es: GEdge[] = d.links.map((l) => ({ src: String(l.src), dst: String(l.dst), weight: Math.log2(1 + l.weight), label: String(l.weight) }));
    return { nodes: ns, edges: es };
  }, [d]);
  const max = Math.max(1, ...d.subsystems.map((s) => s.size));
  const chosen = d.subsystems.find((s) => s.id === sel);

  return (
    <Sheet no="03 · Shape" title={`Subsystems · ${d.subsystems.length}`} note="Label propagation over the import graph. Pick one to see its files." tone="library">
      <Cols kind="main-aside">
        {nodes.length > 1 ? (
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            height={400}
            selected={sel !== null ? String(sel) : undefined}
            onSelect={(id) => setSel(Number(id))}
            hud={`${nodes.length} linked subsystems`}
          />
        ) : (
          <div className="grid h-[400px] place-items-center border border-dashed border-line-loud text-[13px] text-ink-dim">
            No links between subsystems to draw.
          </div>
        )}
        <div className="min-w-0">
          {chosen ? (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="size-2.5 shrink-0" style={{ background: tint(chosen.name) }} aria-hidden />
                <Mono className="truncate text-[13px] text-mark">{chosen.name}</Mono>
                <span className="shrink-0 text-[11.5px] text-ink-dim">
                  {chosen.size} files{chosen.size > chosen.files.length ? `, first ${chosen.files.length} shown` : ""}
                </span>
                <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setSel(null)}>
                  All
                </Button>
              </div>
              <ul className="gt-scroll max-h-[350px] space-y-0.5 overflow-y-auto text-[12px]">
                {chosen.files.map((f) => (
                  <li key={f} className="truncate px-1 py-0.5">
                    <FileLink repo={repo} path={f} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ul className="gt-scroll max-h-[400px] overflow-y-auto pr-1">
              {d.subsystems.map((s, i) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setSel(s.id)} className="gt-row w-full grid-cols-[24px_minmax(0,1fr)_auto] text-left" data-hover-mark>
                    <span className="gt-row__no">{no2(i + 1)}</span>
                    <span className="min-w-0">
                      <span className="gt-row__name block truncate font-mono text-[12.5px]" data-hover-mark>
                        {s.name}
                      </span>
                      <span className="mt-1.5 block h-[2px] bg-line">
                        <span className="block h-full" style={{ width: `${(s.size / max) * 100}%`, background: tint(s.name, 0.7) }} />
                      </span>
                    </span>
                    <Mono className="text-[11px] text-ink-dim">{s.size}</Mono>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Cols>
    </Sheet>
  );
}

/**
 * Files and their imports, fetched only when asked for: `/graph` is the
 * heaviest read on the page and most visits never need it.
 */
function FileMap({ repo }: { repo: string }) {
  const router = useRouter();
  const load = useAction(api.graph);
  const g = load.data;
  const { nodes, edges } = useMemo(() => {
    if (!g) return { nodes: [] as GNode[], edges: [] as GEdge[] };
    // Keep the most connected files: they are the ones a map is for.
    const degree = new Map<string, number>();
    for (const e of g.edges) {
      degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
      degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
    }
    const kept = [...g.nodes].sort((a, b) => (degree.get(b.path) ?? 0) - (degree.get(a.path) ?? 0)).slice(0, MAP_CAP);
    const ids = new Set(kept.map((n) => n.path));
    const ns: GNode[] = kept.map((n) => ({
      id: n.path,
      label: n.path.slice(n.path.lastIndexOf("/") + 1),
      sub: `${n.lang} · ${num(n.loc)} loc · ${num(n.symbols)} sym`,
      tone: n.error ? "bg-fail" : n.is_test ? "bg-ink-faint" : SERIES[(n.community ?? 0) % SERIES.length],
      group: n.community !== undefined ? String(n.community) : undefined,
      badge: n.is_test ? "test" : undefined,
    }));
    const es: GEdge[] = g.edges.filter((e) => ids.has(e.src) && ids.has(e.dst)).map((e) => ({ src: e.src, dst: e.dst }));
    return { nodes: ns, edges: es };
  }, [g]);

  return (
    <Sheet
      no="04 · Map"
      title="File map"
      note="Files as cards, imports as edges, coloured by subsystem. Tests are grey, files that failed to parse are red. Click a file to explore it."
      tone="library"
      action={
        <Button variant="outline" size="sm" onClick={() => load.run(repo)} disabled={load.loading}>
          <Network className="size-4" aria-hidden /> {load.loading ? "Loading…" : g ? "Reload map" : "Load map"}
        </Button>
      }
    >
      {load.error ? (
        <ErrorNote error={load.error} onRetry={() => load.run(repo)} />
      ) : load.loading && !g ? (
        <Measuring label="Reading the import graph" />
      ) : !g ? (
        <p className="text-[13px] text-ink-dim">Not loaded. The map reads up to 600 files and draws the {MAP_CAP} most connected.</p>
      ) : nodes.length === 0 ? (
        <Empty title="No files in the graph" />
      ) : (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          height={560}
          onSelect={(id) => router.push(repoHref(repo, `/explore?file=${encodeURIComponent(id)}`))}
          hud={`${num(nodes.length)} of ${num(g.nodes.length)} files · ${num(edges.length)} imports`}
        />
      )}
    </Sheet>
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
        {q.error.status === 404 ? (
          <Empty title={`No repository named “${repo}”`} action={<Link href="/" className="text-mark underline-offset-2 hover:underline">Home</Link>}>
            Index it from the home page.
          </Empty>
        ) : (
          <ErrorNote error={q.error} onRetry={q.reload} />
        )}
      </Page>
    );
  if (!d)
    return (
      <Page>
        <Measuring label="Reading the graph" />
      </Page>
    );

  const r = d.repo;
  const edgeTotal = Object.values(r.edge_mix).reduce((a, b) => a + b, 0) || 1;
  const langs = Object.entries(r.langs).sort((a, b) => b[1] - a[1]);
  const langTotal = langs.reduce((a, [, n]) => a + n, 0) || 1;

  return (
    <Page>
      <Head
        no="01 · Overview"
        title={<span className="font-mono">{r.name}</span>}
        lead={
          <Mono className="text-[12px]">
            {r.commit ? r.commit.slice(0, 12) : "no commit"} · indexed {relTime(r.indexed_at)}
            {r.history_commits ? ` · ${r.history_commits} commits of history` : ""}
            {r.url ? ` · ${r.url}` : ""}
          </Mono>
        }
      >
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
            <Refresh className="size-4" aria-hidden /> Re-index
          </Button>
        )}
      </Head>

      <Stack>
        {reindex.error && <ErrorNote error={reindex.error} />}
        {job !== null && state && <JobProgress repo={repo} job={state} />}

        {/* The six numbers that describe the index. Resolution carries its own
            bar because it is the one figure that says how much to trust the rest. */}
        <Sheet no="01 · Index" tone="capture">
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-6">
            <Figure label="Files" value={num(d.counts.files)} />
            <Figure label="Symbols" value={num(d.counts.symbols)} />
            <Figure label="Call edges" value={num(d.counts.calls)} />
            <Figure label="Import edges" value={num(d.counts.imports)} />
            <Figure
              label="Call sites resolved"
              value={pct(r.resolution_rate)}
              tone="text-mark"
              hint={
                <>
                  <Meter value={r.resolution_rate} className="mb-1.5" label="Call sites resolved" />
                  {r.repo_resolution_rate != null
                    ? `${pct(r.repo_resolution_rate)} excl. ${num(r.external_sites ?? 0)} library calls`
                    : `${num(r.resolved_sites)} of ${num(r.call_sites)}`}
                </>
              }
            />
            <Figure label="Import cycles" value={num(d.cycle_count)} tone={d.cycle_count ? "text-warn" : undefined} hint={d.cycle_count ? "worth untangling" : "none"} />
          </div>
        </Sheet>

        <Sheet no="02 · Instruments" title="Ask the graph" note="Every answer carries its evidence: the hops, how each edge resolved, and what the query cost." tone="commission" flush>
          <ul className="grid border-t border-line sm:grid-cols-2 lg:grid-cols-3">
            {QUICK.map((x, i) => (
              <li key={x.href} className="border-b border-line sm:odd:border-r lg:border-r lg:[&:nth-child(3n)]:border-r-0">
                <Link href={repoHref(repo, x.href)} className="group flex h-full gap-3 px-[clamp(14px,2vw,24px)] py-4 hover:bg-accent">
                  <span className="gt-row__no pt-1 font-mono text-[10.5px] text-ink-faint">{no2(i + 1)}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-[14px] text-ink group-hover:text-mark">
                      <x.Icon className="size-4 shrink-0 text-ink-dim group-hover:text-mark" aria-hidden />
                      {x.label}
                    </span>
                    <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-dim">{x.blurb}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Sheet>

        <Subsystems repo={repo} d={d} />

        <FileMap repo={repo} />

        <Cols kind="halves">
          <Sheet no="05 · Centrality" title="Load-bearing symbols" note="PageRank over calls" flush>
            <ul>
              {d.central.slice(0, 12).map((s, i) => (
                <li key={s.id} className="gt-row grid-cols-[24px_minmax(0,1fr)_auto_auto] items-center px-[clamp(14px,2vw,24px)]" data-hit>
                  <span className="gt-row__no">{no2(i + 1)}</span>
                  <span className="min-w-0">
                    <SymLink repo={repo} id={s.id} name={s.qname} className="block truncate text-[13px]" />
                    <span className="hidden truncate font-mono text-[10.5px] text-ink-faint sm:block">{s.file}</span>
                  </span>
                  <Mono className="text-[11px] text-ink-dim" title="callers (fan-in)">
                    {s.fan_in}↙
                  </Mono>
                  <Link
                    href={repoHref(repo, `/impact?t=${encodeURIComponent(s.id)}&change=signature`)}
                    className="p-0.5 text-ink-faint hover:text-mark"
                    aria-label={`Impact of a signature change to ${symName(s.qname)}`}
                  >
                    <Zap className="size-3.5" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </Sheet>
          <Sheet no="06 · Churn" title="Hotspots" note="churn × complexity" flush>
            <div className="gt-scroll overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="gt-label text-left">
                  <tr className="border-b border-line">
                    <th className="px-[clamp(14px,2vw,24px)] py-2 font-normal">File</th>
                    <th className="w-px px-2 py-2 text-right font-normal whitespace-nowrap">Churn</th>
                    <th className="w-px px-2 py-2 text-right font-normal whitespace-nowrap">Commits</th>
                    <th className="w-px px-2 py-2 text-right font-normal whitespace-nowrap">Complexity</th>
                    <th className="w-px px-[clamp(14px,2vw,24px)] py-2 text-right font-normal whitespace-nowrap">Fan-in</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {d.hotspots.slice(0, 12).map((h) => (
                    <tr key={h.path} className="border-b border-line last:border-0 hover:bg-accent">
                      <td className="w-full max-w-0 truncate px-[clamp(14px,2vw,24px)] py-2">
                        <FileLink repo={repo} path={h.path} />
                      </td>
                      <td className="px-2 py-2 text-right text-ink">{num(h.churn)}</td>
                      <td className="px-2 py-2 text-right text-ink-dim">{num(h.commits)}</td>
                      <td className="px-2 py-2 text-right text-ink-dim">{num(h.complexity)}</td>
                      <td className="px-[clamp(14px,2vw,24px)] py-2 text-right text-ink-dim">{num(h.fan_in)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Sheet>
        </Cols>

        <Cols kind="thirds">
          <Sheet no="07 · Resolution" title="How call edges were resolved" tone="fragment">
            <ul className="space-y-3">
              {Object.entries(r.edge_mix)
                .sort((a, b) => b[1] - a[1])
                .map(([how, n]) => (
                  <li key={how} className="text-[12px]">
                    <div className="mb-1.5 flex justify-between gap-2">
                      <span className="truncate text-ink">{HOW[how] ?? how}</span>
                      <Mono className="shrink-0 text-ink-dim">
                        {num(n)} · {pct(n / edgeTotal)}
                      </Mono>
                    </div>
                    <Meter value={n / edgeTotal} label={`${HOW[how] ?? how}: ${pct(n / edgeTotal)}`} />
                  </li>
                ))}
            </ul>
          </Sheet>
          <Sheet no="08 · Languages" title="Languages" tone="fragment">
            <div className="mb-4 flex h-[6px] w-full gap-px overflow-hidden" role="img" aria-label={langs.map(([l, n]) => `${l}: ${n} files`).join(", ")}>
              {langs.map(([lang, n], i) => (
                <span key={lang} className={SERIES[i % SERIES.length]} style={{ width: `${(n / langTotal) * 100}%` }} title={`${lang}: ${n} files`} />
              ))}
            </div>
            <ul className="space-y-2">
              {langs.map(([lang, n], i) => (
                <li key={lang} className="flex items-center gap-2 text-[12px]">
                  <span className={cn("size-2 shrink-0", SERIES[i % SERIES.length])} aria-hidden />
                  <span className="truncate text-ink">{lang}</span>
                  <Mono className="ml-auto shrink-0 text-ink-dim">
                    {num(n)} · {pct(n / langTotal)}
                  </Mono>
                </li>
              ))}
            </ul>
          </Sheet>
          <Sheet no="09 · Gaps" title="Where resolution is weakest" note="unresolved call sites" tone="fragment">
            {r.unresolved_top.length ? (
              <ul className="space-y-1">
                {r.unresolved_top.slice(0, 10).map(([f, n]) => (
                  <li key={f} className="flex items-center gap-2 text-[12px]">
                    <FileLink repo={repo} path={f} className="min-w-0 truncate" />
                    <Mono className="ml-auto shrink-0 text-[11px] text-ink-dim">{n}</Mono>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-dim">Every call site resolved.</p>
            )}
            <p className="gt-note mt-3 text-[11.5px] text-ink-faint">
              {r.external_sites != null
                ? "Calls whose target could be repo code but was not found. Calls provably into libraries, builtins and literals are excluded."
                : "Mostly calls into libraries and builtins, which are outside the repo by design. Re-index to separate them."}
            </p>
          </Sheet>
        </Cols>

        <Cols kind="halves">
          <Sheet no="10 · Cycles" title={`Import cycles · ${d.cycle_count}`} tone={d.cycle_count ? "fail" : "capture"}>
            {d.cycles.length ? (
              <ul className="space-y-2.5">
                {d.cycles.slice(0, 10).map((c, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-1.5 text-[12px]">
                    {(c.example.length ? c.example : c.files).map((f, j) => (
                      <span key={j} className="flex items-center gap-1.5">
                        {j > 0 && <ArrowRight className="size-3 text-ink-faint" aria-hidden />}
                        <FileLink repo={repo} path={f} />
                      </span>
                    ))}
                    {c.size > 2 && <span className="text-ink-dim">· {num(c.size)} files in the cycle</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-dim">No import cycles.</p>
            )}
          </Sheet>
          <Sheet no="11 · Dead code" title={`Probably dead · ${d.dead_code.length}`} flush>
            {d.dead_code.length ? (
              <ul className="gt-scroll max-h-80 overflow-y-auto">
                {d.dead_code.map((s) => (
                  <li key={s.id} className="gt-row grid-cols-[minmax(0,1fr)_auto_40px] items-center px-[clamp(14px,2vw,24px)] py-2" title={s.reason}>
                    <span className="min-w-0">
                      <SymLink repo={repo} id={s.id} name={s.qname} className="block truncate text-[13px]" />
                      <span className="hidden truncate font-mono text-[10.5px] text-ink-faint sm:block">{s.file}</span>
                    </span>
                    <Chip tone={s.category === "private" ? "neutral" : "warn"}>{s.category}</Chip>
                    <Mono className="text-right text-[10.5px] text-ink-faint">{s.loc}L</Mono>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-[clamp(14px,2vw,24px)] text-[13px] text-ink-dim">Nothing unreferenced.</p>
            )}
            <p className="flex items-start gap-1.5 px-[clamp(14px,2vw,24px)] py-3 text-[11.5px] text-ink-faint">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> Static analysis: code reached by reflection, string dispatch or external callers looks dead
              here.
            </p>
          </Sheet>
        </Cols>
      </Stack>
    </Page>
  );
}
