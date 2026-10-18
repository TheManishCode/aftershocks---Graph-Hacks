"use client";

/**
 * Diff: the same analysis the CI gate posts on a pull request, run by hand.
 *
 * The two result panels sit side by side on purpose. "Which files moved" and
 * "which symbols actually changed" answer different questions — a 40-file
 * formatting commit has an enormous left panel and an empty right one, and that
 * contrast is the finding. Stacking them vertically would hide it below the fold.
 *
 * The change kinds use the pass/fail/warn colours, not the severity ramp: an
 * added symbol is not "low risk", it is a different category of edit. The ramp
 * stays reserved for the impact list underneath, where it means risk.
 */

import { useState } from "react";

import {
  Chip,
  Empty,
  ErrorNote,
  Eyebrow,
  Grid,
  Mono,
  Page,
  PageHeader,
  Panel,
  Range,
  Scroller,
  Spinner,
  Stack,
} from "@/components/ds";
import { GitDiff } from "@/components/icons";
import { ImpactView } from "@/components/impact-view";
import { CopyButton, FileLink, Receipts, SymLink } from "@/components/kit";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type SymbolChange } from "@/lib/api";
import { symName } from "@/lib/format";
import { useAction, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const CHANGE_TONE: Record<SymbolChange["change"], string> = {
  added: "text-pass bg-pass/10",
  body: "text-ink bg-accent",
  signature: "text-warn bg-warn/10",
  rename: "text-brand bg-brand/10",
  delete: "text-fail bg-fail/10",
};

/** A, M or D in the left gutter of the file list — the letters `git status` uses. */
function FileRow({ mark, tone, children }: { mark: string; tone: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2 px-2 py-0.5">
      <Mono className={cn("w-3 shrink-0", tone)} aria-hidden>
        {mark}
      </Mono>
      {children}
    </li>
  );
}

export default function DiffPage() {
  const repo = useRepo();
  const [rev, setRev] = useState("");
  const [depth, setDepth] = useState(4);
  const run = useAction(api.diff);
  const d = run.data;
  const files = d ? d.changes.files_changed.length + d.changes.files_added.length + d.changes.files_removed.length : 0;

  return (
    <Page>
      <PageHeader
        title="Diff"
        sub="Compare a revision — or your working tree — against the indexed graph: which symbols changed, how, and what that puts at risk."
      >
        {d && <Receipts r={d.receipts} />}
      </PageHeader>

      <Stack className="gap-[var(--section-gap)]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run.run(repo, { rev: rev.trim() || undefined, depth });
          }}
        >
          <Panel title="Change set" bodyClassName="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="min-w-0 flex-1">
              <Label htmlFor="rev" className="mb-1.5 block">
                <Eyebrow>Head revision — leave blank for the working tree</Eyebrow>
              </Label>
              <Input
                id="rev"
                value={rev}
                onChange={(e) => setRev(e.target.value)}
                placeholder="a PR branch or sha"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="mt-1.5 text-micro text-ink-faint">
                The indexed commit is the &ldquo;before&rdquo;; this is the &ldquo;after&rdquo;. The API host must have
                the checkout on disk.
              </p>
            </div>
            <Range label="Depth" value={depth} onChange={setDepth} format={(n) => `${n} hops`} className="pb-2" />
            <Button type="submit" disabled={run.loading}>
              <GitDiff className="size-4" aria-hidden /> {run.loading ? "Diffing…" : "Analyze"}
            </Button>
          </Panel>
        </form>

        {run.error ? (
          <ErrorNote error={run.error} />
        ) : run.loading && !d ? (
          <Spinner label="Parsing the revision" />
        ) : d ? (
          <Stack className={cn("gap-[var(--section-gap)]", run.loading && "opacity-60")}>
            <Grid cols="main-aside">
              <Panel
                title={`Symbol changes · ${d.changes.symbols.length}`}
                action={d.markdown ? <CopyButton text={d.markdown} label="Copy PR comment" /> : null}
                flush
              >
                {d.changes.symbols.length ? (
                  <Scroller className="max-h-80 p-2">
                    <ul className="space-y-0.5">
                      {d.changes.symbols.map((s) => (
                        <li key={`${s.id}:${s.change}`} className="flex items-start gap-2 px-2 py-1">
                          <Mono
                            className={cn(
                              "w-[68px] shrink-0 rounded-inner px-1.5 py-0.5 text-center text-micro",
                              CHANGE_TONE[s.change],
                            )}
                          >
                            {s.change}
                          </Mono>
                          <div className="min-w-0">
                            {/* An added symbol has no node in the graph yet, so there is
                                nothing to link to — it renders as plain text. */}
                            {s.change === "added" ? (
                              <Mono className="text-body-sm text-ink-strong">{symName(s.qname)}</Mono>
                            ) : (
                              <SymLink repo={repo} id={s.id} name={s.qname} className="text-body-sm" />
                            )}
                            <Mono className="ml-2 text-micro text-ink-faint">
                              {s.kind} · {s.file}:{s.line}
                            </Mono>
                            {s.renamed_to && <div className="font-mono text-micro text-brand">→ {s.renamed_to}</div>}
                            {s.old_signature && s.new_signature && (
                              <div className="mt-0.5 font-mono text-micro">
                                <div className="truncate text-fail/80">- {s.old_signature}</div>
                                <div className="truncate text-pass/80">+ {s.new_signature}</div>
                              </div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </Scroller>
                ) : (
                  <p className="p-4 text-body-sm text-ink-muted">
                    No symbol-level change — comments, formatting, or files in a language that is not parsed.
                  </p>
                )}
              </Panel>

              <Panel
                title={`Files · ${files}`}
                action={
                  <Mono className="text-micro text-ink-faint">
                    {d.changes.base.slice(0, 10)} → {d.changes.head}
                  </Mono>
                }
                flush
              >
                <Scroller className="max-h-80 p-2 text-caption">
                  <ul className="space-y-0.5">
                    {d.changes.files_added.map((f) => (
                      <FileRow key={f} mark="A" tone="text-pass">
                        <FileLink repo={repo} path={f} />
                      </FileRow>
                    ))}
                    {d.changes.files_changed.map((f) => (
                      <FileRow key={f} mark="M" tone="text-brand">
                        <FileLink repo={repo} path={f} />
                      </FileRow>
                    ))}
                    {d.changes.files_removed.map((f) => (
                      <FileRow key={f} mark="D" tone="text-fail">
                        {/* Deleted: no link, because there is nothing left to open. */}
                        <Mono className="truncate text-ink-faint line-through">{f}</Mono>
                      </FileRow>
                    ))}
                  </ul>
                </Scroller>
              </Panel>
            </Grid>

            {d.impact ? (
              <ImpactView
                repo={repo}
                data={d.impact}
                runHref={`${repoHref(repo, "/tests")}?${new URLSearchParams(rev.trim() ? { mode: "diff", rev: rev.trim() } : { mode: "diff" })}`}
              />
            ) : (
              <Empty title="Nothing existing was modified">
                Only additions: nothing in the graph depends on them yet.
              </Empty>
            )}
          </Stack>
        ) : (
          <Empty
            title="Analyze a change set"
            icon={<GitDiff className="size-6" aria-hidden />}
            action={<Chip tone="brand">CI posts this on pull requests</Chip>}
          >
            Leave the revision blank to check what is uncommitted right now, or name a branch or sha to see what a pull
            request would put at risk.
          </Empty>
        )}
      </Stack>
    </Page>
  );
}
