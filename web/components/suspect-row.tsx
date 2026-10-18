"use client";

/**
 * One ranked culprit suspect, as a ledger row.
 *
 * The collapsed row is the ranking; the expansion is the evidence. A
 * fault-localisation score is a statistic, and a statistic a reader cannot
 * audit is worth very little — opening a row shows which failing tests reach
 * the symbol and the call chain that gets there.
 *
 * `changed` takes the instrument's chartreuse rather than the risk ramp: a
 * symbol the diff touched *and* failing tests reach is a different claim from a
 * high Ochiai score alone.
 */

import { Chip, Meter, Mono, no2 } from "@/components/gt";
import { SymLink } from "@/components/kit";
import type { Suspect } from "@/lib/api";
import { HOW, pct, splitId } from "@/lib/format";

export function SuspectRow({ repo, s, rank, open, onToggle }: { repo: string; s: Suspect; rank: number; open: boolean; onToggle: () => void }) {
  return (
    <li className="border-b border-line" data-on={open ? "true" : undefined}>
      <button
        type="button"
        onClick={onToggle}
        data-on={open ? "true" : undefined}
        className="gt-row w-full grid-cols-[28px_minmax(0,1fr)_auto_minmax(64px,96px)] border-b-0 text-left"
        aria-expanded={open}
      >
        <span className="gt-row__no">{no2(rank)}</span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="gt-row__name truncate font-mono text-[13px]" data-hover-mark>
            {s.name}
          </span>
          {s.changed && (
            <Chip tone="mark" solid>
              changed
            </Chip>
          )}
        </span>
        {/* Counts, not a tooltip: the glyphs carry it on screen, the sr-only text aloud. */}
        <span className="gt-f">
          <span aria-hidden>
            <span className={s.failed ? "text-fail" : undefined}>{s.failed}✗</span> {s.passed}✓
          </span>
          <span className="sr-only">
            {s.failed} failing and {s.passed} passing tests reach it
          </span>
        </span>
        <span className="block">
          <Mono className="mb-1 block text-right text-[11px] text-ink">{s.score.toFixed(3)}</Mono>
          <Meter value={s.score} barClassName={s.changed ? "bg-mark" : "bg-fail"} label={`Suspiciousness ${s.score.toFixed(3)} of 1`} />
        </span>
      </button>

      {open && (
        <div className="space-y-3 pt-1 pr-2 pb-4 pl-[calc(28px+clamp(8px,1.6vw,20px)+4px)]">
          <SymLink repo={repo} id={s.id} name={`${s.file}:${s.line}`} className="text-[11px] text-ink-dim" />

          {s.why && (
            <p className="text-[13px] leading-relaxed text-ink-dim">
              {/* Measured coverage and a static traversal are not the same evidence; say which produced this. */}
              <Chip tone={s.basis === "coverage" ? "info" : "neutral"} className="mr-2 align-[1px]">
                {s.basis === "coverage" ? "measured" : "static"}
              </Chip>
              {s.why}
            </p>
          )}

          <div>
            <div className="gt-label mb-1.5">
              Reached from {s.failing_tests.length} failing test{s.failing_tests.length === 1 ? "" : "s"}
            </div>
            <ul className="space-y-0.5">
              {s.failing_tests.slice(0, 8).map((t) => (
                <li key={t}>
                  <SymLink repo={repo} id={t} className="text-[12px] text-fail" />
                </li>
              ))}
            </ul>
            {/* Say what was cut. A list that silently stops at eight reads as the whole truth. */}
            {s.failing_tests.length > 8 && <p className="mt-1 font-mono text-[10.5px] text-ink-faint">and {s.failing_tests.length - 8} more</p>}
          </div>

          {s.path.length > 0 && (
            <ol className="space-y-1 border-l border-mark/50 pl-3">
              {s.path.map((p, i) => (
                <li key={`${p.from}->${p.to}:${i}`} className="text-[12px]">
                  <SymLink repo={repo} id={p.from} name={splitId(p.from)[1]} className="text-[12px]" />{" "}
                  <span className="text-ink-faint">{p.type === "CALLS" ? "calls" : p.type.toLowerCase()}</span>{" "}
                  <SymLink repo={repo} id={p.to} name={splitId(p.to)[1]} className="text-[12px]" />
                  <Mono className="ml-2 text-[10.5px] text-ink-faint">
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
