"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Zap } from "@/components/icons";
import { ImpactView } from "@/components/impact-view";
import { Empty, ErrorNote, Page, PageHeader, Spinner } from "@/components/kit";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, type Change } from "@/lib/api";
import { useAction, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const CHANGES: { key: Change; label: string; hint: string }[] = [
  { key: "body", label: "Body", hint: "behaviour changes, signature stays" },
  { key: "signature", label: "Signature", hint: "parameters or return type change" },
  { key: "rename", label: "Rename", hint: "every reference must follow" },
  { key: "delete", label: "Delete", hint: "every reference breaks" },
];

export default function ImpactPage() {
  const repo = useRepo();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [targets, setTargets] = useState<string[]>(() => [...sp.getAll("t"), ...sp.getAll("targets")]);
  const [change, setChange] = useState<Change>(() => (sp.get("change") as Change) || "signature");
  const [depth, setDepth] = useState(() => Number(sp.get("depth")) || 4);
  const run = useAction(api.impact);

  // the URL is the state: a link to /impact?t=…&change=… reproduces the analysis
  const go = (t = targets, c = change, d = depth) => {
    if (!t.length) return;
    const qs = new URLSearchParams();
    t.forEach((x) => qs.append("t", x));
    qs.set("change", c);
    qs.set("depth", String(d));
    router.replace(`${pathname}?${qs}`, { scroll: false });
    run.run(repo, { targets: t, change: c, depth: d });
  };

  useEffect(() => {
    if (targets.length) go();
    // run once for a shared link
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  return (
    <Page>
      <PageHeader title="Impact" sub="Pick what you are about to change. Aftershock walks callers, subclasses and co-change partners and ranks what is likely to break, with the chain that explains each one." />

      <form
        className="mb-6 rounded-xl border border-border bg-card/50 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <Label htmlFor="targets" className="mb-1.5 text-xs text-fog">
          Symbols or files
        </Label>
        <SymbolPicker id="targets" repo={repo} value={targets} onChange={setTargets} />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Kind of change">
            {CHANGES.map((c) => (
              <button
                key={c.key}
                type="button"
                role="radio"
                aria-checked={change === c.key}
                title={c.hint}
                onClick={() => setChange(c.key)}
                className={cn("rounded px-3 py-1 text-xs transition-colors", change === c.key ? "bg-white/10 text-paper" : "text-fog hover:text-mist")}
              >
                {c.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-fog">
            Depth
            <input
              type="range"
              min={1}
              max={6}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
              className="w-24 accent-[var(--color-gold)]"
              aria-valuetext={`${depth} hops`}
            />
            <span className="w-4 font-mono text-paper">{depth}</span>
          </label>
          <span className="hidden text-xs text-fog md:inline">{CHANGES.find((c) => c.key === change)?.hint}</span>
          <Button type="submit" className="ml-auto" disabled={!targets.length || run.loading}>
            <Zap className="size-4" /> {run.loading ? "Tracing…" : "Trace impact"}
          </Button>
        </div>
      </form>

      {run.error ? (
        <ErrorNote error={run.error} />
      ) : run.loading && !run.data ? (
        <Spinner label="Walking the graph" />
      ) : run.data ? (
        <div className={cn(run.loading && "opacity-60 transition-opacity")}>
          <ImpactView
            repo={repo}
            data={run.data}
            onPick={(ref, id) => {
              const t = targets.map((x) => (x === ref ? id : x));
              setTargets(t);
              go(t);
            }}
          />
        </div>
      ) : (
        <Empty title="Choose a change to trace" icon={<Zap className="size-6" />}>
          Search by name, paste a <code className="font-mono text-paper">path::Qualified.name</code>, or pick a file to trace every symbol in it.
        </Empty>
      )}
    </Page>
  );
}
