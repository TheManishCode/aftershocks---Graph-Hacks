"use client";

/**
 * Cypher: the graph itself, read-only.
 *
 * This is the escape hatch — every other page is a question someone decided to
 * ask in advance, and this is the one for the question nobody anticipated. It
 * is therefore built to be *trusted*: the header states the safety properties
 * (RO_QUERY, a timeout and a row cap) outright, because an open query box over
 * a production graph is otherwise a reasonable thing to be afraid of.
 *
 * The example queries are the documentation. A schema reference nobody can run
 * teaches less than five queries that return rows on the reader's own repo, so
 * the node and edge labels sit directly under the examples that use them.
 */

import { useState } from "react";

import {
  Code,
  Empty,
  ErrorNote,
  Eyebrow,
  Grid,
  Kbd,
  Page,
  PageHeader,
  Panel,
  Scroller,
  Spinner,
  Stack,
} from "@/components/ds";
import { Database, Terminal } from "@/components/icons";
import { CopyButton, Receipts } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useAction, useModKey, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const EXAMPLES: { label: string; query: string }[] = [
  {
    label: "Most called functions",
    query:
      "MATCH (s:Symbol) WHERE s.kind IN ['function','method']\nRETURN s.qname AS name, s.file AS file, s.fan_in AS callers\nORDER BY callers DESC LIMIT 20",
  },
  {
    label: "Callers of callers (2 hops)",
    query:
      "MATCH (a:Symbol)-[:CALLS*1..2]->(b:Symbol {name: 'run'})\nRETURN DISTINCT a.qname AS caller, a.file AS file LIMIT 50",
  },
  {
    label: "Files that change together",
    query:
      "MATCH (a:File)-[c:CO_CHANGES]->(b:File)\nRETURN a.path AS a, b.path AS b, c.count AS times, c.strength AS strength\nORDER BY strength DESC LIMIT 25",
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
const EDGES = [
  "CALLS",
  "INHERITS",
  "IMPLEMENTS",
  "OVERRIDES",
  "IMPORTS",
  "USES",
  "DEFINES",
  "CONTAINS",
  "CO_CHANGES",
  "AUTHORED",
];

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
      <Eyebrow className="mb-1.5 block">{title}</Eyebrow>
      <div className="flex flex-wrap gap-1">
        {items.map((x) => (
          <Code key={x} className="text-[10.5px]">
            {x}
          </Code>
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
  const csv = d
    ? [cols.join(","), ...d.rows.map((r) => cols.map((c) => JSON.stringify(cell(r[c]))).join(","))].join("\n")
    : "";

  const submit = () => {
    if (query.trim()) run.run(repo, query);
  };

  return (
    <Page>
      <PageHeader
        title="Cypher"
        sub="The graph itself, read-only. Queries run as GRAPH.RO_QUERY with a timeout and a row cap, so nothing here can change or exhaust the database."
      >
        {d && <Receipts r={d.receipts} />}
      </PageHeader>

      <Grid cols="aside-main">
        <Stack className="gap-3">
          <Panel title="Examples" flush>
            <ul className="space-y-0.5 p-1.5">
              {EXAMPLES.map((e) => (
                <li key={e.label}>
                  <button
                    type="button"
                    className={cn(
                      "w-full rounded-inner px-2 py-1.5 text-left text-caption transition-colors hover:bg-accent",
                      query === e.query ? "text-ink-strong" : "text-ink-muted",
                    )}
                    aria-pressed={query === e.query}
                    onClick={() => setQuery(e.query)}
                  >
                    {e.label}
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Schema" bodyClassName="flex flex-col gap-3">
            <Labels title="Nodes" items={NODES} />
            <Labels title="Edges" items={EDGES} />
          </Panel>
        </Stack>

        <Stack className="min-w-0 gap-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Panel title="Query" flush bodyClassName="p-2">
              <Textarea
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
                className="resize-y border-0 bg-transparent font-mono text-code shadow-none focus-visible:ring-0"
                aria-label="Cypher query"
              />
              <div className="flex items-center gap-2 px-2 pt-1 pb-1">
                <span className="text-micro text-ink-faint">
                  <Kbd>{mod}</Kbd> <Kbd>Enter</Kbd> to run
                </span>
                <Button type="submit" size="sm" className="ml-auto" disabled={!query.trim() || run.loading}>
                  <Terminal className="size-4" aria-hidden /> {run.loading ? "Running…" : "Run"}
                </Button>
              </div>
            </Panel>
          </form>

          {run.error ? (
            <ErrorNote error={run.error} />
          ) : run.loading && !d ? (
            <Spinner label="Querying" />
          ) : d ? (
            <Panel
              title={`${d.count} row${d.count === 1 ? "" : "s"}`}
              action={d.rows.length ? <CopyButton text={csv} label="Copy CSV" /> : null}
              flush
            >
              {d.rows.length ? (
                <Scroller className="max-h-[560px] overflow-x-auto">
                  <table className="w-full text-caption">
                    <thead className="sticky top-0 z-10 bg-surface-raised text-left">
                      <tr>
                        {cols.map((c) => (
                          <th key={c} className="border-b border-line px-3 py-2 font-mono text-micro font-normal text-ink-muted">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {d.rows.map((r, i) => (
                        <tr key={i} className="border-b border-line/60 last:border-0 hover:bg-accent">
                          {cols.map((c) => (
                            // `title` is right here and nowhere else: the cell is
                            // truncated text, so the tooltip is the full value, not a
                            // second description of a control.
                            <td key={c} className="max-w-[420px] truncate px-3 py-1.5 text-ink" title={cell(r[c])}>
                              {cell(r[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Scroller>
              ) : (
                <p className="p-4 text-body-sm text-ink-muted">
                  The query ran and matched nothing. That is an answer — check the labels in the schema panel if you
                  expected rows.
                </p>
              )}
            </Panel>
          ) : (
            <Empty title="Run a query" icon={<Database className="size-6" aria-hidden />}>
              Every answer elsewhere in the app is one or more of these queries; the receipts on each page show how
              many it took.
            </Empty>
          )}
        </Stack>
      </Grid>
    </Page>
  );
}
