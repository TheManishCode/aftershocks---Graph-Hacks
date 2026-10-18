"use client";

/**
 * The full answer to "what breaks if I change this".
 *
 * Shared by Impact and Diff, so it is the single densest surface in the
 * product. Three rules hold it together.
 *
 * 1. **Risk is a claim, so it is shown with its components.** The gauge is the
 *    headline; directly beneath it are the six numbers the score is computed
 *    from. A score with no breakdown is a number to argue with, not evidence.
 *
 * 2. **Colour means exactly one thing here.** The severity ramp carries
 *    likelihood — the risk level and the three tiers — and nothing else. The
 *    seeds you said you were changing are marked by the achromatic chrome, not
 *    by a hue of their own, so nothing on this page competes with the ramp. The
 *    eye should be able to read the tier without reading the word, but the word
 *    is always there too.
 *
 * 3. **Nothing is truncated silently.** Every list that caps says how many it
 *    is hiding, because a capped list that looks complete is worse than no list.
 */

import { useEffect, useMemo, useState } from "react";

import Link from "next/link";

import {
  Chip,
  Empty,
  Eyebrow,
  Grid,
  Meter,
  Metric,
  Mono,
  Panel,
  RiskGauge,
  Scroller,
  SEV_BG,
  SEV_TEXT,
  Segmented,
  Stack,
  fromLevel,
  fromTier,
} from "@/components/ds";
import { GraphCanvas, type GEdge, type GNode } from "@/components/graph-canvas";
import { AlertTriangle, ChevronDown, ChevronRight, GitDiff, Play, TestTube, Users } from "@/components/icons";
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
    <ol className="space-y-1.5 border-l border-line pl-3">
      {item.path.map((s, i) => (
        <li key={`${s.from}->${s.to}:${i}`} className="text-caption">
          <SymLink repo={repo} id={s.to} className="text-caption" />{" "}
          {/* A dispatch edge is two facts — a call, then a possible target — and
              collapsing it to "calls" would overstate what the graph knows. */}
          {s.type === "DISPATCH" && s.via ? (
            <>
              <span className="text-ink-muted">calls </span>
              <SymLink repo={repo} id={s.via} name={splitId(s.via)[1] || s.via} className="text-caption text-ink" />
              <span className="text-ink-muted">, which can dispatch to </span>
            </>
          ) : (
            <span className="text-ink-muted">{VERB[s.type] ?? s.type.toLowerCase()} </span>
          )}
          <SymLink repo={repo} id={s.from} name={splitId(s.from)[1] || s.from} className="text-caption text-ink" />
          <Mono className="ml-2 text-micro text-ink-faint">
            {s.how ? (HOW[s.how] ?? s.how) : ""}
            {s.confidence !== undefined ? ` · ${pct(s.confidence)}` : ""}
            {s.file && s.lines?.length ? ` · ${s.file}:${s.lines[0]}` : ""}
          </Mono>
          {s.verdict && (
            <Chip tone="warn" size="sm" className="ml-2">
              {s.verdict}
            </Chip>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Something the user named could not be resolved. This is a *warning*, not an
 * error: the rest of the analysis still ran, and the candidate buttons are the
 * fastest way to fix the input without retyping it.
 */
export function ProblemList({
  repo,
  problems,
  onPick,
}: {
  repo: string;
  problems?: Problem[];
  onPick?: (ref: string, id: string) => void;
}) {
  if (!problems?.length) return null;
  return (
    <div className="space-y-2">
      {problems.map((p) => (
        <div key={p.ref} className="rounded-nested border border-warn/30 bg-warn/5 px-3 py-2.5 text-body-sm">
          <div className="flex items-start gap-2 text-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
            <span>
              <Mono className="text-ink-strong">{p.ref}</Mono>: {p.error}
            </span>
          </div>
          {p.candidates?.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
              {p.candidates.slice(0, 10).map((c) =>
                onPick ? (
                  <Button
                    key={c.id}
                    variant="outline"
                    size="sm"
                    className="h-7 font-mono text-caption"
                    onClick={() => onPick(p.ref, c.id)}
                    aria-label={`Use ${c.qname} from ${c.file}`}
                  >
                    {symName(c.qname)} <span className="text-ink-faint">{c.file}</span>
                  </Button>
                ) : (
                  <SymLink key={c.id} repo={repo} id={c.id} className="text-caption" />
                ),
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ImpactGraph({
  repo,
  data,
  onSelect,
  selected,
}: {
  repo: string;
  data: Impact;
  onSelect: (id: string) => void;
  selected?: string;
}) {
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
        tone: seed ? "bg-brand" : it ? tierBg(it.tier) : "bg-line-loud",
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
        if (!es.has(k))
          es.set(k, {
            src: st.from,
            dst: st.to,
            dashed: st.type !== "CALLS",
            label: st.type === "CALLS" ? undefined : st.type.toLowerCase(),
          });
      }
    return { nodes: ns, edges: [...es.values()], hidden: Math.max(0, data.impacted.length - top.length) };
  }, [data]);

  return (
    <div>
      <GraphCanvas nodes={nodes} edges={edges} onSelect={onSelect} selected={selected} height={460} />
      <Selection repo={repo} data={data} id={selected} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-brand" aria-hidden /> changed
        </span>
        {TIERS.map((t) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", tierBg(t))} aria-hidden /> {t}
          </span>
        ))}
        <span>
          arrows run from the change to what depends on it · dashed (labelled) = inheritance, override, dispatch or
          co-change
        </span>
        {hidden > 0 && (
          <span className="ml-auto">
            showing the {GRAPH_CAP} most likely of {num(data.impacted.length)}
          </span>
        )}
      </div>
    </div>
  );
}

function ImpactRow({ repo, it, open, onToggle }: { repo: string; it: Impacted; open: boolean; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li
      data-row={it.id}
      className={cn("scroll-mt-20 rounded-nested border border-transparent", open && "border-brand/40 bg-surface-raised")}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-nested px-2 py-1.5 text-left hover:bg-accent"
        aria-expanded={open}
      >
        <Chevron className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        <Mono className={cn("w-16 shrink-0 text-micro", tierText(it.tier))}>{it.tier}</Mono>
        <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-ink-strong">
          {it.name}
          {it.is_test && <TestTube className="ml-1.5 inline size-3.5 text-info" aria-label="test" />}
        </span>
        <Mono className="hidden truncate text-micro text-ink-faint md:block md:max-w-[38%]">
          {it.file}:{it.line}
        </Mono>
        <Mono className="w-10 shrink-0 text-right text-micro text-ink-faint">h{it.hop}</Mono>
        <span className="w-20 shrink-0">
          <Mono className="block text-right text-micro text-ink">{pct(it.p)}</Mono>
          <Meter value={it.p} barClassName={tierBg(it.tier)} />
        </span>
      </button>
      {open && (
        <div className="px-8 pt-1 pb-3">
          <WhyChain repo={repo} item={it} />
          {(it.via ?? 1) > 1 && (
            <p className="mt-2 text-micro text-ink-muted">
              Reached by {it.via} independent paths; the most likely is shown.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * What the clicked node is, directly under the graph.
 *
 * The matching row in the list below is often off screen, so a click that only
 * scrolled somewhere else would feel like nothing happened. This answers in
 * place, and `aria-live` means it answers for a screen reader too.
 */
function Selection({ repo, data, id }: { repo: string; data: Impact; id?: string }) {
  if (!id) return <p className="mt-2 text-micro text-ink-faint">Click a node to see why it is impacted.</p>;
  const it = data.impacted.find((x) => x.id === id);
  const seed = data.seeds.find((s) => s.id === id);
  const step = it?.path[0]; // paths run from the impacted symbol toward the change
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-brand/40 bg-brand/[0.04] px-3 py-2 text-caption"
      aria-live="polite"
    >
      <SymLink repo={repo} id={id} name={symName(splitId(id)[1] || id)} className="font-mono text-body-sm" />
      {seed ? (
        <span className="text-brand">changed · {seed.change}</span>
      ) : it ? (
        <>
          <span className={tierText(it.tier)}>
            {it.tier} · {pct(it.p)}
          </span>
          <span className="text-ink-muted">
            hop {it.hop}
            {step && ` · ${VERB[step.type] ?? step.type.toLowerCase()} ${symName(splitId(step.to)[1] || step.to)}`}
          </span>
          {it.verdict && <span className="text-ink-strong">{it.verdict}</span>}
        </>
      ) : (
        <span className="text-ink-muted">on the path between the change and an impacted symbol</span>
      )}
    </div>
  );
}

/** `runHref`: the Tests page link that runs exactly this selection. */
export function ImpactView({
  repo,
  data,
  onPick,
  runHref,
}: {
  repo: string;
  data: Impact;
  onPick?: (ref: string, id: string) => void;
  runHref?: string;
}) {
  const [tier, setTier] = useState<Tier | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(40);
  const [jump, setJump] = useState<string | null>(null);
  const list = data.impacted.filter((x) => !x.is_test && (tier === "all" || x.tier === tier));

  // A graph click opens that symbol's row: widen the filter and the page size if
  // the row is currently hidden, then bring it into view. Clicking a node and
  // landing on nothing is the failure this avoids.
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

  const level = data.risk.level;
  const sev = fromLevel(level);
  const c = data.risk.components;

  if (data.error) return <ProblemList repo={repo} problems={[{ ref: "", error: data.error }]} />;

  return (
    <Stack className="gap-4">
      <ProblemList repo={repo} problems={data.problems} onPick={onPick} />

      <Grid cols="aside-main">
        <Panel title="Risk" action={<Receipts r={data.receipts} />}>
          <RiskGauge score={data.risk.score} level={sev} className="mb-4" />

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
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
                <dt>
                  <Eyebrow>{k}</Eyebrow>
                </dt>
                <dd className="mt-0.5 font-mono text-body-sm text-ink-strong tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-4">
            {TIERS.map((t) => (
              <Metric key={t} size="sm" label={t} value={num(data.counts[t])} tone={tierText(t)} />
            ))}
          </div>

          {data.untested_seeds.length > 0 && (
            // The single most actionable sentence on the page: a change nothing
            // tests cannot be verified by running anything.
            <p className="mt-4 rounded-control bg-warn/10 px-2.5 py-2 text-caption text-warn">
              No test reaches {data.untested_seeds.slice(0, 8).map((s) => s.name).join(", ")}
              {data.untested_seeds.length > 8 && ` and ${num(data.untested_seeds.length - 8)} more`}.
            </p>
          )}
          {data.markdown && (
            <div className="mt-4">
              <CopyButton text={data.markdown} label="Copy as markdown" />
            </div>
          )}
        </Panel>

        <Panel title="Blast radius" bodyClassName="p-3">
          {data.impacted.length ? (
            <ImpactGraph repo={repo} data={data} onSelect={pick} selected={open ?? undefined} />
          ) : (
            <Empty title="Nothing depends on this" icon={<GitDiff className="size-6" aria-hidden />}>
              No resolved caller, subclass or co-change partner was found within {data.max_depth} hops.
            </Empty>
          )}
        </Panel>
      </Grid>

      <Grid cols="main-aside">
        <Panel
          title={`Impacted symbols · ${num(list.length)}`}
          action={
            <Segmented
              label="Filter by tier"
              size="sm"
              value={tier}
              onChange={setTier}
              options={(["all", ...TIERS] as const).map((t) => ({ value: t, label: t }))}
            />
          }
          bodyClassName="p-2"
        >
          {list.length ? (
            <ul className="space-y-0.5">
              {list.slice(0, limit).map((it) => (
                <ImpactRow
                  key={it.id}
                  repo={repo}
                  it={it}
                  open={open === it.id}
                  onToggle={() => setOpen(open === it.id ? null : it.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="p-3 text-body-sm text-ink-muted">Nothing in this tier.</p>
          )}
          {list.length > limit && (
            <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setLimit(limit + 60)}>
              Show more ({num(list.length - limit)} left)
            </Button>
          )}
        </Panel>

        <Stack className="gap-4">
          <Panel
            title={`Tests to run · ${num(data.tests.length)}`}
            bodyClassName="p-2"
            action={
              data.tests.length ? (
                <div className="flex items-center gap-1.5">
                  <CopyButton
                    text={`pytest ${[...new Set(data.tests.map((t) => pytestNode(t.id)))].join(" ")}`}
                    label="pytest"
                    className="h-7"
                  />
                  {runHref && (
                    <Button asChild size="sm" className="h-7">
                      <Link href={runHref}>
                        <Play className="size-3.5" aria-hidden /> Run
                      </Link>
                    </Button>
                  )}
                </div>
              ) : undefined
            }
          >
            {data.runtime_tests ? (
              <p className="px-2 pb-1.5 text-micro text-ink-muted">
                {data.runtime_tests} found by recorded coverage: they ran this code, whether or not a static edge
                reaches it.
              </p>
            ) : null}
            {data.tests.length ? (
              <>
                <ul className="space-y-0.5">
                  {data.tests.slice(0, 30).map((t) => (
                    <li key={t.id} className="flex items-center gap-2 rounded-inner px-2 py-1 text-caption">
                      <TestTube className="size-3.5 shrink-0 text-info" aria-hidden />
                      <SymLink repo={repo} id={t.id} name={t.name} className="min-w-0 truncate text-caption" />
                      {t.runtime && (
                        // Measured, not inferred — worth its own token, because it is
                        // the strongest evidence on this panel.
                        <Chip tone="info" size="sm">
                          ran it
                        </Chip>
                      )}
                      <Mono className="ml-auto text-micro text-ink-faint">{pct(t.p)}</Mono>
                    </li>
                  ))}
                </ul>
                {data.tests.length > 30 && (
                  <p className="px-2 pt-1 text-micro text-ink-faint">
                    and {num(data.tests.length - 30)} more — the copy and run buttons use all of them.
                  </p>
                )}
              </>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">
                No test reaches this change. Record per-test coverage (
                <code className="font-mono">aftershock coverage {repo}</code>) to catch tests a static edge misses.
              </p>
            )}
          </Panel>

          <Panel
            title="Hidden coupling"
            note="Files that keep changing with yours but have no edge in the graph."
            bodyClassName="p-2"
          >
            {data.hidden_coupling.length ? (
              <ul className="space-y-1">
                {data.hidden_coupling.slice(0, 10).map((h) => (
                  <li key={h.path} className="rounded-inner px-2 py-1 text-caption">
                    <div className="flex items-center gap-2">
                      <FileLink repo={repo} path={h.path} className="min-w-0 truncate text-caption" />
                      <Mono className="ml-auto text-micro text-warn">{pct(h.strength)}</Mono>
                    </div>
                    <div className="mt-0.5 text-micro text-ink-muted">
                      changed together {h.count}× {h.via?.length ? `with ${h.via.join(", ")}` : ""}, no static edge
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">No co-change partner without a static edge.</p>
            )}
          </Panel>

          <Panel title="Import-only dependents" bodyClassName="p-2">
            {data.import_only?.length ? (
              <ul className="space-y-1">
                {data.import_only.slice(0, 10).map((r) => (
                  <li key={`${r.file}->${r.imports}`} className="rounded-inner px-2 py-1 text-caption">
                    <FileLink
                      repo={repo}
                      path={r.file}
                      line={r.line ?? undefined}
                      className="block min-w-0 truncate text-caption"
                    />
                    <div className="mt-0.5 truncate text-micro text-ink-muted">
                      imports {r.imports.split("/").pop()}
                      {r.names?.length
                        ? ` (${r.names.slice(0, 3).join(", ")}${r.names.length > 3 ? ", …" : ""})`
                        : ""}
                      , no resolved call
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">Every importer of the changed files is already above.</p>
            )}
          </Panel>

          <Panel title="Who to ask" bodyClassName="p-2">
            {data.owners.length ? (
              <ul className="space-y-1">
                {data.owners.slice(0, 6).map((o) => (
                  <li key={o.email} className="flex items-center gap-2 rounded-inner px-2 py-1 text-caption">
                    <Users className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                    {/* The email is the disambiguator when two people share a name,
                        and it is already in the indexed git history. */}
                    <span className="truncate text-ink-strong" title={o.email}>
                      {o.name}
                    </span>
                    <Mono className="ml-auto shrink-0 text-micro text-ink-faint">
                      {num(o.commits)} commits{o.last ? ` · ${relTime(o.last)}` : ""}
                    </Mono>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">No git history indexed.</p>
            )}
          </Panel>
        </Stack>
      </Grid>

      <Panel title={`Files · ${num(data.files.length)}`} flush>
        <Scroller className="max-h-[520px] overflow-x-auto">
          <table className="w-full text-caption">
            <thead className="sticky top-0 z-10 bg-surface-raised text-left">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-mono text-micro font-normal text-ink-muted">File</th>
                <th className="w-px px-2 py-2 text-right font-mono text-micro font-normal whitespace-nowrap text-ink-muted">p</th>
                <th className="w-px px-2 py-2 text-right font-mono text-micro font-normal whitespace-nowrap text-ink-muted">Symbols</th>
                <th className="w-px px-2 py-2 text-right font-mono text-micro font-normal whitespace-nowrap text-ink-muted">Tests</th>
                <th className="w-px px-4 py-2 text-right font-mono text-micro font-normal whitespace-nowrap text-ink-muted">Hop</th>
              </tr>
            </thead>
            <tbody>
              {data.files.slice(0, 50).map((f) => (
                <tr key={f.file} className="border-b border-line/60 last:border-0 hover:bg-accent">
                  <td className="w-full max-w-0 truncate px-4 py-1.5">
                    <FileLink repo={repo} path={f.file} />
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-ink tabular-nums">{pct(f.p)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{f.symbols}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{f.tests}</td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums">{f.min_hop}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroller>
        {data.files.length > 50 && (
          <p className="border-t border-line px-4 py-2 text-micro text-ink-faint">
            showing 50 of {num(data.files.length)}
          </p>
        )}
      </Panel>

      {data.note && <p className="text-caption text-ink-muted">{data.note}</p>}
    </Stack>
  );
}
