"use client";

/**
 * Explore: one symbol or one file, and everything the graph knows about it.
 *
 * This is the reference page the others link *into* — from an impact list, a
 * path hop, a suspect. So it is built to be landed on cold: the identity line
 * says what the thing is, the metrics say how load-bearing it is, and the two
 * neighbour lists say what sits on either side of it.
 *
 * Every neighbour carries how the edge was resolved and how confident the
 * resolver is. A call graph that does not admit which of its edges are guesses
 * is the thing that makes people stop trusting a tool like this.
 *
 * The empty state is not a blank slate. Landing here with nothing selected is
 * the most common way in, so it offers the two starting points that are almost
 * always right: the symbols most paths run through, and the files that keep
 * changing.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  Chip,
  Empty,
  ErrorNote,
  Grid,
  Kbd,
  Metric,
  Mono,
  Page,
  PageHeader,
  Panel,
  Spinner,
  Stack,
} from "@/components/ds";
import { GraphCanvas, type GEdge, type GNode } from "@/components/graph-canvas";
import { Code, FileCode, Flow, Search, TestTube, Users, Zap } from "@/components/icons";
import { FileLink, Receipts, SymLink } from "@/components/kit";
import { repoHref } from "@/components/shell/nav";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { api, type FileDetail, type Neighbor, type SymbolBrief, type SymbolDetail } from "@/lib/api";
import { HOW, num, pct, relTime, splitId, symName } from "@/lib/format";
import { useModKey, useQuery, useRepo } from "@/lib/hooks";

/** Six numbers across the top of a symbol or file. The shape is identical for both so the eye does not have to re-learn it. */
function Metrics({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-4 rounded-nested border border-line bg-surface-raised p-4 sm:grid-cols-3 lg:grid-cols-6">
      {children}
    </div>
  );
}

