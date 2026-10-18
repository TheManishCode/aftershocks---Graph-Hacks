"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ArrowRight, Flow } from "@/components/icons";
import { ProblemList } from "@/components/impact-view";
import { Empty, ErrorNote, FileLink, Meter, Page, PageHeader, Receipts, Spinner, SymLink, Tile } from "@/components/kit";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, type EdgeStep } from "@/lib/api";
import { HOW, pct } from "@/lib/format";
import { useAction, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const VERB: Record<string, string> = { CALLS: "calls", INHERITS: "inherits from", IMPLEMENTS: "implements", OVERRIDES: "overrides", IMPORTS: "imports", COCHANGE: "co-changes with" };

function Step({ repo, s, i }: { repo: string; s: EdgeStep; i: number }) {
  return (
    <li className="relative pl-10">
      <span className="absolute top-0 left-0 grid size-7 place-items-center rounded-full border border-graphite bg-obsidian font-mono text-[11px] text-fog">{i + 1}</span>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <SymLink repo={repo} id={s.from.id} name={s.from.name} className="text-sm" />
        <span className="text-xs text-fog">{VERB[s.type] ?? s.type.toLowerCase()}</span>
        <SymLink repo={repo} id={s.to.id} name={s.to.name} className="text-sm" />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fog">
        <FileLink repo={repo} path={s.from.file} line={s.lines?.[0] ?? s.from.line} className="text-[11px]" />
        {s.how && <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono">{HOW[s.how] ?? s.how}</span>}
        {s.confidence !== undefined && (
          <span className="flex items-center gap-1.5">
            <Meter value={s.confidence} className="w-14" barClassName={s.confidence >= 0.85 ? "bg-pulse-green" : s.confidence >= 0.6 ? "bg-signal" : "bg-ov-missed"} />
            <span className="font-mono">{pct(s.confidence)}</span>
          </span>
        )}
        {s.verdict && <span className="text-ov-missed">{s.verdict}</span>}
      </div>
    </li>
  );
}

export default function PathPage() {
  const repo = useRepo();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [source, setSource] = useState<string[]>(() => (sp.get("from") ? [sp.get("from")!] : []));
  const [target, setTarget] = useState<string[]>(() => (sp.get("to") ? [sp.get("to")!] : []));
  const run = useAction(api.path);
  const d = run.data;

  const go = () => {
    if (!source[0] || !target[0]) return;
    router.replace(`${pathname}?${new URLSearchParams({ from: source[0], to: target[0] })}`, { scroll: false });
    run.run(repo, { source: source[0], target: target[0] });
  };
  useEffect(() => {
    if (source[0] && target[0]) go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  return (
    <Page>
      <PageHeader title="Path" sub="Why does one thing depend on another? The shortest, most confident chain of resolved edges, with the line that creates each one.">
        {d && <Receipts r={d.receipts} />}
      </PageHeader>
      <form
        className="mb-6 grid gap-3 rounded-xl border border-border bg-card/50 p-4 md:grid-cols-[1fr_auto_1fr_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div>
          <Label htmlFor="src" className="mb-1.5 text-xs text-fog">
            From
          </Label>
          <SymbolPicker id="src" repo={repo} value={source} onChange={setSource} multiple={false} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mb-1 self-end text-fog"
          onClick={() => {
            setSource(target);
            setTarget(source);
          }}
          aria-label="Swap"
          title="Swap"
        >
          <ArrowRight className="size-4" />
        </Button>
        <div>
          <Label htmlFor="dst" className="mb-1.5 text-xs text-fog">
            To
          </Label>
          <SymbolPicker id="dst" repo={repo} value={target} onChange={setTarget} multiple={false} />
        </div>
        <Button type="submit" disabled={!source[0] || !target[0] || run.loading}>
          <Flow className="size-4" /> {run.loading ? "Searching…" : "Explain"}
        </Button>
      </form>

      {run.error ? (
        <ErrorNote error={run.error} />
      ) : run.loading && !d ? (
        <Spinner label="Searching paths" />
      ) : d ? (
        <div className={cn("space-y-4", run.loading && "opacity-60")}>
          <ProblemList repo={repo} problems={d.problems} />
          {d.error && <ErrorNote error={d.error} />}
          {d.found && d.level === "file" && d.files ? (
            <Tile title="File-level link">
              <p className="mb-3 text-sm text-mist">{d.summary}</p>
              <ol className="flex flex-wrap items-center gap-2">
                {d.files.map((f, i) => (
                  <li key={f} className="flex items-center gap-2">
                    {i > 0 && <span className="text-xs text-fog">imports →</span>}
                    <FileLink repo={repo} path={f} className="rounded-md border border-graphite px-2 py-1 text-xs" />
                  </li>
                ))}
              </ol>
            </Tile>
          ) : d.found ? (
            <Tile title={`${d.hops} hop${d.hops === 1 ? "" : "s"} · ${d.direction ?? ""}`} action={d.confidence !== undefined ? <span className="font-mono text-xs text-mist">path confidence {pct(d.confidence)}</span> : null}>
              {d.summary && <p className="mb-5 text-sm text-mist">{d.summary}</p>}
              <ol className="relative space-y-5 before:absolute before:top-3 before:bottom-3 before:left-3.5 before:w-px before:bg-graphite">
                {d.steps.map((s, i) => (
                  <Step key={i} repo={repo} s={s} i={i} />
                ))}
              </ol>
            </Tile>
          ) : (
            !d.problems?.length && !d.error && <Empty title="No dependency path">{d.summary ?? "Nothing links these within the depth limit, in either direction."}</Empty>
          )}
        </div>
      ) : (
        <Empty title="Pick two ends" icon={<Flow className="size-6" />}>
          For example a test and the function it is supposed to cover, or an API handler and a database helper.
        </Empty>
      )}
    </Page>
  );
}
