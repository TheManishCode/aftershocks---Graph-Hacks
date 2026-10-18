"use client";

/**
 * The full answer to "what breaks if I change this". Shared by Impact and Diff.
 *
 * 1. **Risk is a claim, so it is shown with its components.** The gauge is the
 *    headline; beside it, as a spec sheet, are the six numbers it is computed
 *    from. A score with no breakdown is a number to argue with, not evidence.
 * 2. **Colour means one thing.** The severity ramp carries likelihood — the risk
 *    level and the three tiers. Chartreuse is the instrument: the seeds you said
 *    you were changing, the selection, the figures it measured.
 * 3. **Nothing is truncated silently.** Every capped list says what it hides.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Callout, Chip, Cols, Empty, Figure, Meter, Mono, RiskGauge, SEV_BG, SEV_TEXT, Seg, Sheet, Spec, Stack, fromLevel, fromTier, no2 } from "@/components/gt";
import { GraphCanvas, type GEdge, type GNode } from "@/components/graph-canvas";
import { AlertTriangle, Play } from "@/components/icons";
import { CopyButton, FileLink, Receipts, SymLink } from "@/components/kit";
import { Button } from "@/components/ui/button";
import type { Impact, Impacted, Problem, Tier } from "@/lib/api";
import { HOW, num, pct, pytestNode, relTime, splitId, symName } from "@/lib/format";
import { cn } from "@/lib/utils";

const GRAPH_CAP = 60;
const TIERS: Tier[] = ["definite", "likely", "possible"];
const VERB: Record<string, string> = {
  CALLS: "calls",
  INHERITS: "inherits",
  IMPLEMENTS: "implements",
  OVERRIDES: "overrides",
  COCHANGE: "co-changes with",
  COVERS: "ran",
};

const tierText = (t: Tier) => SEV_TEXT[fromTier(t)];
const tierBg = (t: Tier) => SEV_BG[fromTier(t)];

/** Why a symbol is impacted: the chain from the changed symbol, one resolved edge per step. */
export function WhyChain({ repo, item }: { repo: string; item: Impacted }) {
  return (
    <ol className="space-y-1.5 border-l border-mark/50 pl-3">
      {item.path.map((s, i) => (
        <li key={`${s.from}->${s.to}:${i}`} className="text-[12.5px]">
          <SymLink repo={repo} id={s.to} className="text-[12.5px]" />{" "}
          {/* A dispatch edge is two facts — a call, then a possible target — and
              collapsing it to "calls" would overstate what the graph knows. */}
          {s.type === "DISPATCH" && s.via ? (
            <>
              <span className="text-ink-faint">calls </span>
              <SymLink repo={repo} id={s.via} name={splitId(s.via)[1] || s.via} className="text-[12.5px]" />
              <span className="text-ink-faint">, which can dispatch to </span>
            </>
          ) : (
            <span className="text-ink-faint">{VERB[s.type] ?? s.type.toLowerCase()} </span>
          )}
          <SymLink repo={repo} id={s.from} name={splitId(s.from)[1] || s.from} className="text-[12.5px]" />
          <Mono className="ml-2 text-[10.5px] text-ink-faint">
            {s.how ? (HOW[s.how] ?? s.how) : ""}
            {s.confidence !== undefined ? ` · ${pct(s.confidence)}` : ""}
            {s.file && s.lines?.length ? ` · ${s.file}:${s.lines[0]}` : ""}
          </Mono>
          {s.verdict && (
            <Chip tone="warn" className="ml-2">
              {s.verdict}
            </Chip>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Something the user named could not be resolved. A warning, not an error: the
 * rest of the analysis still ran, and the candidates fix the input in one click.
 */
export function ProblemList({ repo, problems, onPick }: { repo: string; problems?: Problem[]; onPick?: (ref: string, id: string) => void }) {
  if (!problems?.length) return null;
  return (
    <div className="space-y-2">
      {problems.map((p) => (
        <Callout key={p.ref} tone="warn" icon={<AlertTriangle aria-hidden />}>
          <span className="text-ink">
            {p.ref && <Mono className="text-ink">{p.ref}: </Mono>}
            {p.error}
          </span>
          {p.candidates?.length ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {p.candidates.slice(0, 10).map((c) =>
                onPick ? (
                  <Button key={c.id} variant="outline" size="sm" className="h-7 normal-case tracking-normal" onClick={() => onPick(p.ref, c.id)} aria-label={`Use ${c.qname} from ${c.file}`}>
                    <span className="text-ink">{symName(c.qname)}</span> <span className="text-ink-faint">{c.file}</span>
                  </Button>
                ) : (
                  <SymLink key={c.id} repo={repo} id={c.id} className="text-[12px]" />
                ),
              )}
            </div>
          ) : null}
        </Callout>
      ))}
    </div>
  );
}

function ImpactGraph({ repo, data, onSelect, selected }: { repo: string; data: Impact; onSelect: (id: string) => void; selected?: string }) {
  const { nodes, edges, hidden } = useMemo(() => {
    const top = [...data.impacted].sort((a, b) => b.p - a.p).slice(0, GRAPH_CAP);
    const keep = new Set<string>(data.seeds.filter((s) => s.found).map((s) => s.id));
    // Every node on a kept item's chain is kept too, so no edge dangles.
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
        tone: seed ? "bg-mark" : it ? tierBg(it.tier) : "bg-line-loud",
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
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        onSelect={onSelect}
        selected={selected}
        height={500}
        hud={
          <>
            <span>Blast radius</span>
            <span className="text-ink-dim">
              {nodes.length} nodes · {edges.length} edges
            </span>
          </>
        }
      />
      <Selection repo={repo} data={data} id={selected} />
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[10px] tracking-[.1em] text-ink-dim uppercase">
        <span className="flex items-center gap-1.5">
          <span className="size-2 bg-mark" aria-hidden /> changed
        </span>
        {TIERS.map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className={cn("size-2", tierBg(t))} aria-hidden /> {t}
          </span>
        ))}
        <span className="tracking-[.04em] normal-case">arrows run from the change to what depends on it · dashed = inheritance, override, dispatch or co-change</span>
        {hidden > 0 && (
          <span className="ml-auto text-mark">
            showing the {GRAPH_CAP} most likely of {num(data.impacted.length)}
          </span>
        )}
      </div>
    </div>
  );
}

function ImpactRow({ repo, it, i, open, onToggle }: { repo: string; it: Impacted; i: number; open: boolean; onToggle: () => void }) {
  return (
    <li data-row={it.id} className="scroll-mt-24 border-b border-line">
      <button
        type="button"
        onClick={onToggle}
        data-on={open ? "true" : undefined}
        className="gt-row w-full grid-cols-[28px_64px_minmax(0,1fr)_auto] border-b-0 text-left md:grid-cols-[28px_64px_minmax(0,1fr)_minmax(0,32%)_44px_84px]"
        aria-expanded={open}
      >
        <span className="gt-row__no">{no2(i + 1)}</span>
        <Mono className={cn("text-[10.5px] tracking-[.08em] uppercase", tierText(it.tier))}>{it.tier}</Mono>
        <span className="gt-row__name truncate font-mono text-[13px]" data-hover-mark>
          {it.name}
        </span>
        <Mono className="hidden truncate text-[11px] text-ink-faint md:block">
          {it.file}:{it.line}
        </Mono>
        <span className="gt-f hidden md:block">h{it.hop}</span>
        <span className="block min-w-[64px]">
          <Mono className="mb-1 block text-right text-[11px] text-ink">{pct(it.p)}</Mono>
          <Meter value={it.p} barClassName={tierBg(it.tier)} />
        </span>
      </button>
      {open && (
        <div className="pt-1 pr-2 pb-4 pl-[calc(28px+clamp(8px,1.6vw,20px)+4px)]">
          <WhyChain repo={repo} item={it} />
          {(it.via ?? 1) > 1 && <p className="mt-2 font-mono text-[10.5px] text-ink-faint">Reached by {it.via} independent paths; the most likely is shown.</p>}
        </div>
      )}
    </li>
  );
}

/**
 * What the clicked node is, directly under the graph. The matching row below is
 * often off screen, so this answers in place — and aloud, via aria-live.
 */
function Selection({ repo, data, id }: { repo: string; data: Impact; id?: string }) {
  if (!id) return <p className="mt-3 font-mono text-[10.5px] tracking-[.1em] text-ink-faint uppercase">Click a node to see why it is impacted</p>;
  const it = data.impacted.find((x) => x.id === id);
  const seed = data.seeds.find((s) => s.id === id);
  const step = it?.path[0]; // paths run from the impacted symbol toward the change
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-l-2 border-mark bg-mark/[0.06] px-3 py-2 text-[12.5px]" aria-live="polite">
      <SymLink repo={repo} id={id} name={symName(splitId(id)[1] || id)} className="text-[13px] text-mark" />
      {seed ? (
        <span className="font-mono text-[11px] tracking-[.08em] text-mark uppercase">changed · {seed.change}</span>
      ) : it ? (
        <>
          <span className={cn("font-mono text-[11px] tracking-[.08em] uppercase", tierText(it.tier))}>
            {it.tier} · {pct(it.p)}
          </span>
          <span className="text-ink-dim">
            hop {it.hop}
            {step && ` · ${VERB[step.type] ?? step.type.toLowerCase()} ${symName(splitId(step.to)[1] || step.to)}`}
          </span>
          {it.verdict && <span className="text-ink">{it.verdict}</span>}
        </>
      ) : (
        <span className="text-ink-dim">on the path between the change and an impacted symbol</span>
      )}
    </div>
  );
}

/** `runHref`: the Tests page link that runs exactly this selection. */
export function ImpactView({ repo, data, onPick, runHref }: { repo: string; data: Impact; onPick?: (ref: string, id: string) => void; runHref?: string }) {
  const [tier, setTier] = useState<Tier | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(40);
  const [jump, setJump] = useState<string | null>(null);
  const list = data.impacted.filter((x) => !x.is_test && (tier === "all" || x.tier === tier));

  // A graph click opens that symbol's row: widen the filter and page size if the
  // row is hidden, then bring it into view. Clicking a node and landing on
  // nothing is the failure this avoids.
  const pick = (id: string) => {
    setOpen(id);
    const it = data.impacted.find((x) => x.id === id);
    if (!it || it.is_test) return;
    const all = tier === "all" || it.tier === tier ? list : data.impacted.filter((x) => !x.is_test);
    if (all !== list) setTier("all");
    setLimit((l) => Math.max(l, all.indexOf(it) + 1));
    setJump(id);
  };
  useEffect(() => {
    if (!jump) return;
    document.querySelector(`[data-row="${CSS.escape(jump)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setJump(null);
  }, [jump]);

  if (data.error) return <ProblemList repo={repo} problems={[{ ref: "", error: data.error }]} />;

  const sev = fromLevel(data.risk.level);
  const c = data.risk.components;

  return (
    <Stack>
      <ProblemList repo={repo} problems={data.problems} onPick={onPick} />

      <Sheet no="01 · Readout" title="Risk, with its working" tone="library" action={<Receipts r={data.receipts} />}>
        <div className="grid gap-[clamp(20px,4vw,56px)] lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)]">
          <div>
            <RiskGauge score={data.risk.score} level={sev} />
            <div className="mt-6 grid grid-cols-3 gap-4 border-t border-line pt-4">
              {TIERS.map((t) => (
                <Figure key={t} label={t} value={num(data.counts[t])} tone={tierText(t)} />
              ))}
            </div>
            {data.markdown && (
              <div className="mt-5">
                <CopyButton text={data.markdown} label="Copy as markdown" />
              </div>
            )}
          </div>
          <div className="min-w-0">
            <Spec
              rows={[
                ["Expected breakages", "Sum of break probability over every impacted symbol", c.expected_breakages.toFixed(1)],
                ["Definite", "Impacted symbols whose break probability clears the definite threshold", num(c.definite)],
                ["Files touched", "Distinct files holding an impacted symbol", num(c.files)],
                ["Seed centrality", "Highest PageRank among the changed symbols, relative to the most central symbol in the repo", c.seed_centrality.toFixed(2)],
                ["Untested seeds", "Changed symbols no test reaches", num(c.untested_seeds)],
                ["Depth reached", "Hops walked out of the depth you allowed", `${data.hops} / ${data.max_depth}`],
              ]}
            />
            {data.untested_seeds.length > 0 && (
              // The most actionable sentence on the page: a change nothing tests cannot be verified by running anything.
              <Callout tone="warn" title="Untested" className="mt-4">
                No test reaches {data.untested_seeds.slice(0, 8).map((s) => s.name).join(", ")}
                {data.untested_seeds.length > 8 && ` and ${num(data.untested_seeds.length - 8)} more`}.
              </Callout>
            )}
          </div>
        </div>
      </Sheet>

      <Sheet no="02 · Blast radius" title={<>What depends on it, <em>hop by hop</em></>} tone="void" flush bodyClassName="pt-4">
        {data.impacted.length ? (
          <ImpactGraph repo={repo} data={data} onSelect={pick} selected={open ?? undefined} />
        ) : (
          <Empty title="Nothing depends on this">No resolved caller, subclass or co-change partner was found within {data.max_depth} hops.</Empty>
        )}
      </Sheet>

      <Cols>
        <Sheet
          no="03 · Ledger"
          title={
            <>
              Impacted symbols <em>{num(list.length)}</em>
            </>
          }
          action={<Seg label="Filter by tier" size="sm" value={tier} onChange={setTier} options={(["all", ...TIERS] as const).map((t) => ({ value: t, label: t }))} />}
        >
          {list.length ? (
            <ul className="gt-ledger">
              {list.slice(0, limit).map((it, i) => (
                <ImpactRow key={it.id} repo={repo} it={it} i={i} open={open === it.id} onToggle={() => setOpen(open === it.id ? null : it.id)} />
              ))}
            </ul>
          ) : (
            <p className="py-3 text-[13px] text-ink-dim">Nothing in this tier.</p>
          )}
          {list.length > limit && (
            <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setLimit(limit + 60)}>
              Show more ({num(list.length - limit)} left)
            </Button>
          )}
        </Sheet>

        <Stack>
          <Sheet
            no="04"
            title={
              <>
                Tests to run <em>{num(data.tests.length)}</em>
              </>
            }
            tone="fragment"
            action={
              data.tests.length ? (
                <>
                  <CopyButton text={`pytest ${[...new Set(data.tests.map((t) => pytestNode(t.id)))].join(" ")}`} label="pytest" />
                  {runHref && (
                    <Button asChild size="sm" className="h-7">
                      <Link href={runHref}>
                        <Play className="size-3.5" aria-hidden /> Run
                      </Link>
                    </Button>
                  )}
                </>
              ) : undefined
            }
          >
            {data.runtime_tests ? (
              <p className="mb-2 text-[12px] text-ink-dim">
                <span className="text-mark">{data.runtime_tests}</span> found by recorded coverage: they ran this code, whether or not a static edge reaches it.
              </p>
            ) : null}
            {data.tests.length ? (
              <>
                <ul className="gt-ledger">
                  {data.tests.slice(0, 30).map((t) => (
                    <li key={t.id} className="gt-row grid-cols-[minmax(0,1fr)_auto_auto] py-2">
                      <SymLink repo={repo} id={t.id} name={t.name} className="truncate text-[12.5px]" />
                      {/* Measured, not inferred — the strongest evidence on this panel. */}
                      {t.runtime ? <Chip tone="info">ran it</Chip> : <span />}
                      <span className="gt-f">{pct(t.p)}</span>
                    </li>
                  ))}
                </ul>
                {data.tests.length > 30 && <p className="pt-2 font-mono text-[10.5px] text-ink-faint">and {num(data.tests.length - 30)} more — copy and run use all of them.</p>}
              </>
            ) : (
              <p className="text-[13px] leading-relaxed text-ink-dim">
                No test reaches this change. Record per-test coverage (<code className="font-mono text-ink">aftershock coverage {repo}</code>) to catch tests a static edge misses.
              </p>
            )}
          </Sheet>

          <Sheet no="05" title="Hidden coupling" note="Files that keep changing with yours but have no edge in the graph." tone="fragment">
            {data.hidden_coupling.length ? (
              <ul className="gt-ledger">
                {data.hidden_coupling.slice(0, 10).map((h) => (
                  <li key={h.path} className="gt-row grid-cols-[minmax(0,1fr)_auto] py-2">
                    <span className="min-w-0">
                      <FileLink repo={repo} path={h.path} className="block truncate text-[12.5px]" />
                      <span className="mt-0.5 block text-[11.5px] text-ink-faint">
                        changed together {h.count}× {h.via?.length ? `with ${h.via.join(", ")}` : ""}, no static edge
                      </span>
                    </span>
                    <span className="gt-f text-warn">{pct(h.strength)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-dim">No co-change partner without a static edge.</p>
            )}
          </Sheet>

          <Sheet no="06" title="Import-only dependents" tone="fragment">
            {data.import_only?.length ? (
              <ul className="gt-ledger">
                {data.import_only.slice(0, 10).map((r) => (
                  <li key={`${r.file}->${r.imports}`} className="gt-row grid-cols-1 py-2">
                    <FileLink repo={repo} path={r.file} line={r.line ?? undefined} className="block truncate text-[12.5px]" />
                    <span className="truncate text-[11.5px] text-ink-faint">
                      imports {r.imports.split("/").pop()}
                      {r.names?.length ? ` (${r.names.slice(0, 3).join(", ")}${r.names.length > 3 ? ", …" : ""})` : ""}, no resolved call
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-dim">Every importer of the changed files is already above.</p>
            )}
          </Sheet>

          <Sheet no="07" title="Who to ask" tone="fragment">
            {data.owners.length ? (
              <ul className="gt-ledger">
                {data.owners.slice(0, 6).map((o) => (
                  <li key={o.email} className="gt-row grid-cols-[minmax(0,1fr)_auto] py-2">
                    {/* The email disambiguates two people with one name; it is already in the indexed history. */}
                    <span className="gt-row__name truncate text-[13.5px]" title={o.email}>
                      {o.name}
                    </span>
                    <span className="gt-f">
                      {num(o.commits)} commits
                      {o.last && <i>{relTime(o.last)}</i>}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-dim">No git history indexed.</p>
            )}
          </Sheet>
        </Stack>
      </Cols>

      <Sheet
        no="08 · Files"
        title={
          <>
            By file <em>{num(data.files.length)}</em>
          </>
        }
      >
        <div className="gt-scroll max-h-[520px] overflow-auto">
          <div className="gt-row sticky top-0 z-10 grid-cols-[minmax(0,1fr)_56px_64px_52px_44px] bg-sheet py-2">
            <span className="gt-label">File</span>
            <span className="gt-label text-right">p</span>
            <span className="gt-label text-right">Symbols</span>
            <span className="gt-label text-right">Tests</span>
            <span className="gt-label text-right">Hop</span>
          </div>
          {data.files.slice(0, 50).map((f) => (
            <div key={f.file} data-hit className="gt-row grid-cols-[minmax(0,1fr)_56px_64px_52px_44px] py-2">
              <FileLink repo={repo} path={f.file} className="truncate text-[12.5px]" />
              <span className="gt-f text-mark">{pct(f.p)}</span>
              <span className="gt-f">{f.symbols}</span>
              <span className="gt-f">{f.tests}</span>
              <span className="gt-f">{f.min_hop}</span>
            </div>
          ))}
        </div>
        {data.files.length > 50 && <p className="pt-2 font-mono text-[10.5px] text-ink-faint">showing 50 of {num(data.files.length)}</p>}
      </Sheet>

      {data.note && <p className="gt-note">{data.note}</p>}
    </Stack>
  );
}
