"use client";

import Link from "next/link";

import type { TestRunSummary } from "@/lib/api";
import { num, relTime } from "@/lib/format";

/** Recorded TestRuns (D25), newest first, as a ledger; each opens on the Culprit page, where a failing one can be fixed. */
export function RunList({ repo, runs, current }: { repo: string; runs: TestRunSummary[]; current?: string }) {
  if (!runs.length) return <p className="py-3 text-[13px] text-ink-dim">No recorded runs yet. Every run from this page, the CLI or a heal is kept here.</p>;
  return (
    <ul className="gt-ledger">
      {runs.map((r) => {
        const bad = r.failed > 0 || ![0, 5].includes(r.exit_code);
        const on = current === r.id;
        return (
          <li key={r.id}>
            <Link
              href={`/r/${encodeURIComponent(repo)}/culprit?run=${r.id}`}
              aria-current={on ? "true" : undefined}
              data-on={on ? "true" : undefined}
              className="gt-row grid-cols-[8px_76px_minmax(0,1fr)_auto_64px]"
            >
              <span className={bad ? "size-[7px] self-center bg-fail" : "size-[7px] self-center bg-pass"} aria-label={bad ? "failed" : "passed"} role="img" />
              <span className="gt-row__no">{r.id.slice(-8)}</span>
              <span className="truncate text-[13px]">
                {r.trigger === "heal" ? (
                  <span className="font-mono text-[11.5px] tracking-[.06em] text-mark uppercase">
                    heal {r.heal_step}
                    {r.heal_round ? ` · round ${r.heal_round}` : ""}
                  </span>
                ) : (
                  <span className="gt-row__name">{r.mode}</span>
                )}
                {r.heal_suspect && <span className="font-mono text-[11.5px] text-ink-dim"> · {r.heal_suspect.split("::").pop()}</span>}
              </span>
              <span className="gt-f">
                <span className={r.failed ? "text-fail" : undefined}>{num(r.failed)}✗</span> {num(r.passed)}✓
              </span>
              <span className="gt-f">{relTime(r.started)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
