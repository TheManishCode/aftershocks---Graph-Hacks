"use client";

import { useState } from "react";

import { Database, Terminal } from "@/components/icons";
import { CopyButton, Empty, ErrorNote, Kbd, Page, PageHeader, Receipts, Spinner, Tile } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useAction, useModKey, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

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

function cell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function CypherPage() {
  const repo = useRepo();
  const mod = useModKey();
  const [query, setQuery] = useState(EXAMPLES[0].query);
  const run = useAction(api.cypher);
  const d = run.data;
  const cols = d?.rows.length ? Object.keys(d.rows[0]) : [];
  const csv = d ? [cols.join(","), ...d.rows.map((r) => cols.map((c) => JSON.stringify(cell(r[c]))).join(","))].join("\n") : "";

  return (
    <Page>
      <PageHeader
        title="Cypher"
        sub="The graph itself, read-only. Queries run as GRAPH.RO_QUERY with a timeout and a row cap, so nothing here can change or exhaust the database."
      >
        {d && <Receipts r={d.receipts} />}
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <Tile title="Examples" bodyClassName="p-1.5">
          <ul className="space-y-0.5">
            {EXAMPLES.map((e) => (
              <li key={e.label}>
                <button
                  type="button"
                  className={cn("w-full rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.04]", query === e.query ? "text-paper" : "text-fog")}
                  onClick={() => setQuery(e.query)}
                >
                  {e.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-border/70 px-2 pt-3 text-[11px] leading-relaxed text-fog">
            Nodes:{" "}
            {["Repo", "File", "Symbol", "External", "Person"].map((x, i) => (
              <span key={x}>
                {i > 0 && ", "}
                <code className="text-mist">{x}</code>
              </span>
            ))}
            . Edges:{" "}
            {["CALLS", "INHERITS", "IMPLEMENTS", "OVERRIDES", "IMPORTS", "USES", "DEFINES", "CONTAINS", "CO_CHANGES", "AUTHORED"].map((x, i) => (
              <span key={x}>
                {i > 0 && ", "}
                <code className="text-mist">{x}</code>
              </span>
            ))}
            .
          </div>
        </Tile>

        <div className="min-w-0 space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) run.run(repo, query);
            }}
            className="rounded-xl border border-border bg-card/50 p-2"
          >
            <Textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (query.trim()) run.run(repo, query);
                }
              }}
              rows={7}
              spellCheck={false}
              className="border-0 bg-transparent font-mono text-[13px] shadow-none focus-visible:ring-0"
              aria-label="Cypher query"
            />
            <div className="flex items-center gap-2 px-2 pb-1">
              <span className="text-[11px] text-fog">
                <Kbd>{mod}</Kbd> <Kbd>Enter</Kbd> to run
              </span>
              <Button type="submit" size="sm" className="ml-auto" disabled={!query.trim() || run.loading}>
                <Terminal className="size-4" /> {run.loading ? "Running…" : "Run"}
              </Button>
            </div>
          </form>

          {run.error ? (
            <ErrorNote error={run.error} />
          ) : run.loading && !d ? (
            <Spinner label="Querying" />
          ) : d ? (
            <Tile title={`${d.count} row${d.count === 1 ? "" : "s"}`} action={d.rows.length ? <CopyButton text={csv} label="Copy CSV" /> : null} bodyClassName="p-0">
              {d.rows.length ? (
                <div className="max-h-[560px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-carbon text-left text-[11px] text-fog">
                      <tr>
                        {cols.map((c) => (
                          <th key={c} className="border-b border-border/70 px-3 py-2 font-normal">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {d.rows.map((r, i) => (
                        <tr key={i} className="border-b border-border/40 last:border-0 hover:bg-white/[0.02]">
                          {cols.map((c) => (
                            <td key={c} className="max-w-[420px] truncate px-3 py-1.5 text-mist" title={cell(r[c])}>
                              {cell(r[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="p-4 text-sm text-muted-foreground">No rows.</p>
              )}
            </Tile>
          ) : (
            <Empty title="Run a query" icon={<Database className="size-6" />}>
              Every answer elsewhere in the app is one or more of these queries; the receipts show how many.
            </Empty>
          )}
        </div>
      </div>
    </Page>
  );
}
