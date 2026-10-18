"use client";

import { useMemo, useState } from "react";

import { AlertTriangle, ChevronDown, ChevronRight, GitDiff, TestTube, Users } from "@/components/icons";
import { GraphCanvas, type GEdge, type GNode } from "@/components/graph-canvas";
import { CopyButton, Empty, FileLink, Meter, Receipts, Stat, SymLink, Tile } from "@/components/kit";
import { Button } from "@/components/ui/button";
import type { Impact, Impacted, Problem, Tier } from "@/lib/api";
import { HOW, LEVEL_BG, LEVEL_TEXT, num, pct, relTime, splitId, symName, TIER_BG, TIER_TEXT } from "@/lib/format";
import { cn } from "@/lib/utils";

const GRAPH_CAP = 60;
const TIERS: Tier[] = ["definite", "likely", "possible"];
const VERB: Record<string, string> = { CALLS: "calls", INHERITS: "inherits", IMPLEMENTS: "implements", OVERRIDES: "overrides", COCHANGE: "co-changes with" };

/** Why a symbol is impacted: the chain from the changed symbol, one resolved edge per step. */
export function WhyChain({ repo, item }: { repo: string; item: Impacted }) {
  return (
    <ol className="space-y-1.5 border-l border-graphite pl-3">
      {item.path.map((s, i) => (
        <li key={i} className="text-xs">
          <SymLink repo={repo} id={s.to} className="text-[12px]" />{" "}
          {s.type === "DISPATCH" && s.via ? (
            <>
              <span className="text-fog">calls </span>
              <SymLink repo={repo} id={s.via} name={splitId(s.via)[1] || s.via} className="text-[12px] text-mist" />
              <span className="text-fog">, which can dispatch to </span>
            </>
          ) : (
            <span className="text-fog">{VERB[s.type] ?? s.type.toLowerCase()} </span>
          )}
          <SymLink repo={repo} id={s.from} name={splitId(s.from)[1] || s.from} className="text-[12px] text-mist" />
          <span className="ml-2 font-mono text-[10.5px] text-fog">
            {s.how ? (HOW[s.how] ?? s.how) : ""}
            {s.confidence !== undefined ? ` · ${pct(s.confidence)}` : ""}
            {s.file && s.lines?.length ? ` · ${s.file}:${s.lines[0]}` : ""}
          </span>
          {s.verdict && <span className="ml-2 rounded bg-ov-missed/10 px-1 text-[10.5px] text-ov-missed">{s.verdict}</span>}
        </li>
      ))}
    </ol>
  );
}

