"use client";

import { ChevronDown, ChevronRight } from "@/components/icons";
import { Meter, SymLink } from "@/components/kit";
import type { Suspect } from "@/lib/api";
import { HOW, pct, splitId } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One ranked culprit suspect: rank, evidence (failing ✗ / passing ✓ tests that reach it), score, and its why-chain. */
export function SuspectRow({ repo, s, rank, open, onToggle }: { repo: string; s: Suspect; rank: number; open: boolean; onToggle: () => void }) {
  return (
    <li className={cn("rounded-lg border border-transparent", open && "border-graphite bg-white/[0.02]")}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/[0.03]" aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5 shrink-0 text-fog" /> : <ChevronRight className="size-3.5 shrink-0 text-fog" />}
        <span className="w-6 shrink-0 font-mono text-xs text-fog">#{rank}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-paper">{s.name}</span>
        {s.changed && <span className="shrink-0 rounded bg-brand/15 px-1.5 py-0.5 text-[10.5px] text-brand">changed</span>}
        <span className="shrink-0 font-mono text-[11px] text-fog" title={`${s.failed} failing and ${s.passed} passing tests reach it`}>
          {s.failed}✗ {s.passed}✓
        </span>
        <span className="w-16 shrink-0 sm:w-24" title="Ochiai suspiciousness, 0–1: failing tests that reach it ÷ √(all failing × all tests that reach it)">
          <span className="block text-right font-mono text-[11px] text-mist">{s.score.toFixed(3)}</span>
          <Meter value={s.score} barClassName={s.changed ? "bg-brand" : "bg-coral-red/80"} />
        </span>
      </button>
      {open && (
        <div className="space-y-3 px-9 pt-1 pb-3 text-xs">
          <div className="font-mono text-[11px] text-fog">
            <SymLink repo={repo} id={s.id} name={`${s.file}:${s.line}`} className="text-[11px] text-fog" />
          </div>
          {s.why && (
            <p className="text-[12px] leading-relaxed text-mist">
              <span className={cn("mr-1.5 rounded px-1.5 py-0.5 text-[10.5px]", s.basis === "coverage" ? "bg-signal-teal/15 text-signal-teal" : "bg-white/[0.06] text-fog")}>
                {s.basis === "coverage" ? "measured" : "static"}
              </span>
              {s.why}
            </p>
          )}
          <div>
            <div className="mb-1 text-[11px] text-fog">Reached from {s.failing_tests.length} failing test{s.failing_tests.length === 1 ? "" : "s"}</div>
            <ul className="space-y-0.5">
              {s.failing_tests.slice(0, 8).map((t) => (
                <li key={t}>
                  <SymLink repo={repo} id={t} className="text-[12px] text-coral-red/90" />
                </li>
              ))}
            </ul>
          </div>
          {s.path.length > 0 && (
            <ol className="space-y-1 border-l border-graphite pl-3">
              {s.path.map((p, i) => (
                <li key={i}>
                  <SymLink repo={repo} id={p.from} name={splitId(p.from)[1]} className="text-[12px] text-mist" />{" "}
                  <span className="text-fog">{p.type === "CALLS" ? "calls" : p.type.toLowerCase()}</span>{" "}
                  <SymLink repo={repo} id={p.to} name={splitId(p.to)[1]} className="text-[12px]" />
                  <span className="ml-2 font-mono text-[10.5px] text-fog">
                    {p.how ? (HOW[p.how] ?? p.how) : ""}
                    {p.confidence !== undefined ? ` · ${pct(p.confidence)}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </li>
  );
}
