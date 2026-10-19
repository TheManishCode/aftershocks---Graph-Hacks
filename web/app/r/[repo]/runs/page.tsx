"use client";

/**
 * Runs: every recorded TestRun (D25), newest first.
 *
 * The Tests page starts runs and the Culprit page explains one; this is the
 * ledger in between, so an older run (or a heal's chain of re-runs) is one click
 * from its graph, verdict and fix loop instead of only the latest failure.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { Empty, ErrorNote, Head, Page, Seg, Sheet, Skeleton, Stack } from "@/components/gt";
import { ArrowRight, Play } from "@/components/icons";
import { RunList } from "@/components/run-list";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { api, type TestRunSummary } from "@/lib/api";
import { num, relTime } from "@/lib/format";
import { useQuery, useRepo } from "@/lib/hooks";

type Filter = "all" | "failing" | "passing" | "heal";

const failing = (r: TestRunSummary) => r.failed > 0 || ![0, 5].includes(r.exit_code);

const KEEP: Record<Filter, (r: TestRunSummary) => boolean> = {
  all: () => true,
  failing,
  passing: (r) => !failing(r),
  heal: (r) => r.trigger === "heal",
};

export default function RunsPage() {
  const repo = useRepo();
  const runs = useQuery(`runs:${repo}`, () => api.runs(repo, 50));
  const [filter, setFilter] = useState<Filter>("all");
  const all = useMemo(() => runs.data?.runs ?? [], [runs.data]);
  const shown = all.filter(KEEP[filter]);
  const bad = all.filter(failing).length;
  const latest = all[0];

  return (
    <Page>
      <Head
        no="06 · Runs"
        title={
          <>
            Every test run, <em>open any one.</em>
          </>
        }
        lead="Runs from the Tests page, the CLI and the fix loop are recorded in the graph with their results and ranked culprits. Open a run to see what ran, what it reached, the most likely culprit, and to try a fix."
        meta={all.length ? [{ fig: num(all.length), label: "runs" }, { fig: num(bad), label: "failing" }, { fig: num(all.length - bad), label: "passing" }] : undefined}
      >
        {latest && (
          <Button asChild size="sm" variant="outline">
            <Link href={repoHref(repo, `/culprit?run=${latest.id}`)}>
              Latest run · {relTime(latest.started)} <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </Button>
        )}
      </Head>

      {runs.error ? (
        <ErrorNote error={runs.error} onRetry={runs.reload} />
      ) : runs.loading && !runs.data ? (
        <Stack className="gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </Stack>
      ) : !all.length ? (
        <Empty
          title="No runs recorded yet"
          action={
            <Button asChild size="sm">
              <Link href={repoHref(repo, "/tests")}>
                <Play className="size-3.5" aria-hidden /> Run tests
              </Link>
            </Button>
          }
        >
          Every run from the Tests page, the CLI or a heal is kept here, newest first.
        </Empty>
      ) : (
        <Sheet
          no="01 · Ledger"
          title={`${num(shown.length)} of ${num(all.length)} runs`}
          tone="library"
          flush
          action={
            <Seg
              size="sm"
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "failing", label: "Failing" },
                { value: "passing", label: "Passing" },
                { value: "heal", label: "Fix loop" },
              ]}
            />
          }
        >
          {shown.length ? (
            <RunList repo={repo} runs={shown} />
          ) : (
            <p className="px-4 py-3 text-[13px] text-ink-dim">No {filter === "heal" ? "fix-loop" : filter} runs among the latest {num(all.length)}.</p>
          )}
        </Sheet>
      )}
    </Page>
  );
}