function NeighborList({ repo, items, empty }: { repo: string; items: Neighbor[]; empty: string }) {
  if (!items.length) return <p className="p-2 text-body-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="space-y-0.5">
      {items.map((n) => (
        <li key={`${n.id}:${n.type}`} className="flex items-center gap-2 rounded-inner px-2 py-1 hover:bg-accent">
          <SymLink repo={repo} id={n.id} name={n.name} className="min-w-0 truncate text-caption" />
          {/* Only non-call edges are labelled: CALLS is the default reading, and
              tagging every row with it would bury the inheritance edges. */}
          {n.type !== "CALLS" && (
            <Chip size="sm" tone="neutral">
              {n.type.toLowerCase()}
            </Chip>
          )}
          <Mono className="ml-auto shrink-0 text-micro text-ink-faint">
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
    add(s.id, s.qname, `${s.file}:${s.line}`, "bg-brand", "1");
    // Capped at 24 a side: beyond that the layout is a hairball and the lists
    // below are the better way to read it. The panel header says so.
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
    <Stack className="gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h2 className="font-mono text-subheading text-ink-strong">{symName(s.qname)}</h2>
        <Chip tone="neutral">{s.kind}</Chip>
        {s.is_test && (
          <Chip tone="info">
            <TestTube className="size-3.5" aria-hidden /> test
          </Chip>
        )}
        <FileLink repo={repo} path={s.file} line={s.line} className="text-caption" />
        <div className="ml-auto flex gap-2">
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
        </div>
      </div>

      {s.signature && (
        <pre className="overflow-x-auto rounded-nested border border-line bg-ground px-4 py-3 font-mono text-code text-ink">
          {s.signature}
        </pre>
      )}
      {s.doc && <p className="max-w-3xl text-body-sm leading-relaxed whitespace-pre-line text-ink-muted">{s.doc}</p>}

      <Metrics>
        <Metric size="sm" label="Callers" value={num(s.fan_in)} />
        <Metric size="sm" label="Callees" value={num(s.fan_out)} />
        <Metric size="sm" label="Lines" value={num(s.loc)} hint={`${s.line}–${s.end_line}`} />
        <Metric size="sm" label="Complexity" value={num(s.complexity)} />
        <Metric
          size="sm"
          label="PageRank"
          value={s.pagerank !== undefined ? (s.pagerank * 1000).toFixed(2) : "—"}
          hint="× 10⁻³"
        />
        <Metric size="sm" label="Betweenness" value={num(s.betweenness)} />
      </Metrics>

      {(s.bases?.length || s.decorators?.length) && (
        <div className="flex flex-wrap gap-2">
          {s.bases?.map((b) => (
            <Chip key={b} tone="neutral">
              extends {b}
            </Chip>
          ))}
          {s.decorators?.map((b) => (
            <Chip key={b} tone="neutral">
              @{b}
            </Chip>
          ))}
        </div>
      )}

      {nodes.length > 1 && (
        <Panel
          title="Neighbourhood"
          note={
            shown < total
              ? `Callers left, callees right; click a node to walk to it. Showing ${shown} of ${total} — the lists below have all of them.`
              : "Callers left, callees right; click a node to walk to it."
          }
          bodyClassName="p-3"
        >
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            height={380}
            selected={s.id}
            onSelect={(id) => id !== s.id && router.push(repoHref(repo, `/explore?ref=${encodeURIComponent(id)}`))}
          />
        </Panel>
      )}

      <Grid cols={2}>
        <Panel title={`Callers · ${num(d.callers.length)}`} bodyClassName="max-h-96 overflow-y-auto p-2">
          <NeighborList
            repo={repo}
            items={d.callers}
            empty="No resolved caller. It may be an entry point, called dynamically, or dead."
          />
        </Panel>
        <Panel title={`Callees · ${num(d.callees.length)}`} bodyClassName="max-h-96 overflow-y-auto p-2">
          <NeighborList repo={repo} items={d.callees} empty="Calls nothing the resolver could bind inside this repo." />
        </Panel>
      </Grid>
    </Stack>
  );
}

function FileView({ repo, d }: { repo: string; d: FileDetail }) {
  const f = d.file;
  const syms = d.symbols.filter((s) => s.kind !== "module");
  return (
    <Stack className="gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <h2 className="font-mono text-subheading break-all text-ink-strong">{f.path}</h2>
        <Chip tone="neutral">{f.lang}</Chip>
        {f.is_test && (
          <Chip tone="info">
            <TestTube className="size-3.5" aria-hidden /> test file
          </Chip>
        )}
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <Link href={repoHref(repo, `/impact?t=${encodeURIComponent(f.path)}&change=body`)}>
            <Zap className="size-3.5" aria-hidden /> Impact of this file
          </Link>
        </Button>
      </div>

      <Metrics>
        <Metric size="sm" label="Lines" value={num(f.loc)} />
        <Metric size="sm" label="Symbols" value={num(syms.length)} />
        <Metric size="sm" label="Commits" value={num(f.commits)} />
        <Metric size="sm" label="Churn" value={num(f.churn)} hint="lines added + deleted" />
        <Metric size="sm" label="Authors" value={num(f.authors)} />
        <Metric size="sm" label="Last change" value={relTime(f.last_change)} />
      </Metrics>

      <Grid cols="main-aside">
        <Panel title={`Symbols · ${num(syms.length)}`} bodyClassName="max-h-[520px] overflow-y-auto p-2">
          <ul className="space-y-0.5">
            {syms
              .sort((a, b) => a.line - b.line)
              .map((s) => (
                <li key={s.id} className="flex items-center gap-2 rounded-inner px-2 py-1 hover:bg-accent">
                  <Mono className="w-10 shrink-0 text-right text-micro text-ink-faint">{s.line}</Mono>
                  <SymLink repo={repo} id={s.id} name={s.qname} className="min-w-0 truncate text-caption" />
                  <span className="ml-auto shrink-0 text-micro text-ink-faint">{s.kind}</span>
                  {s.fan_in !== undefined && (
                    <Mono className="w-12 shrink-0 text-right text-micro text-ink-muted">
                      <span aria-hidden>{s.fan_in}↙</span>
                      <span className="sr-only">{s.fan_in} callers</span>
                    </Mono>
                  )}
                </li>
              ))}
          </ul>
        </Panel>

        <Stack className="min-w-0 gap-4">
          <Panel title={`Imports · ${num(d.imports.length)}`} bodyClassName="max-h-56 overflow-y-auto p-2">
            {d.imports.length ? (
              <ul className="space-y-0.5 text-caption">
                {d.imports.map((i) => (
                  <li key={i.path} className="truncate px-2 py-0.5">
                    <FileLink repo={repo} path={i.path} />
                    {i.names?.length ? (
                      <Mono className="ml-2 text-micro text-ink-faint">{i.names.slice(0, 6).join(", ")}</Mono>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">No in-repo imports.</p>
            )}
            {d.externals.length > 0 && (
              <Mono className="mt-2 block px-2 text-micro text-ink-faint">external: {d.externals.join(", ")}</Mono>
            )}
          </Panel>

          <Panel title={`Imported by · ${num(d.importers.length)}`} bodyClassName="max-h-56 overflow-y-auto p-2">
            {d.importers.length ? (
              <ul className="space-y-0.5 text-caption">
                {d.importers.map((i) => (
                  <li key={i.path} className="truncate px-2 py-0.5">
                    <FileLink repo={repo} path={i.path} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">Nothing in the repo imports this file.</p>
            )}
          </Panel>

          <Panel
            title="Changes with"
            note="Mined from git history, not from the call graph — these files have no edge between them."
            bodyClassName="p-2"
          >
            {d.cochange.length ? (
              <ul className="space-y-0.5 text-caption">
                {d.cochange.slice(0, 8).map((c) => (
                  <li key={c.path} className="flex items-center gap-2 px-2 py-0.5">
                    <FileLink repo={repo} path={c.path} className="min-w-0 truncate" />
                    <Mono className="ml-auto shrink-0 text-micro text-ink-faint">
                      {c.count}× · {pct(c.strength)}
                    </Mono>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">No co-change partner in the mined history.</p>
            )}
          </Panel>

          <Panel title="Owners" bodyClassName="p-2">
            {d.owners.length ? (
              <ul className="space-y-0.5 text-caption">
                {d.owners.slice(0, 5).map((o) => (
                  <li key={o.email} className="flex items-center gap-2 px-2 py-0.5">
                    <Users className="size-3.5 text-ink-faint" aria-hidden />
                    <span className="text-ink-strong">{o.name}</span>
                    <Mono className="ml-auto text-micro text-ink-faint">{num(o.commits)} commits</Mono>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-2 text-body-sm text-ink-muted">No git history indexed.</p>
            )}
          </Panel>
        </Stack>
      </Grid>
    </Stack>
  );
}

/** The name was ambiguous — two `run`s in two modules. Disambiguating is the reader's call, not a guess. */
function Candidates({ repo, items }: { repo: string; items: SymbolBrief[] }) {
  return (
    <Panel title={`${items.length} symbols share that name`} note="Pick the one you meant." bodyClassName="p-2">
      <ul className="space-y-0.5">
        {items.map((c) => (
          <li key={c.id} className="flex items-center gap-2 rounded-inner px-2 py-1 hover:bg-accent">
            <Code className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
            <SymLink repo={repo} id={c.id} name={c.qname} className="text-caption" />
            <Mono className="ml-auto text-micro text-ink-faint">
              {c.kind} · {c.file}:{c.line}
            </Mono>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Suggestions({ repo }: { repo: string }) {
  const q = useQuery(`overview:${repo}`, () => api.overview(repo));
  const mod = useModKey();
  const central = q.data?.central.slice(0, 8) ?? [];
  const hot = q.data?.hotspots.slice(0, 6) ?? [];
  const chip =
    "inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-line px-3 py-1 font-mono text-caption text-ink transition-colors hover:border-line-loud hover:text-ink-strong";
  return (
    <Stack className="gap-4">
      <p className="flex flex-wrap items-center gap-1.5 text-body-sm text-ink-muted">
        <Search className="size-4 text-ink-faint" aria-hidden />
        Search above, or start from one of these. Press <Kbd>{mod}</Kbd>
        <Kbd>K</Kbd> anywhere to jump.
      </p>
      {q.error ? (
        <ErrorNote error={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <Spinner label="Finding good starting points" />
      ) : (
        <Grid cols={2}>
          <Panel
            title="Load-bearing symbols"
            note="Ranked by betweenness: most paths through the graph run through these."
            bodyClassName="flex flex-wrap gap-2 p-3"
          >
            {central.length ? (
              central.map((c) => (
                <Link
                  key={c.id}
                  href={repoHref(repo, `/explore?ref=${encodeURIComponent(c.id)}`)}
                  className={chip}
                  // The file:line disambiguates two same-named symbols, and the
                  // link text alone cannot carry it without wrecking the chip.
                  title={`${c.file}:${c.line}`}
                >
                  <Code className="size-3.5 shrink-0 text-brand" aria-hidden /> {symName(c.qname)}
                </Link>
              ))
            ) : (
              <p className="text-body-sm text-ink-muted">No call graph yet.</p>
            )}
          </Panel>
          <Panel
            title="Hotspot files"
            note="Change often and are complex — where regressions tend to come from."
            bodyClassName="flex flex-wrap gap-2 p-3"
          >
            {hot.length ? (
              hot.map((h) => (
                <Link key={h.path} href={repoHref(repo, `/explore?file=${encodeURIComponent(h.path)}`)} className={chip}>
                  <FileCode className="size-3.5 shrink-0 text-info" aria-hidden /> {h.path}
                </Link>
              ))
            ) : (
              <p className="text-body-sm text-ink-muted">No git history indexed.</p>
            )}
          </Panel>
        </Grid>
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
  const q = useQuery(ref || file ? `explore:${repo}:${ref}:${file}` : null, () =>
    file ? api.file(repo, file) : api.symbol(repo, ref),
  );
  const d = q.data;

  const open = (v: string[]) => {
    setPick([]);
    const x = v[v.length - 1];
    if (!x) return;
    // A symbol id carries `::`; anything with a slash and no `::` is a path.
    router.push(
      repoHref(
        repo,
        x.includes("::") || !x.includes("/")
          ? `/explore?ref=${encodeURIComponent(x)}`
          : `/explore?file=${encodeURIComponent(x)}`,
      ),
    );
  };

  return (
    <Page>
      <PageHeader
        title="Explore"
        sub="Any symbol or file: its signature, who calls it, what it calls, what changes with it and who owns it. Every edge shows how it was resolved."
      >
        {d && "receipts" in d && <Receipts r={(d as SymbolDetail).receipts} />}
      </PageHeader>

      <div className="mb-6 max-w-2xl">
        <SymbolPicker
          repo={repo}
          value={pick}
          onChange={open}
          multiple={false}
          placeholder="Jump to a symbol or file…"
        />
      </div>

      {!ref && !file ? (
        <Suggestions repo={repo} />
      ) : q.error ? (
        <ErrorNote error={q.error} onRetry={q.reload} />
      ) : !d ? (
        <Spinner label="Reading the graph" />
      ) : "candidates" in d ? (
        d.candidates.length ? (
          <Candidates repo={repo} items={d.candidates} />
        ) : (
          <Empty title={`Nothing named “${splitId(ref)[1] || ref}”`} icon={<FileCode className="size-6" aria-hidden />}>
            The index may predate this symbol — re-index the repository if you added it recently.
          </Empty>
        )
      ) : "symbol" in d ? (
        <SymbolView repo={repo} d={d} />
      ) : (
        <FileView repo={repo} d={d} />
      )}
    </Page>
  );
}
