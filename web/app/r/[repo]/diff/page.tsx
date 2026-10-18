"use client";

import { useState } from "react";

import { GitDiff } from "@/components/icons";
import { ImpactView } from "@/components/impact-view";
import { CopyButton, Empty, ErrorNote, FileLink, Page, PageHeader, Receipts, Spinner, SymLink, Tile } from "@/components/kit";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type SymbolChange } from "@/lib/api";
import { useAction, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { symName } from "@/lib/format";

const CHANGE_TONE: Record<SymbolChange["change"], string> = {
  added: "text-pulse-green bg-pulse-green/10",
  body: "text-mist bg-white/5",
  signature: "text-ov-missed bg-ov-missed/10",
  rename: "text-signal bg-signal/10",
  delete: "text-coral-red bg-coral-red/10",
};

export default function DiffPage() {
  const repo = useRepo();
  const [rev, setRev] = useState("");
  const [depth, setDepth] = useState(4);
  const run = useAction(api.diff);
  const d = run.data;

  return (
    <Page>
      <PageHeader
        title="Diff"
        sub="Compare a revision (or the working tree) with the indexed graph: which symbols changed, how, and what that puts at risk. The same analysis the CI gate posts on pull requests."
      >
        {d && <Receipts r={d.receipts} />}
      </PageHeader>

      <form
        className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-card/50 p-4 md:flex-row md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          run.run(repo, { rev: rev.trim() || undefined, depth });
        }}
      >
        <div className="flex-1">
          <Label htmlFor="rev" className="mb-1.5 text-xs text-fog">
            Head revision <span className="text-fog">(the &ldquo;after&rdquo;; the indexed commit is the &ldquo;before&rdquo;; blank = working tree)</span>
          </Label>
          <Input id="rev" value={rev} onChange={(e) => setRev(e.target.value)} placeholder="a PR branch or sha" className="font-mono text-sm" spellCheck={false} />
        </div>
        <label className="flex items-center gap-2 pb-2 text-xs text-fog">
          Depth
          <input type="range" min={1} max={6} value={depth} onChange={(e) => setDepth(Number(e.target.value))} className="w-24 accent-[var(--color-brand)]" />
          <span className="w-4 font-mono text-paper">{depth}</span>
        </label>
        <Button type="submit" disabled={run.loading}>
          <GitDiff className="size-4" /> {run.loading ? "Diffing…" : "Analyze"}
        </Button>
      </form>

      {run.error ? (
        <ErrorNote error={run.error} />
      ) : run.loading && !d ? (
        <Spinner label="Parsing the revision" />
      ) : d ? (
        <div className={cn("space-y-4", run.loading && "opacity-60")}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <Tile
              title={`Files · ${d.changes.files_changed.length + d.changes.files_added.length + d.changes.files_removed.length}`}
              action={<span className="font-mono text-[11px] text-fog">{d.changes.base.slice(0, 10)} → {d.changes.head}</span>}
              bodyClassName="max-h-80 overflow-y-auto p-2"
            >
              <ul className="space-y-0.5 text-xs">
                {d.changes.files_added.map((f) => (
                  <li key={f} className="flex gap-2 px-2 py-0.5">
                    <span className="w-3 font-mono text-pulse-green">A</span>
                    <FileLink repo={repo} path={f} />
                  </li>
                ))}
                {d.changes.files_changed.map((f) => (
                  <li key={f} className="flex gap-2 px-2 py-0.5">
                    <span className="w-3 font-mono text-signal">M</span>
                    <FileLink repo={repo} path={f} />
                  </li>
                ))}
                {d.changes.files_removed.map((f) => (
                  <li key={f} className="flex gap-2 px-2 py-0.5">
                    <span className="w-3 font-mono text-coral-red">D</span>
                    <span className="font-mono text-fog line-through">{f}</span>
                  </li>
                ))}
              </ul>
            </Tile>
            <Tile title={`Symbol changes · ${d.changes.symbols.length}`} action={d.markdown ? <CopyButton text={d.markdown} label="Copy PR comment" /> : null} bodyClassName="max-h-80 overflow-y-auto p-2">
              {d.changes.symbols.length ? (
                <ul className="space-y-0.5 text-xs">
                  {d.changes.symbols.map((s) => (
                    <li key={`${s.id}:${s.change}`} className="flex items-start gap-2 px-2 py-1">
                      <span className={cn("w-[70px] shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[10.5px]", CHANGE_TONE[s.change])}>{s.change}</span>
                      <div className="min-w-0">
                        {s.change === "added" ? <span className="font-mono text-paper">{symName(s.qname)}</span> : <SymLink repo={repo} id={s.id} name={s.qname} className="text-[12.5px]" />}
                        <span className="ml-2 font-mono text-[11px] text-fog">
                          {s.kind} · {s.file}:{s.line}
                        </span>
                        {s.renamed_to && <div className="font-mono text-[11px] text-signal">→ {s.renamed_to}</div>}
                        {s.old_signature && s.new_signature && (
                          <div className="mt-0.5 font-mono text-[11px]">
                            <div className="truncate text-coral-red/80">- {s.old_signature}</div>
                            <div className="truncate text-pulse-green/80">+ {s.new_signature}</div>
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-2 text-sm text-muted-foreground">No symbol-level change (comments, formatting, or unparsed files).</p>
              )}
            </Tile>
          </div>
          {d.impact ? <ImpactView repo={repo} data={d.impact} runHref={`${repoHref(repo, "/tests")}?${new URLSearchParams(rev.trim() ? { mode: "diff", rev: rev.trim() } : { mode: "diff" })}`} /> : <Empty title="Nothing existing was modified">Only additions: nothing in the graph depends on them yet.</Empty>}
        </div>
      ) : (
        <Empty title="Analyze a change set" icon={<GitDiff className="size-6" />}>
          The API host must have the checkout on disk. For pull requests, the GitHub Action runs this and comments the result.
        </Empty>
      )}
    </Page>
  );
}
