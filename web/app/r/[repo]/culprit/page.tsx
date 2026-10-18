"use client";

import { useState } from "react";

import { Bug, ChevronDown, ChevronRight } from "@/components/icons";
import { ProblemList } from "@/components/impact-view";
import { Empty, ErrorNote, Meter, Page, PageHeader, Receipts, Spinner, SymLink, Tile } from "@/components/kit";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, type Suspect } from "@/lib/api";
import { HOW, pct, splitId } from "@/lib/format";
import { useAction, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

function SuspectRow({ repo, s, rank, open, onToggle }: { repo: string; s: Suspect; rank: number; open: boolean; onToggle: () => void }) {
  return (
    <li className={cn("rounded-lg border border-transparent", open && "border-graphite bg-white/[0.02]")}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/[0.03]" aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5 shrink-0 text-fog" /> : <ChevronRight className="size-3.5 shrink-0 text-fog" />}
        <span className="w-6 shrink-0 font-mono text-xs text-fog">#{rank}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-paper">{s.name}</span>
        {s.changed && <span className="shrink-0 rounded bg-gold/15 px-1.5 py-0.5 text-[10.5px] text-gold">changed</span>}
        <span className="hidden shrink-0 font-mono text-[11px] text-fog md:inline">
          {s.failed}✗ {s.passed}✓
        </span>
        <span className="w-24 shrink-0">
          <span className="block text-right font-mono text-[11px] text-mist">{s.score.toFixed(3)}</span>
          <Meter value={s.score} barClassName={s.changed ? "bg-gold" : "bg-coral-red/80"} />
        </span>
      </button>
      {open && (
        <div className="space-y-3 px-9 pt-1 pb-3 text-xs">
          <div className="font-mono text-[11px] text-fog">
            <SymLink repo={repo} id={s.id} name={`${s.file}:${s.line}`} className="text-[11px] text-fog" />
          </div>
          <div>
            <div className="mb-1 text-[11px] text-fog">Reached from {s.failing_tests.length} failing test{s.failing_tests.length === 1 ? "" : "s"}</div>
            <ul className="space-y-0.5">
              {s.failing_tests.slice(0, 8).map((t) => (
                <li key={t}>
                  <SymLink repo={repo} id={t} className="text-[12px] text-coral-red/90" />
                </li>
              ))}
            </ul>
          </div>
          {s.path.length > 0 && (
            <ol className="space-y-1 border-l border-graphite pl-3">
              {s.path.map((p, i) => (
                <li key={i}>
                  <SymLink repo={repo} id={p.from} name={splitId(p.from)[1]} className="text-[12px] text-mist" />{" "}
                  <span className="text-fog">{p.type === "CALLS" ? "calls" : p.type.toLowerCase()}</span>{" "}
                  <SymLink repo={repo} id={p.to} name={splitId(p.to)[1]} className="text-[12px]" />
                  <span className="ml-2 font-mono text-[10.5px] text-fog">
                    {p.how ? (HOW[p.how] ?? p.how) : ""}
                    {p.confidence !== undefined ? ` · ${pct(p.confidence)}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}

export default function CulpritPage() {
  const repo = useRepo();
  const [failing, setFailing] = useState<string[]>([]);
  const [changed, setChanged] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const run = useAction(api.culprit);
  const d = run.data;

  return (
    <Page>
      <PageHeader
        title="Culprit"
        sub="Tests are failing. Rank the code they reach by spectrum-based fault localization (Ochiai): symbols many failing tests reach and few passing tests reach rise to the top; symbols you changed get a boost."
      >
        {d && <Receipts r={d.receipts} />}
      </PageHeader>
      <form
        className="mb-6 space-y-3 rounded-xl border border-border bg-card/50 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (failing.length) run.run(repo, { failing, changed: changed.length ? changed : undefined });
        }}
      >
        <div>
          <Label htmlFor="failing" className="mb-1.5 text-xs text-fog">
            Failing tests <span className="text-ash">(test functions, or a test file for all of its tests)</span>
          </Label>
          <SymbolPicker id="failing" repo={repo} value={failing} onChange={setFailing} placeholder="test_checkout_applies_coupon, tests/test_cart.py…" />
        </div>
        <div>
          <Label htmlFor="changed" className="mb-1.5 text-xs text-fog">
            Recently changed <span className="text-ash">(optional)</span>
          </Label>
          <SymbolPicker id="changed" repo={repo} value={changed} onChange={setChanged} placeholder="What changed since the tests last passed?" />
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={!failing.length || run.loading}>
            <Bug className="size-4" /> {run.loading ? "Ranking…" : "Find suspects"}
          </Button>
        </div>
      </form>

      {run.error ? (
        <ErrorNote error={run.error} />
      ) : run.loading && !d ? (
        <Spinner label="Ranking suspects" />
      ) : d ? (
        <div className={cn("space-y-4", run.loading && "opacity-60")}>
          <ProblemList repo={repo} problems={d.problems} />
          <Tile title={`Suspects · ${d.suspects.length}`} action={<span className="font-mono text-[11px] text-fog">{d.method}</span>} bodyClassName="p-2">
            {d.suspects.length ? (
              <ul className="space-y-0.5">
                {d.suspects.map((s, i) => (
                  <SuspectRow key={s.id} repo={repo} s={s} rank={i + 1} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
                ))}
              </ul>
            ) : (
              <p className="p-3 text-sm text-muted-foreground">
                No suspects: the failing tests reach no resolved code. Their calls may go through fixtures, dynamic dispatch or names the resolver could not bind.
              </p>
            )}
          </Tile>
          {d.unexplained?.length ? (
            <p className="text-xs text-fog">
              These failing tests reach none of the changed symbols, so the change may not explain them:{" "}
              {d.unexplained.map((u) => splitId(u)[1] || u).join(", ")}.
            </p>
          ) : null}
          <p className="text-xs text-fog">
            {d.failing.length} failing test{d.failing.length === 1 ? "" : "s"}. Every other test that reaches a suspect counts as passing. {d.method}.
          </p>
        </div>
      ) : (
        <Empty title="Paste the failing tests" icon={<Bug className="size-6" />}>
          Static reachability stands in for coverage, so no instrumented test run is needed.
        </Empty>
      )}
    </Page>
  );
}
