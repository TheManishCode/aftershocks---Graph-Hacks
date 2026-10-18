"use client";

/**
 * Path: why does one thing depend on another?
 *
 * The answer is a chain, so it renders as a numbered timeline rather than a
 * table — each row is a hop, and the rail down the left is the claim that these
 * steps are one continuous argument. Every step carries the file and line that
 * creates the edge, how it was resolved, and how sure the resolver was, because
 * a dependency chain with no provenance is just an assertion.
 *
 * Confidence uses the pass/warn/fail colours rather than the severity ramp:
 * a low-confidence edge is a weak claim, not a dangerous one.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  Chip,
  Empty,
  ErrorNote,
  Eyebrow,
  Meter,
  Mono,
  Page,
  PageHeader,
  Panel,
  Spinner,
  Stack,
} from "@/components/ds";
import { ArrowRight, Flow } from "@/components/icons";
import { ProblemList } from "@/components/impact-view";
import { FileLink, Receipts, SymLink } from "@/components/kit";
import { SymbolPicker } from "@/components/symbol-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api, type EdgeStep } from "@/lib/api";
import { HOW, pct } from "@/lib/format";
import { useAction, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/** Edge types read as English in the middle of a sentence, not as SCREAMING_CASE. */
const VERB: Record<string, string> = {
  CALLS: "calls",
  INHERITS: "inherits from",
  IMPLEMENTS: "implements",
  OVERRIDES: "overrides",
  IMPORTS: "imports",
  COCHANGE: "co-changes with",
};

const confTone = (c: number) => (c >= 0.85 ? "bg-pass" : c >= 0.6 ? "bg-warn" : "bg-fail");

function Step({ repo, s, i }: { repo: string; s: EdgeStep; i: number }) {
  return (
    <li className="relative pl-10">
      <Mono
        className="absolute top-0 left-0 grid size-7 place-items-center rounded-full border border-line bg-surface text-micro text-ink-muted"
        aria-hidden
      >
        {i + 1}
      </Mono>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <SymLink repo={repo} id={s.from.id} name={s.from.name} className="text-body-sm" />
        <span className="text-caption text-ink-muted">{VERB[s.type] ?? s.type.toLowerCase()}</span>
        <SymLink repo={repo} id={s.to.id} name={s.to.name} className="text-body-sm" />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-muted">
        <FileLink repo={repo} path={s.from.file} line={s.lines?.[0] ?? s.from.line} className="text-micro" />
        {s.how && <Mono className="rounded-full bg-accent px-1.5 py-0.5">{HOW[s.how] ?? s.how}</Mono>}
        {s.confidence !== undefined && (
          <span className="flex items-center gap-1.5">
            <Meter
              value={s.confidence}
              className="w-14"
              barClassName={confTone(s.confidence)}
              label={`Resolution confidence ${pct(s.confidence)}`}
            />
            <Mono>{pct(s.confidence)}</Mono>
          </span>
        )}
        {s.verdict && <span className="text-warn">{s.verdict}</span>}
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

  // The URL is the state, so a path can be pasted into a review and reproduce itself.
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
      <PageHeader
        title="Path"
        sub="The shortest, most confident chain of resolved edges between two symbols — with the line of code that creates each hop."
      >
        {d && <Receipts r={d.receipts} />}
      </PageHeader>

      <Stack className="gap-[var(--section-gap)]">
        <form onSubmit={(e) => { e.preventDefault(); go(); }}>
          <Panel title="Two ends" bodyClassName="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto] md:items-end">
            <div className="min-w-0">
              <Label htmlFor="src" className="mb-1.5 block">
                <Eyebrow>From</Eyebrow>
              </Label>
              <SymbolPicker id="src" repo={repo} value={source} onChange={setSource} multiple={false} />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mb-0.5 size-8 self-end p-0 text-ink-muted"
              onClick={() => {
                setSource(target);
                setTarget(source);
              }}
              // Direction matters to the answer, so swapping is a real analysis, not a
              // cosmetic flip. No title: the aria-label already names the control.
              aria-label="Swap the two ends and search the other direction"
            >
              <ArrowRight className="size-4" aria-hidden />
            </Button>
            <div className="min-w-0">
              <Label htmlFor="dst" className="mb-1.5 block">
                <Eyebrow>To</Eyebrow>
              </Label>
              <SymbolPicker id="dst" repo={repo} value={target} onChange={setTarget} multiple={false} />
            </div>
            <Button type="submit" disabled={!source[0] || !target[0] || run.loading}>
              <Flow className="size-4" aria-hidden /> {run.loading ? "Searching…" : "Explain"}
            </Button>
          </Panel>
        </form>

        {run.error ? (
          <ErrorNote error={run.error} />
        ) : run.loading && !d ? (
          <Spinner label="Searching paths" />
        ) : d ? (
          <Stack className={cn("gap-[var(--section-gap)]", run.loading && "opacity-60")}>
            <ProblemList repo={repo} problems={d.problems} />
            {d.error && <ErrorNote error={d.error} />}

            {d.found && d.level === "file" && d.files ? (
              // The resolver fell back to imports. Saying so matters: a file-level link
              // does not prove any symbol here reaches any symbol there.
              <Panel title="File-level link" note="No symbol-level chain was found; these files import one another.">
                {d.summary && <p className="mb-3 text-body-sm text-ink">{d.summary}</p>}
                <ol className="flex flex-wrap items-center gap-2">
                  {d.files.map((f, i) => (
                    <li key={f} className="flex items-center gap-2">
                      {i > 0 && <span className="text-caption text-ink-faint">imports →</span>}
                      <FileLink
                        repo={repo}
                        path={f}
                        className="rounded-control border border-line px-2 py-1 text-caption"
                      />
                    </li>
                  ))}
                </ol>
              </Panel>
            ) : d.found ? (
              <Panel
                title={`${d.hops} hop${d.hops === 1 ? "" : "s"}`}
                action={
                  <div className="flex items-center gap-2">
                    {d.direction && <Chip>{d.direction}</Chip>}
                    {d.confidence !== undefined && (
                      <Chip tone={d.confidence >= 0.85 ? "pass" : d.confidence >= 0.6 ? "warn" : "fail"}>
                        path confidence {pct(d.confidence)}
                      </Chip>
                    )}
                  </div>
                }
              >
                {d.summary && <p className="mb-5 text-body-sm text-ink">{d.summary}</p>}
                <ol className="relative space-y-5 before:absolute before:top-3 before:bottom-3 before:left-3.5 before:w-px before:bg-line">
                  {d.steps.map((s, i) => (
                    <Step key={`${s.from.id}->${s.to.id}:${i}`} repo={repo} s={s} i={i} />
                  ))}
                </ol>
              </Panel>
            ) : (
              !d.problems?.length &&
              !d.error && (
                <Empty title="No dependency path">
                  {d.summary ?? "Nothing links these within the depth limit, in either direction."}
                </Empty>
              )
            )}
          </Stack>
        ) : (
          <Empty title="Pick two ends" icon={<Flow className="size-6" aria-hidden />}>
            For example a test and the function it is supposed to cover, or an API handler and the database helper you
            suspect it reaches.
          </Empty>
        )}
      </Stack>
    </Page>
  );
}