export function ProblemList({ repo, problems, onPick }: { repo: string; problems?: Problem[]; onPick?: (ref: string, id: string) => void }) {
  if (!problems?.length) return null;
  return (
    <div className="space-y-2">
      {problems.map((p) => (
        <div key={p.ref} className="rounded-lg border border-ov-missed/30 bg-ov-missed/5 px-3 py-2.5 text-sm">
          <div className="flex items-start gap-2 text-mist">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ov-missed" aria-hidden />
            <span>
              <code className="font-mono text-paper">{p.ref}</code>: {p.error}
            </span>
          </div>
          {p.candidates?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
              {p.candidates.slice(0, 10).map((c) =>
                onPick ? (
                  <Button key={c.id} variant="outline" size="sm" className="h-7 font-mono text-xs" onClick={() => onPick(p.ref, c.id)} title={c.id}>
                    {symName(c.qname)} <span className="text-fog">{c.file}</span>
                  </Button>
                ) : (
                  <SymLink key={c.id} repo={repo} id={c.id} className="text-xs" />
                ),
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ImpactGraph({ data, onSelect, selected }: { data: Impact; onSelect: (id: string) => void; selected?: string }) {
  const { nodes, edges, hidden } = useMemo(() => {
    const top = [...data.impacted].sort((a, b) => b.p - a.p).slice(0, GRAPH_CAP);
    const keep = new Set<string>(data.seeds.filter((s) => s.found).map((s) => s.id));
    // include every node on each kept item's chain, so no edge dangles
    for (const it of top) for (const st of it.path) keep.add(st.from).add(st.to);
    const byId = new Map(data.impacted.map((x) => [x.id, x]));
    const ns: GNode[] = [...keep].map((id) => {
      const it = byId.get(id);
      const seed = data.seeds.find((s) => s.id === id);
      const [file, qn] = splitId(id);
      return {
        id,
        label: qn || file,
        sub: `${file}${it ? ` · hop ${it.hop}` : ""}`,
        tone: seed ? "bg-gold" : it ? TIER_BG[it.tier] : "bg-smoke",
        value: it?.p,
        badge: seed ? seed.change : it ? pct(it.p) : undefined,
        group: seed ? "0" : String(it?.hop ?? 9),
        emphasis: !!seed,
      };
    });
    const es = new Map<string, GEdge>();
    for (const it of top)
      for (const st of it.path) {
        const k = `${st.from}>${st.to}`;
        if (!es.has(k)) es.set(k, { src: st.from, dst: st.to, dashed: st.type !== "CALLS", label: st.type === "CALLS" ? undefined : st.type.toLowerCase() });
      }
    return { nodes: ns, edges: [...es.values()], hidden: Math.max(0, data.impacted.length - top.length) };
  }, [data]);
  return (
    <div>
      <GraphCanvas nodes={nodes} edges={edges} onSelect={onSelect} selected={selected} height={460} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fog">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-gold" /> changed
        </span>
        {TIERS.map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-sm", TIER_BG[t])} /> {t}
          </span>
        ))}
        <span>arrows run from the change to what depends on it · dashed (labelled) = inheritance, override, dispatch or co-change</span>
        {hidden > 0 && <span className="ml-auto">showing the {GRAPH_CAP} most likely of {data.impacted.length}</span>}
      </div>
    </div>
  );
}

function ImpactRow({ repo, it, open, onToggle }: { repo: string; it: Impacted; open: boolean; onToggle: () => void }) {
  return (
    <li className={cn("rounded-lg border border-transparent", open && "border-graphite bg-white/[0.02]")}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.03]" aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5 shrink-0 text-fog" /> : <ChevronRight className="size-3.5 shrink-0 text-fog" />}
        <span className={cn("w-16 shrink-0 font-mono text-[11px]", TIER_TEXT[it.tier])}>{it.tier}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-paper">
          {it.name}
          {it.is_test && <TestTube className="ml-1.5 inline size-3.5 text-signal-teal" aria-label="test" />}
        </span>
        <span className="hidden truncate font-mono text-[11px] text-fog md:block md:max-w-[38%]">
          {it.file}:{it.line}
        </span>
        <span className="w-10 shrink-0 text-right font-mono text-[11px] text-fog">h{it.hop}</span>
        <span className="w-20 shrink-0">
          <span className="block text-right font-mono text-[11px] text-mist">{pct(it.p)}</span>
          <Meter value={it.p} barClassName={TIER_BG[it.tier]} />
        </span>
      </button>
      {open && (
        <div className="px-8 pt-1 pb-3">
          <WhyChain repo={repo} item={it} />
          {(it.via ?? 1) > 1 && <p className="mt-2 text-[11px] text-fog">Reached by {it.via} independent paths; the most likely is shown.</p>}
        </div>
      )}
    </li>
  );
}

/** The full answer to "what breaks if I change this": risk, graph, ranked list with why-chains, tests, files, people. */
export function ImpactView({ repo, data, onPick }: { repo: string; data: Impact; onPick?: (ref: string, id: string) => void }) {
  const [tier, setTier] = useState<Tier | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(40);
  const list = data.impacted.filter((x) => !x.is_test && (tier === "all" || x.tier === tier));
  const level = data.risk.level;
  const c = data.risk.components;

  if (data.error) return <ProblemList repo={repo} problems={[{ ref: "", error: data.error }]} />;

  return (
    <div className="space-y-4">
      <ProblemList repo={repo} problems={data.problems} onPick={onPick} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <Tile title="Risk" action={<Receipts r={data.receipts} />}>
          <div className="flex items-end gap-3">
            <span className={cn("font-mono text-6xl leading-none tabular-nums", LEVEL_TEXT[level])}>{data.risk.score}</span>
            <span className={cn("mb-1 rounded-full px-2 py-0.5 text-xs font-medium text-void uppercase", LEVEL_BG[level])}>{level}</span>
          </div>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-graphite">
            <div className={cn("h-full rounded-full", LEVEL_BG[level])} style={{ width: `${data.risk.score}%` }} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            {(
              [
                ["Expected breakages", c.expected_breakages.toFixed(1)],
                ["Definite", num(c.definite)],
                ["Files touched", num(c.files)],
                ["Seed centrality", c.seed_centrality.toFixed(2)],
                ["Untested seeds", num(c.untested_seeds)],
                ["Depth reached", `${data.hops} / ${data.max_depth}`],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-fog">{k}</dt>
                <dd className="font-mono text-paper">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border/70 pt-4">
            {TIERS.map((t) => (
              <Stat key={t} label={t} value={num(data.counts[t])} tone={TIER_TEXT[t]} />
            ))}
          </div>
          {data.untested_seeds.length > 0 && (
            <p className="mt-4 rounded-md bg-ov-missed/10 px-2.5 py-2 text-xs text-ov-missed">
              No test reaches {data.untested_seeds.slice(0, 8).map((s) => s.name).join(", ")}
              {data.untested_seeds.length > 8 && ` and ${num(data.untested_seeds.length - 8)} more`}.
            </p>
          )}
          {data.markdown && (
            <div className="mt-4 flex gap-2">
              <CopyButton text={data.markdown} label="Copy as markdown" />
            </div>
          )}
        </Tile>
        <Tile title="Blast radius" bodyClassName="p-3">
          {data.impacted.length ? (
            <ImpactGraph data={data} onSelect={(id) => setOpen(id)} selected={open ?? undefined} />
          ) : (
            <Empty title="Nothing depends on this" icon={<GitDiff className="size-6" />}>
              No resolved caller, subclass or co-change partner was found within {data.max_depth} hops.
            </Empty>
          )}
        </Tile>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Tile
          title={`Impacted symbols · ${list.length}`}
          action={
            <div className="flex gap-1" role="group" aria-label="Filter by tier">
              {(["all", ...TIERS] as const).map((t) => (
                <Button key={t} size="sm" variant={tier === t ? "secondary" : "ghost"} className="h-6 px-2 text-[11px]" onClick={() => setTier(t)} aria-pressed={tier === t}>
                  {t}
                </Button>
              ))}
            </div>
          }
          bodyClassName="p-2"
        >
          {list.length ? (
            <ul className="space-y-0.5">
              {list.slice(0, limit).map((it) => (
                <ImpactRow key={it.id} repo={repo} it={it} open={open === it.id} onToggle={() => setOpen(open === it.id ? null : it.id)} />
              ))}
            </ul>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">Nothing in this tier.</p>
          )}
          {list.length > limit && (
            <Button variant="ghost" size="sm" className="mt-1 w-full text-xs" onClick={() => setLimit(limit + 60)}>
              Show more ({list.length - limit})
            </Button>
          )}
        </Tile>

        <div className="space-y-4">
          <Tile title={`Tests to run · ${data.tests.length}`} bodyClassName="p-2">
            {data.tests.length ? (
              <ul className="space-y-0.5">
                {data.tests.slice(0, 30).map((t) => (
                  <li key={t.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs">
                    <TestTube className="size-3.5 shrink-0 text-signal-teal" aria-hidden />
                    <SymLink repo={repo} id={t.id} name={t.name} className="min-w-0 truncate text-[12px]" />
                    <span className="ml-auto font-mono text-[11px] text-fog">{pct(t.p)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-sm text-muted-foreground">No test statically reaches this change.</p>
            )}
          </Tile>

          <Tile title="Hidden coupling" bodyClassName="p-2">
            {data.hidden_coupling.length ? (
              <ul className="space-y-1">
                {data.hidden_coupling.slice(0, 10).map((h) => (
                  <li key={h.path} className="rounded px-2 py-1 text-xs">
                    <div className="flex items-center gap-2">
                      <FileLink repo={repo} path={h.path} className="min-w-0 truncate text-[12px]" />
                      <span className="ml-auto font-mono text-[11px] text-ov-missed">{pct(h.strength)}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-fog">
                      changed together {h.count}× {h.via?.length ? `with ${h.via.join(", ")}` : ""}, no static edge
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-sm text-muted-foreground">No co-change partner without a static edge.</p>
            )}
          </Tile>

          <Tile title="Import-only dependents" bodyClassName="p-2">
            {data.import_only?.length ? (
              <ul className="space-y-1">
                {data.import_only.slice(0, 10).map((r) => (
                  <li key={`${r.file}->${r.imports}`} className="rounded px-2 py-1 text-xs">
                    <FileLink repo={repo} path={r.file} line={r.line ?? undefined} className="block min-w-0 truncate text-[12px]" />
                    <div className="mt-0.5 truncate text-[11px] text-fog" title={r.names?.join(", ")}>
                      imports {r.imports.split("/").pop()}
                      {r.names?.length ? ` (${r.names.slice(0, 3).join(", ")}${r.names.length > 3 ? ", …" : ""})` : ""}, no resolved call
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-sm text-muted-foreground">Every importer of the changed files is already above.</p>
            )}
          </Tile>

          <Tile title="Who to ask" bodyClassName="p-2">
            {data.owners.length ? (
              <ul className="space-y-1">
                {data.owners.slice(0, 6).map((o) => (
                  <li key={o.email} className="flex items-center gap-2 rounded px-2 py-1 text-xs">
                    <Users className="size-3.5 shrink-0 text-fog" aria-hidden />
                    <span className="truncate text-paper" title={o.email}>
                      {o.name}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-fog">
                      {num(o.commits)} commits{o.last ? ` · ${relTime(o.last)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-sm text-muted-foreground">No git history indexed.</p>
            )}
          </Tile>
        </div>
      </div>

      <Tile title={`Files · ${data.files.length}`} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-[11px] text-fog">
              <tr className="border-b border-border/70">
                <th className="px-4 py-2 font-normal">File</th>
                <th className="w-px whitespace-nowrap px-2 py-2 text-right font-normal">p</th>
                <th className="w-px whitespace-nowrap px-2 py-2 text-right font-normal">Symbols</th>
                <th className="w-px whitespace-nowrap px-2 py-2 text-right font-normal">Tests</th>
                <th className="w-px whitespace-nowrap px-4 py-2 text-right font-normal">Hop</th>
              </tr>
            </thead>
            <tbody>
              {data.files.slice(0, 50).map((f) => (
                <tr key={f.file} className="border-b border-border/40 last:border-0">
                  <td className="w-full max-w-0 truncate px-4 py-1.5">
                    <FileLink repo={repo} path={f.file} />
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-mist">{pct(f.p)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{f.symbols}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{f.tests}</td>
                  <td className="px-4 py-1.5 text-right font-mono">{f.min_hop}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Tile>

      {data.note && <p className="text-xs text-fog">{data.note}</p>}
    </div>
  );
}
