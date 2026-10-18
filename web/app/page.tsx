"use client";

/**
 * Home: index a repository, then pick one.
 *
 * The index form is the focal object — on an empty install it is the only
 * thing to do, and on a full one still the most common. Beside it, live totals
 * summed from `/repos`: the telemetry is real or it is a dash, because a home
 * page that invents numbers teaches the reader to distrust every one after it.
 * Below, the ledger of graphs on this host, each a row that opens its overview.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Chip, Cols, Empty, ErrorNote, Head, Label, Measuring, Meter, Mono, Page, Sheet, Stack, no2 } from "@/components/gt";
import { ArrowRight, GitDiff, Github, Plus, TestTube, Trash, Zap } from "@/components/icons";
import { JobProgress, useIndexJob } from "@/components/index-job";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, type Repo } from "@/lib/api";
import { num, pct, relTime } from "@/lib/format";
import { useAction, useQuery } from "@/lib/hooks";
import { cn } from "@/lib/utils";

function IndexForm({ onStarted }: { onStarted: (repo: string, after: number) => void }) {
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [full, setFull] = useState(false);
  const [history, setHistory] = useState(true);
  const start = useAction(api.index);
  const isUrl = target.trim().startsWith("https://");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = target.trim();
    if (!t) return;
    const res = await start.run({
      ...(isUrl ? { url: t } : { path: t }),
      name: name.trim() || undefined,
      full,
      history,
    });
    if (res) onStarted(res.repo, res.after);
  };

  return (
    <form onSubmit={submit}>
      <Sheet no="00 · Input" title="Index a repository" note="A local path on the API host, or an https git URL." tone="commission">
        <Stack className="gap-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="min-w-0 flex-1">
              <Label htmlFor="target">Target</Label>
              <div className="relative">
                {isUrl && <Github className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />}
                <input
                  id="target"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="/srv/code/myrepo  or  https://github.com/owner/repo"
                  className={cn("gt-field", isUrl && "pl-9")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="md:w-44">
              <Label htmlFor="name">Name</Label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="from the folder" className="gt-field" autoComplete="off" spellCheck={false} />
            </div>
            <Button type="submit" disabled={!target.trim() || start.loading} className="h-10 md:w-32">
              <Plus className="size-4" aria-hidden /> {start.loading ? "Starting…" : "Index"}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-ink-dim">
            <label className="flex items-center gap-2">
              <Switch checked={history} onCheckedChange={setHistory} aria-label="Mine git history" />
              Git history (owners, co-change)
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={full} onCheckedChange={setFull} aria-label="Full re-parse" />
              Full re-parse
            </label>
            <span className="ml-auto hidden lg:inline">Re-indexing is incremental — only changed files are parsed.</span>
          </div>

          {start.error && <ErrorNote error={start.error} />}
        </Stack>
      </Sheet>
    </form>
  );
}

function Telemetry({ repos, loading }: { repos: Repo[]; loading: boolean }) {
  const totals = useMemo(() => {
    const sum = (f: (r: Repo) => number | null | undefined) => repos.reduce((a, r) => a + (f(r) ?? 0), 0);
    const calls = sum((r) => r.calls);
    // A weighted mean, not a mean of means: a 40-call repo at 100% should not
    // drag a 40,000-call repo at 70% up to 85%.
    const resolved = repos.reduce((a, r) => a + (r.calls ?? 0) * (r.resolution_rate ?? 0), 0);
    return { files: sum((r) => r.files), symbols: sum((r) => r.symbols), calls, rate: calls ? resolved / calls : null };
  }, [repos]);

  const rows: [string, string][] = [
    ["graphs", String(repos.length)],
    ["files", num(totals.files)],
    ["symbols", num(totals.symbols)],
    ["call edges", num(totals.calls)],
  ];

  return (
    <Sheet no="Telemetry" note={loading ? "Reading the graphs on this host." : "Summed across every graph on this host."} tone="library" flush>
      <dl className="border-t border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 border-b border-line px-[clamp(14px,2vw,24px)] py-3">
            <dt className="gt-label">{k}</dt>
            <dd className="font-mono text-[17px] text-mark tabular-nums">{loading ? "—" : v}</dd>
          </div>
        ))}
      </dl>
      <div className="px-[clamp(14px,2vw,24px)] py-4">
        <div className="mb-2 flex items-baseline justify-between text-[12px] text-ink-dim">
          <span>call sites resolved</span>
          <Mono className="text-ink">{totals.rate == null ? "—" : pct(totals.rate)}</Mono>
        </div>
        <Meter value={totals.rate ?? 0} label="Call sites resolved across all graphs" />
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
          The share of call sites the resolver tied to a definition. The rest are shown as unresolved rather than guessed at.
        </p>
      </div>
    </Sheet>
  );
}

function RepoRow({ repo, index, onDropped }: { repo: Repo; index: number; onDropped: () => void }) {
  // Two-step delete rather than a dialog: dropping a graph is undoable by re-indexing,
  // so a modal would cost more attention than the action is worth. The button states
  // what it will do before it will do it, and forgets after four seconds.
  const [confirm, setConfirm] = useState(false);
  const drop = useAction(api.drop);

  const remove = async () => {
    if (!confirm) {
      setConfirm(true);
      setTimeout(() => setConfirm(false), 4000);
      return;
    }
    const ok = await drop.run(repo.name);
    if (ok) {
      toast.success(`Dropped ${repo.name}`);
      onDropped();
    } else toast.error(`Could not drop ${repo.name}`);
  };

  return (
    <li className="group gt-row relative grid-cols-[28px_minmax(0,1fr)_auto] items-center px-[clamp(14px,2vw,24px)] md:grid-cols-[28px_minmax(0,1.4fr)_repeat(3,minmax(64px,.5fr))_minmax(110px,.8fr)_auto]" data-hit>
      <span className="gt-row__no">{no2(index + 1)}</span>
      <div className="min-w-0">
        {/* The stretched link makes the whole row the hit target; the drop button
         *  lifts itself above it with z-10 so it stays independently clickable. */}
        <Link href={repoHref(repo.name)} className="gt-row__name block truncate font-mono text-[14px] text-ink after:absolute after:inset-0 after:content-['']" data-hover-mark>
          {repo.name}
        </Link>
        <p className="mt-1 truncate font-mono text-[10.5px] text-ink-faint">
          {repo.commit ? repo.commit.slice(0, 10) : "no commit"} · {relTime(repo.indexed_at)}
          {repo.url ? ` · ${repo.url.replace(/^https:\/\//, "")}` : ""}
        </p>
      </div>
      {(
        [
          ["files", repo.files],
          ["symbols", repo.symbols],
          ["calls", repo.calls],
        ] as const
      ).map(([k, v]) => (
        <div key={k} className="hidden text-right md:block">
          <Mono className="text-[14px] text-ink">{num(v)}</Mono>
          <div className="gt-label mt-1">{k}</div>
        </div>
      ))}
      <div className="hidden md:block">
        <div className="mb-1.5 flex justify-between text-[10.5px] text-ink-faint">
          <span>resolved</span>
          <Mono>{pct(repo.resolution_rate)}</Mono>
        </div>
        <Meter value={repo.resolution_rate ?? 0} barClassName="bg-ink-dim" label={`Call sites resolved in ${repo.name}`} />
      </div>
      {repo.indexing ? (
        <Chip tone="mark">indexing</Chip>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className={cn("relative z-10 gap-1.5 px-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100", confirm && "text-fail opacity-100")}
          onClick={remove}
          disabled={drop.loading}
          aria-label={confirm ? `Confirm: drop the graph for ${repo.name}` : `Drop the graph for ${repo.name}`}
        >
          <Trash className="size-3.5" aria-hidden />
          {confirm && <span className="text-[11px]">Drop graph?</span>}
        </Button>
      )}
    </li>
  );
}

