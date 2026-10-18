"use client";

/**
 * The landing page — rebuilt on the Aether Node composition.
 *
 * WHAT THE FIRST VIEWPORT HAS TO DO
 * The brief says to preserve the source's first-viewport signal, its focal
 * object, and its density. Mapped onto this product that means three things,
 * in this order:
 *
 *   1. The claim, set in Inter at display size, revealed line by line out of a
 *      mask. One sentence, because the product is one question.
 *   2. The focal object: the index form on the inverted #E5E5E5 surface. On an
 *      empty install it is the only thing to do, and on a full one it is still
 *      the most common — so it is the brightest object on the page rather than
 *      something hidden behind a modal. It is also the *only* inverted surface
 *      in the viewport, which is what makes it read as focal at all.
 *   3. Live counts from the API in a mono rail beside it. The source's hero
 *      carries telemetry, and here the telemetry is real: these are the graphs
 *      actually on this machine, summed. Nothing on this page is a sample
 *      number, because a landing page that invents metrics teaches the reader
 *      to distrust every number the product shows afterwards.
 *
 * Below the fold the rhythm is the source's 80px section band: "Global Event
 * Matrix" (the repositories, which is the mesh this product actually observes)
 * and "Telemetry Data" (what the graph knows, and how to read it). Those two
 * headings are the ones the brief names, and they are kept because they happen
 * to describe exactly what this product shows.
 *
 * The ambient mesh sits behind the hero only. It is decoration, and decoration
 * does not follow you down a working page.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AmbientField } from "@/components/ambient";
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
import { Enter, Reveal } from "@/components/motion";
import { repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, type Repo } from "@/lib/api";
import { num, pct, relTime } from "@/lib/format";
import { useAction, useQuery } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* The focal object.                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The index form, on the inverted surface.
 *
 * Everything inside carries black ink, which is why the controls below set
 * their own colours explicitly instead of inheriting the app's dark-ground
 * defaults. This is the one place in the product where that is correct, and it
 * is contained to this component on purpose — an inverted variant of every
 * control would double the design system for a single form.
 */
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

  const field =
    "border-invert-ink/15 bg-white text-invert-ink placeholder:text-invert-ink/35 focus-visible:border-invert-ink/60";

  return (
    <form onSubmit={submit}>
      <Panel tone="focal" title="Index a repository" note="A local path on the API host, or an https git URL">
        <Stack className="gap-[var(--space-gap)]">
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="min-w-0 flex-1">
              <Label htmlFor="target" className="mb-2 block">
                <Eyebrow className="text-invert-ink/60">Target</Eyebrow>
              </Label>
              <div className="relative">
                {isUrl && (
                  <Github
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-invert-ink/40"
                    aria-hidden
                  />
                )}
                <Input
                  id="target"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="/srv/code/myrepo  or  https://github.com/owner/repo"
                  className={cn("font-mono", field, isUrl && "pl-9")}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="md:w-44">
              <Label htmlFor="name" className="mb-2 block">
                <Eyebrow className="text-invert-ink/60">Name</Eyebrow>
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="from the folder"
                className={cn("font-mono", field)}
              />
            </div>
            <Button
              type="submit"
              disabled={!target.trim() || start.loading}
              className="bg-invert-ink text-invert hover:bg-invert-ink/85 md:w-32"
            >
              <Plus className="size-4" /> {start.loading ? "Starting…" : "Index"}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-caption text-invert-ink-muted">
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
      </Panel>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero telemetry — real totals, or nothing.                                   */
/* -------------------------------------------------------------------------- */

function HeroTelemetry({ repos, loading }: { repos: Repo[]; loading: boolean }) {
  const totals = useMemo(() => {
    const sum = (f: (r: Repo) => number | null | undefined) => repos.reduce((a, r) => a + (f(r) ?? 0), 0);
    const files = sum((r) => r.files);
    const symbols = sum((r) => r.symbols);
    const calls = sum((r) => r.calls);
    // A weighted mean, not a mean of means: a 40-call repo at 100% should not
    // drag a 40,000-call repo at 70% up to 85%.
    const resolved = repos.reduce((a, r) => a + (r.calls ?? 0) * (r.resolution_rate ?? 0), 0);
    return { files, symbols, calls, rate: calls ? resolved / calls : null };
  }, [repos]);

  const rows: [string, string][] = [
    ["graphs", String(repos.length)],
    ["files", num(totals.files)],
    ["symbols", num(totals.symbols)],
    ["call edges", num(totals.calls)],
  ];

  return (
    <Panel
      title="Telemetry"
      note={loading ? "reading the graphs on this host" : "summed across every graph on this host"}
      bodyClassName="p-0"
      flush
    >
      <dl className="divide-y divide-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 px-[var(--panel-pad-x)] py-3">
            <dt>
              <Eyebrow>{k}</Eyebrow>
            </dt>
            <dd className="font-display text-subheading text-ink-strong tabular-nums">{loading ? "—" : v}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-line px-[var(--panel-pad-x)] py-4">
        <div className="mb-2 flex items-baseline justify-between text-caption text-ink-muted">
          <span>call sites resolved</span>
          <Mono className="text-ink-strong">{totals.rate == null ? "—" : pct(totals.rate)}</Mono>
        </div>
        <Meter value={totals.rate ?? 0} barClassName="bg-invert" label="Call sites resolved across all graphs" />
        <p className="mt-3 text-caption leading-relaxed text-ink-muted">
          The share of call sites the resolver tied to a definition. The rest are shown as unresolved rather than
          guessed at.
        </p>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Repository card — one node in the matrix.                                   */
/* -------------------------------------------------------------------------- */

function RepoCard({ repo, index, onDropped }: { repo: Repo; index: number; onDropped: () => void }) {
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
    <Enter as="li" index={index}>
      <Bento className="h-full gap-0">
        <div className="flex items-start gap-3">
          <div className="min-w-0">
            {/* The stretched link makes the whole card the hit target; the drop button
             *  lifts itself above it with z-10 so it stays independently clickable. */}
            <Link
              href={repoHref(repo.name)}
              className="font-mono text-body-lg text-ink-strong after:absolute after:inset-0 after:content-['']"
            >
              {repo.name}
            </Link>
            <p className="mt-1.5 truncate text-caption text-ink-faint">
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
                "relative z-10 ml-auto h-8 gap-1.5 px-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
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

        <dl className="mt-6 grid grid-cols-3 gap-4">
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
              <dd className="mt-1 font-display text-heading leading-none text-ink-strong tabular-nums">{num(v)}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-6">
          <div className="mb-2 flex justify-between text-caption text-ink-faint">
            <span>call sites resolved</span>
            <Mono>{pct(repo.resolution_rate)}</Mono>
          </div>
          <Meter value={repo.resolution_rate ?? 0} barClassName="bg-ink-muted" label="Call sites resolved" />
        </div>

        <p className="mt-6 flex items-center gap-1.5 text-caption text-ink-faint transition-colors group-hover:text-ink-strong">
          Open <ArrowRight className="size-3.5" aria-hidden />
        </p>
      </Bento>
    </Enter>
  );
}

/* -------------------------------------------------------------------------- */

const STEPS = [
  [Plus, "Index a repository", "A local path or a public git URL. Python, TypeScript, JavaScript, Go, Java and Rust."],
  [
    Zap,
    "Say what you are changing",
    "A function, a class, a file or a whole diff — and whether the signature moves or only the body.",
  ],
  [
    TestTube,
    "See what breaks",
    "Ranked dependents with the call path behind each one, the tests to run, and who owns the code.",
  ],
] as const;

export default function Home() {
  const repos = useQuery("repos", api.repos);
  const router = useRouter();
  const [job, setJob] = useState<{ repo: string; after: number } | null>(null);
  const state = useIndexJob(job?.repo ?? null, job?.after ?? 0, repos.reload);
  const list = repos.data?.repos ?? [];

  return (
    /* `landing` is what hides the scrollbar chrome for this route only. */
    <div className="landing">
      <Page className="max-w-[1280px]">
        {/* ----------------------------------------------------- first viewport */}
        <section className="relative isolate -mx-[var(--space-card)] px-[var(--space-card)] pt-10 pb-[var(--space-section)] md:pt-16">
          <AmbientField className="-z-10" density={1} />

          <Eyebrow className="text-ink-muted">Core · Dependency graph</Eyebrow>

          <Reveal
            lines={["What breaks", "if I change this?"]}
            className="mt-6 max-w-[16ch] font-display text-display"
          />

          <p className="mt-8 max-w-[62ch] text-body text-ink-muted">
            Aftershock parses a repository into a FalkorDB graph of files, symbols, calls, inheritance, imports and git
            co-change, then answers with multi-hop traversals. Every answer shows its path, how each edge was resolved,
            and how sure it is.
          </p>

          <Grid cols="matrix-rail" className="mt-12 items-start">
            <div id="index" className="scroll-mt-24">
              <Stack>
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
            <HeroTelemetry repos={list} loading={!repos.data} />
          </Grid>
        </section>

        {/* ------------------------------------------------- global event matrix */}
        <Enter as="section" className="pb-[var(--space-section)]">
          <Slab
            title="Global Event Matrix"
            description="Every graph on this host. Each card is a live count read from FalkorDB, not a cached summary."
            action={
              list.length > 0 && (
                <Chip tone="neutral">
                  {list.length} {list.length === 1 ? "graph" : "graphs"}
                </Chip>
              )
            }
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
                <ul className="contents">
                  {list.map((r, i) => (
                    <RepoCard key={r.name} repo={r} index={i} onDropped={repos.reload} />
                  ))}
                </ul>
              </Grid>
            )}
          </Slab>
        </Enter>

        {/* ------------------------------------------------------ telemetry data */}
        <Enter as="section" className="pb-[var(--space-section)]">
          <Slab
            title="Telemetry Data"
            description="What the graph records, and what it refuses to guess. Read this once and every other screen explains itself."
          >
            <Grid cols={3}>
              {STEPS.map(([Icon, title, body], i) => (
                <Panel key={title} tone="default">
                  <div className="flex items-center gap-3">
                    <Mono className="text-label font-semibold text-ink-faint">
                      {String(i + 1).padStart(2, "0")}
                    </Mono>
                    <Icon className="size-4 text-ink-strong" aria-hidden />
                    <span className="font-display text-body-lg text-ink-strong">{title}</span>
                  </div>
                  <p className="mt-4 text-body-sm leading-relaxed text-ink-muted">{body}</p>
                </Panel>
              ))}
            </Grid>
          </Slab>
        </Enter>
      </Page>
    </div>
  );
}
