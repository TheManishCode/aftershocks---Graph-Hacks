"use client";

/**
 * Cypher: the graph itself, read-only.
 *
 * The escape hatch — every other page is a question someone decided to ask in
 * advance, and this is the one for the question nobody anticipated. It is
 * built to be *trusted*: the head states the safety properties (RO_QUERY, a
 * timeout and a row cap) outright, because an open query box over a graph is
 * otherwise a reasonable thing to be afraid of.
 *
 * The example queries are the documentation: five queries that return rows on
 * the reader's own repo teach more than a schema reference nobody can run.
 */

import { useState } from "react";

import { Cols, Empty, ErrorNote, Head, Measuring, Page, Sheet, Stack, no2 } from "@/components/gt";
import { Terminal } from "@/components/icons";
import { CopyButton, Receipts } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { num } from "@/lib/format";
import { useAction, useModKey, useRepo } from "@/lib/hooks";

const EXAMPLES: { label: string; query: string }[] = [
  {
    label: "Most called functions",
    query: "MATCH (s:Symbol) WHERE s.kind IN ['function','method']\nRETURN s.qname AS name, s.file AS file, s.fan_in AS callers\nORDER BY callers DESC LIMIT 20",
  },
  {
    label: "Callers of callers (2 hops)",
    query: "MATCH (a:Symbol)-[:CALLS*1..2]->(b:Symbol {name: 'run'})\nRETURN DISTINCT a.qname AS caller, a.file AS file LIMIT 50",
  },
  {
    label: "Files that change together",
    query: "MATCH (a:File)-[c:CO_CHANGES]->(b:File)\nRETURN a.path AS a, b.path AS b, c.count AS times, c.strength AS strength\nORDER BY strength DESC LIMIT 25",
  },
  {
    label: "Edge resolution mix",
    query: "MATCH ()-[c:CALLS]->()\nRETURN c.how AS how, count(*) AS edges, avg(c.confidence) AS confidence\nORDER BY edges DESC",
  },
  {
    label: "Untested public functions",
    query:
      "MATCH (s:Symbol {kind: 'function', is_test: false, exported: true})\nOPTIONAL MATCH (t:Symbol {is_test: true})-[:CALLS*1..3]->(s)\nWITH s, count(t) AS tests WHERE tests = 0\nRETURN s.qname AS name, s.file AS file, s.fan_in AS callers\nORDER BY callers DESC LIMIT 25",
  },
];

const NODES = ["Repo", "File", "Symbol", "External", "Person"];
const EDGES = ["CALLS", "INHERITS", "IMPLEMENTS", "OVERRIDES", "IMPORTS", "USES", "DEFINES", "CONTAINS", "CO_CHANGES", "AUTHORED"];

const KBD = "inline-grid h-5 min-w-5 place-items-center border border-line-loud px-1 font-mono text-[10px] text-ink-dim";

/** A graph value as one table cell. `∅` for null, so an empty cell cannot be mistaken for a blank string. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Labels({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="gt-label mb-2">{title}</div>
      <div className="flex flex-wrap gap-1">
        {items.map((x) => (
          <code key={x} className="border border-line bg-deep px-1.5 py-0.5 font-mono text-[10.5px] text-ink-dim">
            {x}
          </code>
        ))}
      </div>
    </div>
  );
}

export default function CypherPage() {
  const repo = useRepo();
  const mod = useModKey();
  const [query, setQuery] = useState(EXAMPLES[0].query);
  const run = useAction(api.cypher);
  const d = run.data;
  const cols = d?.rows.length ? Object.keys(d.rows[0]) : [];
  const csv = d ? [cols.join(","), ...d.rows.map((r) => cols.map((c) => JSON.stringify(cell(r[c]))).join(","))].join("\n") : "";

  const submit = () => {
    if (query.trim()) run.run(repo, query);
  };

  return (
    <Page>
      <Head
        no="09 · Cypher"
        title={
          <>
            The graph itself, <em>read-only.</em>
          </>
        }
        lead="Queries run as GRAPH.RO_QUERY with a timeout and a row cap, so nothing here can change or exhaust the database."
        meta={d ? [{ fig: num(d.count), label: d.count === 1 ? "row" : "rows" }] : undefined}
      >
        {d && <Receipts r={d.receipts} />}
      </Head>

      <Cols kind="aside-main">
        <Stack className="min-w-0">
          <Sheet no="A · Examples" title="Start from one" tone="library" flush>
            <ul className="pb-2">
              {EXAMPLES.map((e, i) => (
                <li key={e.label}>
                  <button
                    type="button"
                    className="gt-row w-full grid-cols-[28px_minmax(0,1fr)] text-left"
                    data-on={query === e.query || undefined}
                    data-hover-mark
                    aria-pressed={query === e.query}
                    onClick={() => setQuery(e.query)}
                  >
                    <span className="gt-row__no">{no2(i + 1)}</span>
                    <span className="gt-row__name text-[13px]">{e.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Sheet>
          <Sheet no="B · Schema" title="Labels" tone="fragment" bodyClassName="flex flex-col gap-4">
            <Labels title="Nodes" items={NODES} />
            <Labels title="Edges" items={EDGES} />
          </Sheet>
        </Stack>

        <Stack className="min-w-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Sheet no="00 · Query" title="Cypher" tone="commission">
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter, because a bare Enter has to stay a newline in a
                  // query that is routinely five lines long.
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={7}
                spellCheck={false}
                className="gt-field w-full resize-y font-mono text-[13px] leading-relaxed"
                aria-label="Cypher query"
              />
              <div className="mt-3 flex items-center gap-2">
                <span className="flex items-center gap-1 text-[11px] text-ink-faint">
                  <kbd className={KBD}>{mod}</kbd> <kbd className={KBD}>Enter</kbd> to run
                </span>
                <Button type="submit" className="ml-auto" disabled={!query.trim() || run.loading}>
                  <Terminal className="size-4" aria-hidden /> {run.loading ? "Running…" : "Run"}
                </Button>
              </div>
            </Sheet>
          </form>

          {run.error ? (
            <ErrorNote error={run.error} />
          ) : run.loading && !d ? (
            <Measuring label="Querying" />
          ) : d ? (
            <Sheet
              no="01 · Result"
              title={`${d.count} row${d.count === 1 ? "" : "s"}`}
              action={d.rows.length ? <CopyButton text={csv} label="Copy CSV" /> : null}
              tone="library"
              flush
            >
              {d.rows.length ? (
                <div className="gt-scroll max-h-[560px] overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead className="sticky top-0 z-10 bg-sheet-2 text-left">
                      <tr>
                        {cols.map((c) => (
                          <th key={c} className="border-b border-line-loud px-3 py-2 font-mono text-[10px] font-normal tracking-[.12em] text-ink-dim uppercase">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {d.rows.map((r, i) => (
                        <tr key={i} className="border-b border-line-soft last:border-0 hover:bg-void-lift">
                          {cols.map((c) => (
                            // The cell is truncated text, so the tooltip is the full value.
                            <td key={c} className="max-w-[420px] truncate px-3 py-1.5 text-ink" title={cell(r[c])}>
                              {cell(r[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-[clamp(14px,2vw,24px)] pb-5 text-[13px] text-ink-dim">
                  The query ran and matched nothing. That is an answer — check the labels in the schema sheet if you expected rows.
                </p>
              )}
            </Sheet>
          ) : (
            <Empty title="Run a query">Every answer elsewhere in the app is one or more of these queries; the receipts on each page show how many it took.</Empty>
          )}
        </Stack>
      </Cols>
    </Page>
  );
}