const STEPS = [
  [Plus, "Index a repository", "A local path or a public git URL. Python, TypeScript, JavaScript, Go, Java and Rust."],
  [Zap, "Say what you are changing", "A function, a class, a file or a whole diff — and whether the signature moves or only the body."],
  [TestTube, "See what breaks", "Ranked dependents with the call path behind each one, the tests to run, and who owns the code."],
] as const;

export default function Home() {
  const repos = useQuery("repos", api.repos);
  const router = useRouter();
  const [job, setJob] = useState<{ repo: string; after: number } | null>(null);
  const state = useIndexJob(job?.repo ?? null, job?.after ?? 0, repos.reload);
  const list = repos.data?.repos ?? [];

  return (
    <Page>
      <Head
        no="00 · Aftershock"
        title={
          <>
            What breaks <em>if I change this?</em>
          </>
        }
        lead="Aftershock parses a repository into a FalkorDB graph of files, symbols, calls, inheritance, imports and git co-change, then answers with multi-hop traversals. Every answer shows its path, how each edge was resolved, and how sure it is."
      />

      <Stack>
        <Cols kind="main-aside">
          <div id="index" className="min-w-0 scroll-mt-24">
            <Stack>
              <IndexForm onStarted={(repo, after) => setJob({ repo, after })} />
              {job && state && (
                <Stack className="gap-2">
                  <JobProgress repo={job.repo} job={state} />
                  {state.status === "done" && (
                    <Button size="sm" onClick={() => router.push(repoHref(job.repo))} className="w-fit">
                      Open {job.repo} <ArrowRight className="size-4" aria-hidden />
                    </Button>
                  )}
                </Stack>
              )}
            </Stack>
          </div>
          <Telemetry repos={list} loading={!repos.data} />
        </Cols>

        <Sheet
          no="01 · Ledger"
          title="Repositories"
          note="Every graph on this host. Each row is a live count read from FalkorDB, not a cached summary."
          action={list.length > 0 && <Chip>{list.length} {list.length === 1 ? "graph" : "graphs"}</Chip>}
          flush={!repos.error && list.length > 0}
        >
          {repos.error ? (
            <ErrorNote error={repos.error} onRetry={repos.reload} />
          ) : !repos.data ? (
            <Measuring label="Loading repositories" />
          ) : list.length === 0 ? (
            <Empty title="Nothing indexed yet">
              Index a local checkout or a public git URL above, or run <Mono className="text-ink">aftershock index ./repo</Mono>. Then open it and try{" "}
              <GitDiff className="inline size-3.5" aria-hidden /> Diff on your working tree.
            </Empty>
          ) : (
            <ul className="border-t border-line">
              {list.map((r, i) => (
                <RepoRow key={r.name} repo={r} index={i} onDropped={repos.reload} />
              ))}
            </ul>
          )}
        </Sheet>

        <Sheet no="02 · Method" title="How to read it" note="What the graph records, and what it refuses to guess." tone="fragment">
          <ol className="grid gap-6 md:grid-cols-3">
            {STEPS.map(([Icon, title, body], i) => (
              <li key={title} className="min-w-0">
                <div className="flex items-center gap-3">
                  <Mono className="text-[10.5px] text-ink-faint">{no2(i + 1)}</Mono>
                  <Icon className="size-4 text-mark" aria-hidden />
                  <span className="text-[15px] text-ink">{title}</span>
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-ink-dim">{body}</p>
              </li>
            ))}
          </ol>
        </Sheet>
      </Stack>
    </Page>
  );
}
