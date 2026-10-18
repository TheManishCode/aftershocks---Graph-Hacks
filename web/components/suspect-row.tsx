"use client";

/**
 * One ranked culprit suspect.
 *
 * The collapsed row is the ranking; the expansion is the evidence. That split
 * is deliberate — a fault-localisation score is a statistic, and a statistic a
 * reader cannot audit is worth very little. Opening a row shows which failing
 * tests reach the symbol and the call chain that gets there.
 *
 * `changed` wins the score bar's colour. A symbol that the diff touched *and*
 * that failing tests reach is a different kind of claim from a high Ochiai
 * score alone, so it is marked in the brand colour rather than the risk ramp.
 */

import { Chip, Meter, Mono } from "@/components/ds";
import { ChevronDown, ChevronRight } from "@/components/icons";
import { SymLink } from "@/components/kit";
import type { Suspect } from "@/lib/api";
import { HOW, pct, splitId } from "@/lib/format";
import { cn } from "@/lib/utils";

export function SuspectRow({
  repo,
  s,
  rank,
  open,
  onToggle,
}: {
  repo: string;
  s: Suspect;
  rank: number;
  open: boolean;
  onToggle: () => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className={cn("rounded-panel border border-transparent", open && "border-line bg-surface-raised")}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-panel px-2 py-2 text-left hover:bg-accent"
        aria-expanded={open}
      >
        <Chevron className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        <Mono className="w-6 shrink-0 text-caption text-ink-faint">#{rank}</Mono>
        <span className="min-w-0 flex-1 truncate font-mono text-body-sm text-ink-strong">{s.name}</span>
        {s.changed && (
          <Chip tone="brand" size="sm">
            changed
          </Chip>
        )}
        {/* Counts, not a tooltip: the ✗/✓ glyphs carry the meaning on screen and
            the sr-only text carries it aloud, so nothing depends on hovering. */}
        <Mono className="shrink-0 text-micro text-ink-muted">
          <span aria-hidden>
            {s.failed}✗ {s.passed}✓
          </span>
          <span className="sr-only">
            {s.failed} failing and {s.passed} passing tests reach it
          </span>
        </Mono>
        <span className="w-16 shrink-0 sm:w-24">
          <Mono className="block text-right text-micro text-ink">{s.score.toFixed(3)}</Mono>
          <Meter
            value={s.score}
            barClassName={s.changed ? "bg-brand" : "bg-sev-critical/80"}
            label={`Suspiciousness ${s.score.toFixed(3)} of 1`}
          />
        </span>
      </button>

      {open && (
        <div className="space-y-3 px-9 pt-1 pb-3">
          <SymLink repo={repo} id={s.id} name={`${s.file}:${s.line}`} className="text-micro text-ink-muted" />

          {s.why && (
            <p className="text-caption leading-relaxed text-ink">
              {/* Measured coverage and a static traversal are not the same evidence,
                  and the reader has to be able to tell which one produced this. */}
              <Chip tone={s.basis === "coverage" ? "info" : "neutral"} size="sm" className="mr-1.5 align-[1px]">
                {s.basis === "coverage" ? "measured" : "static"}
              </Chip>
              {s.why}
            </p>
          )}

          <div>
            <div className="mb-1 text-micro text-ink-muted">
              Reached from {s.failing_tests.length} failing test{s.failing_tests.length === 1 ? "" : "s"}
            </div>
            <ul className="space-y-0.5">
              {s.failing_tests.slice(0, 8).map((t) => (
                <li key={t}>
                  <SymLink repo={repo} id={t} className="text-caption text-fail/90" />
                </li>
              ))}
            </ul>
            {s.failing_tests.length > 8 && (
              // Say what was cut. A list that silently stops at eight reads as
              // the whole truth.
              <p className="mt-1 text-micro text-ink-faint">
                and {s.failing_tests.length - 8} more
              </p>
            )}
          </div>

          {s.path.length > 0 && (
            <ol className="space-y-1 border-l border-line pl-3">
              {s.path.map((p, i) => (
                <li key={`${p.from}->${p.to}:${i}`} className="text-caption">
                  <SymLink repo={repo} id={p.from} name={splitId(p.from)[1]} className="text-caption text-ink" />{" "}
                  <span className="text-ink-muted">{p.type === "CALLS" ? "calls" : p.type.toLowerCase()}</span>{" "}
                  <SymLink repo={repo} id={p.to} name={splitId(p.to)[1]} className="text-caption" />
                  <Mono className="ml-2 text-micro text-ink-faint">
                    {p.how ? (HOW[p.how] ?? p.how) : ""}
                    {p.confidence !== undefined ? ` · ${pct(p.confidence)}` : ""}
                  </Mono>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}
