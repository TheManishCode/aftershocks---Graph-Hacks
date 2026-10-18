"use client";

/**
 * Explore: one symbol or one file, and everything the graph knows about it.
 *
 * This is the reference page the others link *into* — from an impact list, a
 * path hop, a suspect — so it is built to be landed on cold: the identity line
 * says what the thing is, the figures say how load-bearing it is, and the two
 * neighbour ledgers say what sits on either side of it.
 *
 * Every neighbour carries how the edge was resolved and how confident the
 * resolver is. A call graph that does not admit which of its edges are guesses
 * is what makes people stop trusting a tool like this.
 *
 * Landing here with nothing selected is the most common way in, so the empty
 * state offers the two starting points that are almost always right.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Chip, Cols, CodeBlock, Empty, ErrorNote, Figure, Head, Measuring, Mono, Page, Sheet, Stack } from "@/components/gt";
import { GraphCanvas, type GEdge, type GNode } from "@/components/graph-canvas";
import { Code, FileCode, Flow, TestTube, Users, Zap } from "@/components/icons";
import { FileLink, Receipts, SymLink } from "@/components/kit";
import { Enter } from "@/components/motion";
import { repoHref } from "@/components/shell/nav";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { api, type FileDetail, type Neighbor, type SymbolBrief, type SymbolDetail } from "@/lib/api";
import { HOW, num, pct, relTime, splitId, symName } from "@/lib/format";
import { useModKey, useQuery, useRepo } from "@/lib/hooks";

const KBD = "inline-grid h-5 min-w-5 place-items-center border border-line-loud px-1 font-mono text-[10px] text-ink-dim";

/** Six figures across the top of a symbol or file. Same shape for both, so the eye does not re-learn it. */
function Figures({ children }: { children: React.ReactNode }) {
  return <Enter className="grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-3 lg:grid-cols-6 [&>*]:bg-sheet [&>*]:p-4">{children}</Enter>;
}

