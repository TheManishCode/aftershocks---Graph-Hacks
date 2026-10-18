"use client";

/**
 * The landing page: what this is, and the repositories it knows about.
 *
 * It carries a hero because it is the one screen a first-time visitor sees
 * before they have any data — with nothing indexed, a bare empty table teaches
 * them nothing. Every other screen skips straight to the work.
 *
 * The index form sits above the list rather than behind a dialog: on an empty
 * install it is the only thing to do, and on a full one it is still the most
 * common. A modal would hide the product's entry point behind a click.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ArrowRight, GitDiff, Github, Network, Plus, TestTube, Trash, Zap } from "@/components/icons";
import { JobProgress, useIndexJob } from "@/components/index-job";
import {
  Bento,
  Chip,
  Code,
  Empty,
  ErrorNote,
  Eyebrow,
  Grid,
  Meter,
  Mono,
  Page,
  Panel,
  Slab,
  Spinner,
  Stack,
} from "@/components/ds";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
      <Panel title="Index a repository" bodyClassName="flex flex-col gap-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="min-w-0 flex-1">
            <Label htmlFor="target" className="mb-1.5">
              <Eyebrow>Local path on the API host, or an https git URL</Eyebrow>
            </Label>
            <div className="relative">
              {isUrl && (
                <Github
                  className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-faint"
                  aria-hidden
                />
              )}
              <Input
                id="target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="/srv/code/myrepo  or  https://github.com/owner/repo"
                className={cn("font-mono", isUrl && "pl-8")}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="md:w-44">
            <Label htmlFor="name" className="mb-1.5">
              <Eyebrow>Name (optional)</Eyebrow>
            </Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="from the folder"
              className="font-mono"
            />
          </div>
          <Button type="submit" disabled={!target.trim() || start.loading} className="md:w-32">
            <Plus className="size-4" /> {start.loading ? "Starting…" : "Index"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-caption text-ink-muted">
          <label className="flex items-center gap-2">
            <Switch checked={history} onCheckedChange={setHistory} aria-label="Mine git history" />
            Git history (owners, co-change)
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={full} onCheckedChange={setFull} aria-label="Full re-parse" />
            Full re-parse
          </label>
          <span className="ml-auto hidden md:inline">
            Re-indexing is incremental: only changed files are parsed again.
          </span>
        </div>
        {start.error && <ErrorNote error={start.error} />}
      </Panel>
    </form>
  );
}

function RepoCard({ repo, onDropped }: { repo: Repo; onDropped: () => void }) {
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
    <Bento className="as-in gap-0 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          {/* The stretched link makes the whole card the hit target; the drop button
           *  lifts itself above it with z-10 so it stays independently clickable. */}
          <Link
            href={repoHref(repo.name)}
            className="font-mono text-body text-ink-strong after:absolute after:inset-0 after:content-['']"
          >
            {repo.name}
          </Link>
          <p className="mt-0.5 truncate font-mono text-micro text-ink-faint">
            {repo.commit ? repo.commit.slice(0, 10) : "no commit"} · {relTime(repo.indexed_at)}
            {repo.url ? ` · ${repo.url.replace(/^https:\/\//, "")}` : ""}
          </p>
        </div>
        {repo.indexing ? (
          <Chip tone="brand" className="ml-auto" dot>
            indexing
          </Chip>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "relative z-10 ml-auto h-7 gap-1.5 px-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              confirm && "text-fail opacity-100",
            )}
            onClick={remove}
            disabled={drop.loading}
            aria-label={confirm ? `Confirm: drop the graph for ${repo.name}` : `Drop the graph for ${repo.name}`}
          >
            <Trash className="size-3.5" aria-hidden />
            {confirm && <span className="text-caption">Drop graph?</span>}
          </Button>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3">
        {(
          [
            ["files", repo.files],
            ["symbols", repo.symbols],
            ["calls", repo.calls],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt>
              <Eyebrow>{k}</Eyebrow>
            </dt>
            <dd className="font-mono text-heading text-ink-strong tabular-nums">{num(v)}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4">
        <div className="mb-1 flex justify-between text-micro text-ink-faint">
          <span>call sites resolved</span>
          <Mono>{pct(repo.resolution_rate)}</Mono>
        </div>
        <Meter value={repo.resolution_rate ?? 0} barClassName="bg-brand/80" label="Call sites resolved" />
      </div>

      <p className="mt-4 flex items-center gap-1 text-caption text-ink-faint group-hover:text-brand">
        Open <ArrowRight className="size-3.5" aria-hidden />
      </p>
    </Bento>
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
    <Page className="max-w-[1200px]">
      <Stack className="gap-8">
        <section className="relative overflow-hidden rounded-bento border border-line bg-grid px-6 py-12 md:px-10 md:py-16">
          <div
            className="pointer-events-none absolute -top-32 -right-24 size-96 rounded-full bg-brand/5 blur-3xl"
            aria-hidden
          />
          <Eyebrow tone="brand" className="tracking-[0.14em]">
            Code dependency graph
          </Eyebrow>
          <h1 className="mt-3 max-w-3xl text-[44px] leading-[1.02] md:text-[60px]">What breaks if I change this?</h1>
          <p className="mt-4 max-w-2xl text-body-sm text-ink-muted">
            Aftershock parses a repository into a FalkorDB graph of files, symbols, calls, inheritance, imports and git
            co-change, then answers with multi-hop traversals. Every answer shows its path, how each edge was resolved,
            and how sure it is.
          </p>
          <ol className="mt-8 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-3">
            {STEPS.map(([Icon, title, body], i) => (
              <li key={title} className="rounded-panel border border-line bg-ground/60 p-4 backdrop-blur-sm">
                <p className="mb-2 flex items-center gap-2 text-body-sm text-ink-strong">
                  <Mono className="text-micro text-brand">{i + 1}</Mono>
                  <Icon className="size-4 text-brand" aria-hidden /> {title}
                </p>
                <p className="text-caption leading-relaxed text-ink-muted">{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <div id="index" className="scroll-mt-20">
          <Stack className="gap-3">
            <IndexForm onStarted={(repo, after) => setJob({ repo, after })} />
            {job && state && (
              <Stack className="gap-2">
                <JobProgress repo={job.repo} job={state} />
                {state.status === "done" && (
                  <Button size="sm" onClick={() => router.push(repoHref(job.repo))} className="w-fit">
                    Open {job.repo} <ArrowRight className="size-4" />
                  </Button>
                )}
              </Stack>
            )}
          </Stack>
        </div>

        <Slab
          title="Repositories"
          action={list.length > 0 && <Mono className="text-caption text-ink-faint">{list.length}</Mono>}
        >
          {repos.error ? (
            <ErrorNote error={repos.error} onRetry={repos.reload} />
          ) : !repos.data ? (
            <Spinner label="Loading repositories" />
          ) : list.length === 0 ? (
            <Empty title="Nothing indexed yet" icon={<Network className="size-6" aria-hidden />}>
              Index a local checkout or a public git URL above, or run <Code>aftershock index ./repo</Code>. Then open
              it and try <GitDiff className="inline size-3.5" aria-hidden /> Diff on your working tree.
            </Empty>
          ) : (
            <Grid cols={3}>
              {list.map((r) => (
                <RepoCard key={r.name} repo={r} onDropped={repos.reload} />
              ))}
            </Grid>
          )}
        </Slab>
      </Stack>
    </Page>
  );
}
