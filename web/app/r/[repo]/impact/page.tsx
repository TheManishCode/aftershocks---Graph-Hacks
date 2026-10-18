"use client";

/**
 * Impact: "I am about to change this — what breaks?"
 *
 * 1. **The URL is the state.** Targets, kind of change and depth live in the
 *    query string, so an analysis pasted into a PR reproduces exactly — and a
 *    shared link runs itself on arrival.
 * 2. **The kind of change is a first-class control.** Renaming a function and
 *    editing its body put different things at risk; each option says in plain
 *    words what it means for the callers.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Empty, ErrorNote, Head, Label, Measuring, Page, Range, Seg, Sheet, Stack } from "@/components/gt";
import { Zap } from "@/components/icons";
import { ImpactView } from "@/components/impact-view";
import { repoHref } from "@/components/shell/nav";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { api, type Change } from "@/lib/api";
import { num } from "@/lib/format";
import { useAction, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const CHANGES: { value: Change; label: string; hint: string }[] = [
  { value: "body", label: "Body", hint: "behaviour changes, the signature stays" },
  { value: "signature", label: "Signature", hint: "parameters or return type change" },
  { value: "rename", label: "Rename", hint: "every reference must follow" },
  { value: "delete", label: "Delete", hint: "every reference breaks" },
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
    // Once per repository, so a shared link runs itself. The other inputs are
    // absent on purpose: a re-run per slider tick would be a traversal per pixel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const hint = CHANGES.find((c) => c.value === change)?.hint;
  const d = run.data && !run.data.error ? run.data : null;

  return (
    <Page>
      <Head
        no="02 · Impact"
        title={
          <>
            What breaks <em>if I change this?</em>
          </>
        }
        lead="Name what you are about to change. Aftershock walks callers, subclasses and co-change partners, then ranks what is likely to break — each with the chain that explains it."
        meta={
          d
            ? [
                { fig: String(d.risk.score), label: `risk · ${d.risk.level}` },
                { fig: num(d.impacted.filter((x) => !x.is_test).length), label: "impacted symbols" },
                { fig: num(d.tests.length), label: "tests to run" },
              ]
            : undefined
        }
      />

      <Stack>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <Sheet no="00 · Input" title="What are you changing?" tone="commission">
            <Label htmlFor="targets">Symbols or files</Label>
            <SymbolPicker id="targets" repo={repo} value={targets} onChange={setTargets} />
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Seg label="Kind of change" value={change} onChange={setChange} options={CHANGES.map(({ value, label, hint }) => ({ value, label, title: hint }))} />
              <Range label="Depth" value={depth} onChange={setDepth} format={(n) => `${n} hops`} />
              {/* The active option's tooltip, shown outright: a tooltip nobody hovers explains nothing. */}
              <span className="hidden text-[12.5px] text-ink-faint md:inline">{hint}</span>
              <Button type="submit" className="ml-auto" disabled={!targets.length || run.loading}>
                <Zap className="size-4" aria-hidden /> {run.loading ? "Tracing…" : "Trace impact"}
              </Button>
            </div>
          </Sheet>
        </form>

        {run.error ? (
          <ErrorNote error={run.error} />
        ) : run.loading && !run.data ? (
          <Measuring label="Walking the graph" />
        ) : run.data ? (
          // Dimmed, not replaced: a re-run at a new depth compares against what is on screen.
          <div className={cn(run.loading && "opacity-60 transition-opacity")}>
            <ImpactView
              repo={repo}
              data={run.data}
              runHref={`${repoHref(repo, "/tests")}?${new URLSearchParams([["mode", "targets"], ...targets.map((t) => ["t", t])])}`}
              onPick={(ref, id) => {
                const t = targets.map((x) => (x === ref ? id : x));
                setTargets(t);
                go(t);
              }}
            />
          </div>
        ) : (
          <Empty title="Choose a change to trace">
            Search by name, paste a <code className="font-mono text-ink">path::Qualified.name</code>, or pick a file to trace every symbol in it.
          </Empty>
        )}
      </Stack>
    </Page>
  );
}