function NeighborList({ repo, items, empty }: { repo: string; items: Neighbor[]; empty: string }) {
  if (!items.length) return <p className="px-[clamp(14px,2vw,24px)] pb-5 text-[13px] text-ink-dim">{empty}</p>;
  return (
    <ul className="gt-scroll max-h-96 pb-2">
      {items.map((n) => (
        <li key={`${n.id}:${n.type}`} className="gt-row grid-cols-[minmax(0,1fr)_auto_auto]">
          <SymLink repo={repo} id={n.id} name={n.name} className="min-w-0 truncate text-[12.5px]" />
          {/* Only non-call edges are labelled: CALLS is the default reading, and
              tagging every row with it would bury the inheritance edges. */}
          {n.type !== "CALLS" ? <Chip>{n.type.toLowerCase()}</Chip> : <span />}
          <Mono className="text-[11px] text-ink-faint">
            {n.how ? (HOW[n.how] ?? n.how) : ""}
            {n.confidence !== undefined ? ` · ${pct(n.confidence)}` : ""}
          </Mono>
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
    add(s.id, s.qname, `${s.file}:${s.line}`, "bg-mark", "1");
    // Capped at 24 a side: beyond that the layout is a hairball and the ledgers
    // below are the better way to read it. The HUD says so.
    d.callers.slice(0, 24).forEach((c) => add(c.id, c.name, `${c.file}:${c.line}`, "bg-info", "0"));
    d.callees.slice(0, 24).forEach((c) => add(c.id, c.name, `${c.file}:${c.line}`, "bg-line-loud", "2"));
    const es: GEdge[] = [
      ...d.callers.slice(0, 24).map((c) => ({ src: c.id, dst: s.id, dashed: c.type !== "CALLS" })),
      ...d.callees.slice(0, 24).map((c) => ({ src: s.id, dst: c.id, dashed: c.type !== "CALLS" })),
    ];
    return { nodes: [...ns.values()], edges: es };
  }, [d, s]);

  const shown = Math.min(24, d.callers.length) + Math.min(24, d.callees.length);
  const total = d.callers.length + d.callees.length;

  return (
    <Stack>
      <Sheet
        no="01 · Identity"
        title={<span className="font-mono text-[clamp(18px,2.2vw,24px)] break-all">{symName(s.qname)}</span>}
        tone="library"
        action={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={repoHref(repo, `/impact?t=${encodeURIComponent(s.id)}&change=signature`)}>
                <Zap className="size-3.5" aria-hidden /> Impact
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={repoHref(repo, `/path?from=${encodeURIComponent(s.id)}`)}>
                <Flow className="size-3.5" aria-hidden /> Path from here
              </Link>
            </Button>
          </>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Chip>{s.kind}</Chip>
          {s.is_test && (
            <Chip tone="info">
              <TestTube className="size-3.5" aria-hidden /> test
            </Chip>
          )}
          {s.bases?.map((b) => <Chip key={b}>extends {b}</Chip>)}
          {s.decorators?.map((b) => <Chip key={b}>@{b}</Chip>)}
          <FileLink repo={repo} path={s.file} line={s.line} className="text-[12px]" />
        </div>
        {s.signature && <CodeBlock code={s.signature} noCopy className="mb-4" />}
        {s.doc && <p className="mb-4 max-w-3xl text-[13.5px] leading-relaxed whitespace-pre-line text-ink-dim">{s.doc}</p>}
        <Figures>
          <Figure label="Callers" value={num(s.fan_in)} />
          <Figure label="Callees" value={num(s.fan_out)} />
          <Figure label="Lines" value={num(s.loc)} hint={`${s.line}–${s.end_line}`} />
          <Figure label="Complexity" value={num(s.complexity)} />
          <Figure label="PageRank" value={s.pagerank !== undefined ? (s.pagerank * 1000).toFixed(2) : "—"} hint="× 10⁻³" />
          <Figure label="Betweenness" value={num(s.betweenness)} />
        </Figures>
      </Sheet>

      {nodes.length > 1 && (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          height={420}
          selected={s.id}
          hud={<span>Neighbourhood · {shown < total ? `${shown} of ${total}` : total} · callers left, callees right</span>}
          onSelect={(id) => id !== s.id && router.push(repoHref(repo, `/explore?ref=${encodeURIComponent(id)}`))}
        />
      )}

      <Cols kind="halves">
        <Sheet no="02 · In" title={`Callers · ${num(d.callers.length)}`} flush>
          <NeighborList repo={repo} items={d.callers} empty="No resolved caller. It may be an entry point, called dynamically, or dead." />
        </Sheet>
        <Sheet no="03 · Out" title={`Callees · ${num(d.callees.length)}`} flush>
          <NeighborList repo={repo} items={d.callees} empty="Calls nothing the resolver could bind inside this repo." />
        </Sheet>
      </Cols>
    </Stack>
  );
}

function FileView({ repo, d }: { repo: string; d: FileDetail }) {
  const f = d.file;
  const syms = d.symbols.filter((s) => s.kind !== "module");
  const empty = "px-[clamp(14px,2vw,24px)] pb-5 text-[13px] text-ink-dim";
  return (
    <Stack>
      <Sheet
        no="01 · Identity"
        title={<span className="font-mono text-[clamp(16px,2vw,22px)] break-all">{f.path}</span>}
        tone="library"
        action={
          <Button asChild variant="outline" size="sm">
            <Link href={repoHref(repo, `/impact?t=${encodeURIComponent(f.path)}&change=body`)}>
              <Zap className="size-3.5" aria-hidden /> Impact of this file
            </Link>
          </Button>
        }
      >
        <div className="mb-4 flex flex-wrap gap-2">
          <Chip>{f.lang}</Chip>
          {f.is_test && (
            <Chip tone="info">
              <TestTube className="size-3.5" aria-hidden /> test file
            </Chip>
          )}
        </div>
        <Figures>
          <Figure label="Lines" value={num(f.loc)} />
          <Figure label="Symbols" value={num(syms.length)} />
          <Figure label="Commits" value={num(f.commits)} />
          <Figure label="Churn" value={num(f.churn)} hint="lines added + deleted" />
          <Figure label="Authors" value={num(f.authors)} />
          <Figure label="Last change" value={relTime(f.last_change)} />
        </Figures>
      </Sheet>

      <Cols kind="main-aside">
        <Sheet no="02 · Contents" title={`Symbols · ${num(syms.length)}`} flush>
          <ul className="gt-scroll max-h-[560px] pb-2">
            {[...syms]
              .sort((a, b) => a.line - b.line)
              .map((s) => (
                <li key={s.id} className="gt-row grid-cols-[44px_minmax(0,1fr)_auto_48px]">
                  <Mono className="text-right text-[11px] text-ink-faint">{s.line}</Mono>
                  <SymLink repo={repo} id={s.id} name={s.qname} className="min-w-0 truncate text-[12.5px]" />
                  <span className="font-mono text-[10.5px] text-ink-faint">{s.kind}</span>
                  <Mono className="text-right text-[11px] text-ink-dim">
                    {s.fan_in !== undefined && (
                      <>
                        <span aria-hidden>{s.fan_in}↙</span>
                        <span className="sr-only">{s.fan_in} callers</span>
                      </>
                    )}
                  </Mono>
                </li>
              ))}
          </ul>
        </Sheet>

        <Stack className="min-w-0">
          <Sheet no="03" title={`Imports · ${num(d.imports.length)}`} tone="fragment" flush>
            {d.imports.length ? (
              <ul className="gt-scroll max-h-56 pb-2">
                {d.imports.map((i) => (
                  <li key={i.path} className="gt-row grid-cols-[minmax(0,1fr)] text-[12px]"><span className="min-w-0 truncate">
                    <FileLink repo={repo} path={i.path} />
                    {i.names?.length ? <Mono className="ml-2 text-[11px] text-ink-faint">{i.names.slice(0, 6).join(", ")}</Mono> : null}
                  </span></li>
                ))}
              </ul>
            ) : (
              <p className={empty}>No in-repo imports.</p>
            )}
            {d.externals.length > 0 && <Mono className="block px-[clamp(14px,2vw,24px)] pb-4 text-[11px] text-ink-faint">external: {d.externals.join(", ")}</Mono>}
          </Sheet>

          <Sheet no="04" title={`Imported by · ${num(d.importers.length)}`} tone="fragment" flush>
            {d.importers.length ? (
              <ul className="gt-scroll max-h-56 pb-2">
                {d.importers.map((i) => (
                  <li key={i.path} className="gt-row grid-cols-[minmax(0,1fr)] text-[12px]"><span className="min-w-0 truncate">
                    <FileLink repo={repo} path={i.path} />
                  </span></li>
                ))}
              </ul>
            ) : (
              <p className={empty}>Nothing in the repo imports this file.</p>
            )}
          </Sheet>

          <Sheet no="05" title="Changes with" note="Mined from git history, not the call graph — these files have no edge between them." tone="fragment" flush>
            {d.cochange.length ? (
              <ul className="pb-2">
                {d.cochange.slice(0, 8).map((c) => (
                  <li key={c.path} className="gt-row grid-cols-[minmax(0,1fr)_auto] text-[12px]">
                    <FileLink repo={repo} path={c.path} className="min-w-0 truncate" />
                    <Mono className="text-[11px] text-ink-faint">
                      {c.count}× · {pct(c.strength)}
                    </Mono>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={empty}>No co-change partner in the mined history.</p>
            )}
          </Sheet>

          <Sheet no="06" title="Owners" tone="fragment" flush>
            {d.owners.length ? (
              <ul className="pb-2">
                {d.owners.slice(0, 5).map((o) => (
                  <li key={o.email} className="gt-row grid-cols-[16px_minmax(0,1fr)_auto] text-[12.5px]">
                    <Users className="size-3.5 text-ink-faint" aria-hidden />
                    <span className="truncate text-ink">{o.name}</span>
                    <Mono className="text-[11px] text-ink-faint">{num(o.commits)} commits</Mono>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={empty}>No git history indexed.</p>
            )}
          </Sheet>
        </Stack>
      </Cols>
    </Stack>
  );
}

/** The name was ambiguous — two `run`s in two modules. Disambiguating is the reader's call, not a guess. */
function Candidates({ repo, items }: { repo: string; items: SymbolBrief[] }) {
  return (
    <Sheet no="01 · Ambiguous" title={`${items.length} symbols share that name`} note="Pick the one you meant." tone="commission" flush>
      <ul className="pb-2">
        {items.map((c) => (
          <li key={c.id} className="gt-row grid-cols-[16px_minmax(0,1fr)_auto]">
            <Code className="size-3.5 text-ink-faint" aria-hidden />
            <SymLink repo={repo} id={c.id} name={c.qname} className="min-w-0 truncate text-[12.5px]" />
            <Mono className="text-[11px] text-ink-faint">
              {c.kind} · {c.file}:{c.line}
            </Mono>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function Suggestions({ repo }: { repo: string }) {
  const q = useQuery(`overview:${repo}`, () => api.overview(repo));
  const mod = useModKey();
  const central = q.data?.central.slice(0, 8) ?? [];
  const hot = q.data?.hotspots.slice(0, 6) ?? [];
  return (
    <Stack>
      <p className="gt-note flex flex-wrap items-center gap-1.5">
        Search above, or start from one of these. Press <kbd className={KBD}>{mod}</kbd>
        <kbd className={KBD}>K</kbd> anywhere to jump.
      </p>
      {q.error ? (
        <ErrorNote error={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <Measuring label="Finding good starting points" />
      ) : (
        <Cols kind="halves">
          <Sheet no="A · Centre" title="Load-bearing symbols" note="Ranked by betweenness: most paths through the graph run through these." tone="library" flush>
            {central.length ? (
              <ul className="pb-2">
                {central.map((c, i) => (
                  <li key={c.id}>
                    {/* The file:line disambiguates two same-named symbols. */}
                    <Link href={repoHref(repo, `/explore?ref=${encodeURIComponent(c.id)}`)} className="gt-row grid-cols-[28px_minmax(0,1fr)]" data-hover-mark title={`${c.file}:${c.line}`}>
                      <span className="gt-row__no">{String(i + 1).padStart(2, "0")}</span>
                      <span className="gt-row__name truncate font-mono text-[12.5px]">{symName(c.qname)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-[clamp(14px,2vw,24px)] pb-5 text-[13px] text-ink-dim">No call graph yet.</p>
            )}
          </Sheet>
          <Sheet no="B · Heat" title="Hotspot files" note="Change often and are complex — where regressions tend to come from." tone="fragment" flush>
            {hot.length ? (
              <ul className="pb-2">
                {hot.map((h, i) => (
                  <li key={h.path}>
                    <Link href={repoHref(repo, `/explore?file=${encodeURIComponent(h.path)}`)} className="gt-row grid-cols-[28px_minmax(0,1fr)]" data-hover-mark>
                      <span className="gt-row__no">{String(i + 1).padStart(2, "0")}</span>
                      <span className="gt-row__name flex min-w-0 items-center gap-2 font-mono text-[12.5px]">
                        <FileCode className="size-3.5 shrink-0 text-hot" aria-hidden />
                        <span className="truncate">{h.path}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-[clamp(14px,2vw,24px)] pb-5 text-[13px] text-ink-dim">No git history indexed.</p>
            )}
          </Sheet>
        </Cols>
      )}
    </Stack>
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
    // A symbol id carries `::`; anything with a slash and no `::` is a path.
    router.push(repoHref(repo, x.includes("::") || !x.includes("/") ? `/explore?ref=${encodeURIComponent(x)}` : `/explore?file=${encodeURIComponent(x)}`));
  };

  return (
    <Page>
      <Head
        no="07 · Explore"
        title={
          <>
            Everything the graph <em>knows about it.</em>
          </>
        }
        lead="Any symbol or file: its signature, who calls it, what it calls, what changes with it and who owns it. Every edge shows how it was resolved."
      >
        {d && "receipts" in d && <Receipts r={(d as SymbolDetail).receipts} />}
      </Head>

      <div className="mb-8 max-w-2xl">
        <SymbolPicker repo={repo} value={pick} onChange={open} multiple={false} placeholder="Jump to a symbol or file…" />
      </div>

      {!ref && !file ? (
        <Suggestions repo={repo} />
      ) : q.error ? (
        <ErrorNote error={q.error} onRetry={q.reload} />
      ) : !d ? (
        <Measuring label="Reading the graph" />
      ) : "candidates" in d ? (
        d.candidates.length ? (
          <Candidates repo={repo} items={d.candidates} />
        ) : (
          <Empty title={`Nothing named “${splitId(ref)[1] || ref}”`}>The index may predate this symbol — re-index the repository if you added it recently.</Empty>
        )
      ) : "symbol" in d ? (
        <SymbolView repo={repo} d={d} />
      ) : (
        <FileView repo={repo} d={d} />
      )}
    </Page>
  );
}
