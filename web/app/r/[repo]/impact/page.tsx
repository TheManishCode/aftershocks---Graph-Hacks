"use client";

/**
 * Impact: "I am about to change this — what breaks?"
 *
 * Two decisions shape this page.
 *
 * 1. **The URL is the state.** Targets, kind of change and depth all live in the
 *    query string, so an analysis can be pasted into a pull request or a chat and
 *    reproduce exactly. That is also why a shared link runs itself on arrival.
 *
 * 2. **The kind of change is a first-class control, not an advanced option.**
 *    Renaming a function and editing its body put wildly different things at risk,
 *    and a tool that silently assumes one of them is wrong half the time. Each
 *    option says in plain words what it means for the callers.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  Empty,
  ErrorNote,
  Eyebrow,
  Page,
  PageHeader,
  Panel,
  Range,
  Segmented,
  Spinner,
  Stack,
} from "@/components/ds";
import { Zap } from "@/components/icons";
import { ImpactView } from "@/components/impact-view";
import { repoHref } from "@/components/shell/nav";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, type Change } from "@/lib/api";
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
    // Runs once per repository, to make a shared link self-executing. The other
    // inputs are deliberately absent: re-running on every slider tick would fire
    // a graph traversal per pixel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const hint = CHANGES.find((c) => c.value === change)?.hint;

  return (
    <Page>
      <PageHeader
        title="Impact"
        sub="Name what you are about to change. Aftershock walks callers, subclasses and co-change partners, then ranks what is likely to break — each one with the chain that explains it."
      />

      <Stack className="gap-[var(--section-gap)]">
        <form onSubmit={(e) => { e.preventDefault(); go(); }}>
          <Panel title="What are you changing?" bodyClassName="flex flex-col gap-3">
            <div>
              <Label htmlFor="targets" className="mb-1.5 block">
                <Eyebrow>Symbols or files</Eyebrow>
              </Label>
              <SymbolPicker id="targets" repo={repo} value={targets} onChange={setTargets} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <Segmented
                label="Kind of change"
                value={change}
                onChange={setChange}
                options={CHANGES.map(({ value, label, hint }) => ({ value, label, title: hint }))}
              />
              <Range label="Depth" value={depth} onChange={setDepth} format={(n) => `${n} hops`} />
              {/* The hint is the same text as the active option's tooltip, shown
                  outright where there is room: a tooltip nobody hovers is not an
                  explanation. */}
              <span className="hidden text-caption text-ink-faint md:inline">{hint}</span>
              <Button type="submit" className="ml-auto" disabled={!targets.length || run.loading}>
                <Zap className="size-4" aria-hidden /> {run.loading ? "Tracing…" : "Trace impact"}
              </Button>
            </div>
          </Panel>
        </form>

        {run.error ? (
          <ErrorNote error={run.error} />
        ) : run.loading && !run.data ? (
          <Spinner label="Walking the graph" />
        ) : run.data ? (
          // Dimmed, not replaced: a re-run with a new depth should let you compare
          // against what is already on screen rather than blanking it first.
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
          <Empty title="Choose a change to trace" icon={<Zap className="size-6" aria-hidden />}>
            Search by name, paste a <code className="font-mono text-ink-strong">path::Qualified.name</code>, or pick a
            file to trace every symbol in it.
          </Empty>
        )}
      </Stack>
    </Page>
  );
}
