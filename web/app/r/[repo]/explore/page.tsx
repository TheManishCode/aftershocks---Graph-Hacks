"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Code, FileCode, Flow, Search, TestTube, Users, Zap } from "@/components/icons";
import { GraphCanvas, type GEdge, type GNode } from "@/components/graph-canvas";
import { Empty, ErrorNote, FileLink, Page, PageHeader, Receipts, Spinner, Stat, SymLink, Tile } from "@/components/kit";
import { repoHref } from "@/components/shell/nav";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { api, type FileDetail, type Neighbor, type SymbolBrief, type SymbolDetail } from "@/lib/api";
import { HOW, num, pct, relTime, splitId, symName } from "@/lib/format";
import { useQuery, useRepo } from "@/lib/hooks";

function NeighborList({ repo, items, empty }: { repo: string; items: Neighbor[]; empty: string }) {
  if (!items.length) return <p className="p-2 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-0.5">
      {items.map((n) => (
        <li key={`${n.id}:${n.type}`} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-white/[0.03]">
          <SymLink repo={repo} id={n.id} name={n.name} className="min-w-0 truncate text-[12.5px]" />
          {n.type !== "CALLS" && <span className="rounded bg-white/5 px-1 text-[10px] text-fog">{n.type.toLowerCase()}</span>}
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-fog">
            {n.how ? (HOW[n.how] ?? n.how) : ""}
            {n.confidence !== undefined ? ` · ${pct(n.confidence)}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SymbolView({ repo, d }: { repo: string; d: SymbolDetail }) {
  const s = d.symbol;
  const router = useRouter();
  const { nodes, edges } = useMemo(() => {
    const ns = new Map<string, GNode>();
    const add = (id: string, label: string, file: string, tone: string, group: string) =>
      ns.has(id) || ns.set(id, { id, label, sub: file, tone, group, emphasis: id === s.id });
    add(s.id, s.qname, `${s.file}:${s.line}`, "bg-gold", "1");
    d.callers.slice(0, 24).forEach((c) => add(c.id, c.name, `${c.file}:${c.line}`, "bg-signal-teal", "0"));
    d.callees.slice(0, 24).forEach((c) => add(c.id, c.name, `${c.file}:${c.line}`, "bg-smoke", "2"));
    const es: GEdge[] = [
      ...d.callers.slice(0, 24).map((c) => ({ src: c.id, dst: s.id, dashed: c.type !== "CALLS" })),
      ...d.callees.slice(0, 24).map((c) => ({ src: s.id, dst: c.id, dashed: c.type !== "CALLS" })),
    ];
    return { nodes: [...ns.values()], edges: es };
  }, [d, s]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-2xl text-paper">{symName(s.qname)}</h2>
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-fog">{s.kind}</span>
        {s.is_test && <TestTube className="size-4 text-signal-teal" aria-label="test" />}
        <FileLink repo={repo} path={s.file} line={s.line} className="text-xs" />
        <div className="ml-auto flex gap-2">
          <Button asChild variant="outline" size="sm" className="h-7 text-xs">
            <Link href={repoHref(repo, `/impact?t=${encodeURIComponent(s.id)}&change=signature`)}>
              <Zap className="size-3.5" /> Impact
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="h-7 text-xs">
            <Link href={repoHref(repo, `/path?from=${encodeURIComponent(s.id)}`)}>
              <Flow className="size-3.5" /> Path from here
            </Link>
          </Button>
        </div>
      </div>
      {s.signature && <pre className="overflow-x-auto rounded-lg border border-graphite bg-void px-4 py-3 font-mono text-[13px] text-mist">{s.signature}</pre>}
      {s.doc && <p className="max-w-3xl text-sm whitespace-pre-line text-muted-foreground">{s.doc}</p>}

      <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-card/50 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Callers" value={num(s.fan_in)} />
        <Stat label="Callees" value={num(s.fan_out)} />
        <Stat label="Lines" value={num(s.loc)} hint={`${s.line}–${s.end_line}`} />
        <Stat label="Complexity" value={num(s.complexity)} />
        <Stat label="PageRank" value={s.pagerank !== undefined ? (s.pagerank * 1000).toFixed(2) : "—"} hint="× 10⁻³" />
        <Stat label="Betweenness" value={num(s.betweenness)} />
      </div>
      {(s.bases?.length || s.decorators?.length) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {s.bases?.map((b) => (
            <span key={b} className="rounded border border-graphite px-2 py-0.5 font-mono text-fog">
              extends {b}
            </span>
          ))}
          {s.decorators?.map((b) => (
            <span key={b} className="rounded border border-graphite px-2 py-0.5 font-mono text-fog">
              @{b}
            </span>
          ))}
        </div>
      )}

      {nodes.length > 1 && (
        <Tile title="Neighbourhood" action={<span className="text-[11px] text-fog">callers left · callees right · click to walk</span>} bodyClassName="p-3">
          <GraphCanvas nodes={nodes} edges={edges} height={380} selected={s.id} onSelect={(id) => id !== s.id && router.push(repoHref(repo, `/explore?ref=${encodeURIComponent(id)}`))} />
        </Tile>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Tile title={`Callers · ${d.callers.length}`} bodyClassName="max-h-96 overflow-y-auto p-2">
          <NeighborList repo={repo} items={d.callers} empty="No resolved caller. It may be an entry point, called dynamically, or dead." />
        </Tile>
        <Tile title={`Callees · ${d.callees.length}`} bodyClassName="max-h-96 overflow-y-auto p-2">
          <NeighborList repo={repo} items={d.callees} empty="Calls nothing the resolver could bind inside this repo." />
        </Tile>
      </div>
    </div>
  );
}

function FileView({ repo, d }: { repo: string; d: FileDetail }) {
  const f = d.file;
  const syms = d.symbols.filter((s) => s.kind !== "module");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-2xl break-all text-paper">{f.path}</h2>
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-fog">{f.lang}</span>
        {f.is_test && <TestTube className="size-4 text-signal-teal" aria-label="test file" />}
        <Button asChild variant="outline" size="sm" className="ml-auto h-7 text-xs">
          <Link href={repoHref(repo, `/impact?t=${encodeURIComponent(f.path)}&change=body`)}>
            <Zap className="size-3.5" /> Impact of this file
          </Link>
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-card/50 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Lines" value={num(f.loc)} />
        <Stat label="Symbols" value={num(syms.length)} />
        <Stat label="Commits" value={num(f.commits)} />
        <Stat label="Churn" value={num(f.churn)} hint="lines added + deleted" />
        <Stat label="Authors" value={num(f.authors)} />
        <Stat label="Last change" value={relTime(f.last_change)} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Tile title={`Symbols · ${syms.length}`} bodyClassName="max-h-[520px] overflow-y-auto p-2">
          <ul className="space-y-0.5">
            {syms
              .sort((a, b) => a.line - b.line)
              .map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-white/[0.03]">
                  <span className="w-10 shrink-0 text-right font-mono text-[11px] text-fog">{s.line}</span>
                  <SymLink repo={repo} id={s.id} name={s.qname} className="min-w-0 truncate text-[12.5px]" />
                  <span className="ml-auto shrink-0 text-[10.5px] text-fog">{s.kind}</span>
                  {s.fan_in !== undefined && <span className="w-12 shrink-0 text-right font-mono text-[10.5px] text-fog">{s.fan_in}↙</span>}
                </li>
              ))}
          </ul>
        </Tile>
        <div className="space-y-4">
          <Tile title={`Imports · ${d.imports.length}`} bodyClassName="max-h-56 overflow-y-auto p-2">
            {d.imports.length ? (
              <ul className="space-y-0.5 text-xs">
                {d.imports.map((i) => (
                  <li key={i.path} className="truncate px-2 py-0.5">
                    <FileLink repo={repo} path={i.path} />
                    {i.names?.length ? <span className="ml-2 font-mono text-[10.5px] text-fog">{i.names.slice(0, 6).join(", ")}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-sm text-muted-foreground">No in-repo imports.</p>
            )}
            {d.externals.length > 0 && <p className="mt-2 px-2 font-mono text-[11px] text-fog">external: {d.externals.join(", ")}</p>}
          </Tile>
          <Tile title={`Imported by · ${d.importers.length}`} bodyClassName="max-h-56 overflow-y-auto p-2">
            {d.importers.length ? (
              <ul className="space-y-0.5 text-xs">
                {d.importers.map((i) => (
                  <li key={i.path} className="truncate px-2 py-0.5">
                    <FileLink repo={repo} path={i.path} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-sm text-muted-foreground">Nothing in the repo imports this file.</p>
            )}
          </Tile>
          <Tile title="Changes with" bodyClassName="p-2">
            {d.cochange.length ? (
              <ul className="space-y-0.5 text-xs">
                {d.cochange.slice(0, 8).map((c) => (
                  <li key={c.path} className="flex items-center gap-2 px-2 py-0.5">
                    <FileLink repo={repo} path={c.path} className="min-w-0 truncate" />
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-fog">
                      {c.count}× · {pct(c.strength)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-sm text-muted-foreground">No co-change partner in the mined history.</p>
            )}
          </Tile>
          <Tile title="Owners" bodyClassName="p-2">
            {d.owners.length ? (
              <ul className="space-y-0.5 text-xs">
                {d.owners.slice(0, 5).map((o) => (
                  <li key={o.email} className="flex items-center gap-2 px-2 py-0.5">
                    <Users className="size-3.5 text-fog" aria-hidden />
                    <span className="text-paper" title={o.email}>
                      {o.name}
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] text-fog">{num(o.commits)} commits</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-sm text-muted-foreground">No git history indexed.</p>
            )}
          </Tile>
        </div>
      </div>
    </div>
  );
}

function Candidates({ repo, items }: { repo: string; items: SymbolBrief[] }) {
  return (
    <Tile title={`${items.length} matches: pick one`} bodyClassName="p-2">
      <ul className="space-y-0.5">
        {items.map((c) => (
          <li key={c.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-white/[0.03]">
            <Code className="size-3.5 text-fog" />
            <SymLink repo={repo} id={c.id} name={c.qname} className="text-[12.5px]" />
            <span className="ml-auto font-mono text-[11px] text-fog">
              {c.kind} · {c.file}:{c.line}
            </span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

function Suggestions({ repo }: { repo: string }) {
  const q = useQuery(`overview:${repo}`, () => api.overview(repo));
  const central = q.data?.central.slice(0, 8) ?? [];
  const hot = q.data?.hotspots.slice(0, 6) ?? [];
  const chip = "inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-graphite px-3 py-1 font-mono text-xs text-mist transition-colors hover:border-smoke hover:text-paper";
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <Search className="mr-1.5 inline size-4 align-[-3px] text-fog" aria-hidden />
        Search above, or start from one of these. Press <kbd className="font-mono text-paper">⌘K</kbd> anywhere to jump.
      </p>
      {q.error ? null : !q.data ? (
        <Spinner label="Finding good starting points" />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Tile title="Load-bearing symbols" action={<span className="text-[11px] text-fog">most paths run through them</span>} bodyClassName="flex flex-wrap gap-2 p-3">
            {central.length ? central.map((c) => (
              <Link key={c.id} href={repoHref(repo, `/explore?ref=${encodeURIComponent(c.id)}`)} className={chip} title={`${c.file}:${c.line}`}>
                <Code className="size-3.5 shrink-0 text-gold" aria-hidden /> {symName(c.qname)}
              </Link>
            )) : <p className="text-sm text-muted-foreground">No call graph yet.</p>}
          </Tile>
          <Tile title="Hotspot files" action={<span className="text-[11px] text-fog">change often · complex</span>} bodyClassName="flex flex-wrap gap-2 p-3">
            {hot.length ? hot.map((h) => (
              <Link key={h.path} href={repoHref(repo, `/explore?file=${encodeURIComponent(h.path)}`)} className={chip}>
                <FileCode className="size-3.5 shrink-0 text-signal-teal" aria-hidden /> {h.path}
              </Link>
            )) : <p className="text-sm text-muted-foreground">No git history indexed.</p>}
          </Tile>
        </div>
      )}
    </div>
  );
}

export default function ExplorePage() {
  const repo = useRepo();
  const sp = useSearchParams();
  const router = useRouter();
  const ref = sp.get("ref") ?? "";
  const file = sp.get("file") ?? "";
  const [pick, setPick] = useState<string[]>([]);
  const q = useQuery(ref || file ? `explore:${repo}:${ref}:${file}` : null, () => (file ? api.file(repo, file) : api.symbol(repo, ref)));
  const d = q.data;

  const open = (v: string[]) => {
    setPick([]);
    const x = v[v.length - 1];
    if (!x) return;
    router.push(repoHref(repo, x.includes("::") || !x.includes("/") ? `/explore?ref=${encodeURIComponent(x)}` : `/explore?file=${encodeURIComponent(x)}`));
  };

  return (
    <Page>
      <PageHeader title="Explore" sub="Any symbol or file: its signature, who calls it, what it calls, what changes with it and who owns it.">
        {d && "receipts" in d && <Receipts r={(d as SymbolDetail).receipts} />}
      </PageHeader>
      <div className="mb-6 max-w-2xl">
        <SymbolPicker repo={repo} value={pick} onChange={open} multiple={false} placeholder="Jump to a symbol or file…" />
      </div>
      {!ref && !file ? (
        <Suggestions repo={repo} />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : !d ? (
        <Spinner />
      ) : "candidates" in d ? (
        d.candidates.length ? (
          <Candidates repo={repo} items={d.candidates} />
        ) : (
          <Empty title={`Nothing named “${splitId(ref)[1] || ref}”`} icon={<FileCode className="size-6" />} />
        )
      ) : "symbol" in d ? (
        <SymbolView repo={repo} d={d} />
      ) : (
        <FileView repo={repo} d={d} />
      )}
    </Page>
  );
}
