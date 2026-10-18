"use client";

/**
 * Diff: the same analysis the CI gate posts on a pull request, run by hand.
 *
 * The two result sheets sit side by side on purpose. "Which files moved" and
 * "which symbols actually changed" answer different questions — a 40-file
 * formatting commit has an enormous right sheet and an empty left one, and that
 * contrast is the finding.
 *
 * The change kinds use the pass/fail/warn colours, not the severity ramp: an
 * added symbol is not "low risk", it is a different category of edit.
 */

import { useState } from "react";

import { Chip, Cols, Empty, ErrorNote, Head, Label, Measuring, Mono, Page, Range, Sheet, Stack, type Tone } from "@/components/gt";
import { GitDiff } from "@/components/icons";
import { ImpactView } from "@/components/impact-view";
import { CopyButton, FileLink, Receipts, SymLink } from "@/components/kit";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { api, type SymbolChange } from "@/lib/api";
import { num, symName } from "@/lib/format";
import { useAction, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const CHANGE_TONE: Record<SymbolChange["change"], Tone> = {
  added: "pass",
  body: "neutral",
  signature: "warn",
  rename: "info",
  delete: "fail",
};

/** A, M or D in the left gutter — the letters `git status` uses. */
function FileRow({ mark, tone, children }: { mark: string; tone: string; children: React.ReactNode }) {
  return (
    <li className="gt-row grid-cols-[20px_minmax(0,1fr)] text-[12.5px]">
      <Mono className={cn("font-medium", tone)} aria-hidden>
        {mark}
      </Mono>
      <span className="min-w-0 truncate">{children}</span>
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
      <Head
        no="03 · Diff"
        title={
          <>
            What does this change set <em>put at risk?</em>
          </>
        }
        lead="Compare a revision — or your working tree — against the indexed graph: which symbols changed, how, and what that puts at risk. The same report CI posts on a pull request."
        meta={
          d
            ? [
                { fig: num(d.changes.symbols.length), label: "symbol changes" },
                { fig: num(files), label: "files touched" },
                ...(d.impact ? [{ fig: String(d.impact.risk.score), label: `risk · ${d.impact.risk.level}` }] : []),
              ]
            : undefined
        }
      >
        {d && <Receipts r={d.receipts} />}
      </Head>

      <Stack>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run.run(repo, { rev: rev.trim() || undefined, depth });
          }}
        >
          <Sheet no="00 · Input" title="Change set" tone="commission">
            <div className="flex flex-col gap-4 md:flex-row md:items-end">
              <div className="min-w-0 flex-1">
                <Label htmlFor="rev">Head revision — blank for the working tree</Label>
                <input
                  id="rev"
                  value={rev}
                  onChange={(e) => setRev(e.target.value)}
                  placeholder="a PR branch or sha"
                  className="gt-field w-full font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <Range label="Depth" value={depth} onChange={setDepth} format={(n) => `${n} hops`} />
              <Button type="submit" disabled={run.loading}>
                <GitDiff className="size-4" aria-hidden /> {run.loading ? "Diffing…" : "Analyze"}
              </Button>
            </div>
            <p className="gt-note mt-3">
              The indexed commit is the &ldquo;before&rdquo;; this is the &ldquo;after&rdquo;. The API host must have the checkout on disk.
            </p>
          </Sheet>
        </form>

        {run.error ? (
          <ErrorNote error={run.error} />
        ) : run.loading && !d ? (
          <Measuring label="Parsing the revision" />
        ) : d ? (
          <Stack className={cn(run.loading && "opacity-60 transition-opacity")}>
            <Cols kind="main-aside">
              <Sheet
                no="01 · Symbols"
                title={`Symbol changes · ${d.changes.symbols.length}`}
                action={d.markdown ? <CopyButton text={d.markdown} label="Copy PR comment" /> : null}
                tone="library"
                flush
              >
                {d.changes.symbols.length ? (
                  <ul className="gt-scroll max-h-96 pb-2">
                    {d.changes.symbols.map((s) => (
                      <li key={`${s.id}:${s.change}`} className="gt-row grid-cols-[84px_minmax(0,1fr)] items-start">
                        <Chip tone={CHANGE_TONE[s.change]} className="justify-center">
                          {s.change}
                        </Chip>
                        <div className="min-w-0">
                          {/* An added symbol has no node in the graph yet, so there is nothing to link to. */}
                          {s.change === "added" ? (
                            <Mono className="text-[13px] text-ink">{symName(s.qname)}</Mono>
                          ) : (
                            <SymLink repo={repo} id={s.id} name={s.qname} className="text-[13px]" />
                          )}
                          <Mono className="ml-2 text-[11px] text-ink-faint">
                            {s.kind} · {s.file}:{s.line}
                          </Mono>
                          {s.renamed_to && <div className="font-mono text-[11px] text-info">→ {s.renamed_to}</div>}
                          {s.old_signature && s.new_signature && (
                            <div className="mt-1 font-mono text-[11px]">
                              <div className="truncate text-fail">- {s.old_signature}</div>
                              <div className="truncate text-pass">+ {s.new_signature}</div>
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-[clamp(14px,2vw,24px)] pb-5 text-[13px] text-ink-dim">
                    No symbol-level change — comments, formatting, or files in a language that is not parsed.
                  </p>
                )}
              </Sheet>

              <Sheet
                no="02 · Files"
                title={`Files · ${files}`}
                action={
                  <Mono className="text-[11px] text-ink-faint">
                    {d.changes.base.slice(0, 10)} → {d.changes.head}
                  </Mono>
                }
                tone="fragment"
                flush
              >
                <ul className="gt-scroll max-h-96 pb-2">
                  {d.changes.files_added.map((f) => (
                    <FileRow key={f} mark="A" tone="text-pass">
                      <FileLink repo={repo} path={f} />
                    </FileRow>
                  ))}
                  {d.changes.files_changed.map((f) => (
                    <FileRow key={f} mark="M" tone="text-mark">
                      <FileLink repo={repo} path={f} />
                    </FileRow>
                  ))}
                  {d.changes.files_removed.map((f) => (
                    <FileRow key={f} mark="D" tone="text-fail">
                      {/* Deleted: no link, because there is nothing left to open. */}
                      <Mono className="text-ink-faint line-through">{f}</Mono>
                    </FileRow>
                  ))}
                </ul>
              </Sheet>
            </Cols>

            {d.impact ? (
              <ImpactView
                repo={repo}
                data={d.impact}
                runHref={`${repoHref(repo, "/tests")}?${new URLSearchParams(rev.trim() ? { mode: "diff", rev: rev.trim() } : { mode: "diff" })}`}
              />
            ) : (
              <Empty title="Nothing existing was modified">Only additions: nothing in the graph depends on them yet.</Empty>
            )}
          </Stack>
        ) : (
          <Empty title="Analyze a change set" action={<Chip tone="mark">CI posts this on pull requests</Chip>}>
            Leave the revision blank to check what is uncommitted right now, or name a branch or sha to see what a pull request would put at risk.
          </Empty>
        )}
      </Stack>
    </Page>
  );
}
