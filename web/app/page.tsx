"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { ArrowRight, GitDiff, Github, Network, Plus, TestTube, Trash, Zap } from "@/components/icons";
import { JobProgress, useIndexJob } from "@/components/index-job";
import { Empty, ErrorNote, Meter, Page, Spinner } from "@/components/kit";
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
    const res = await start.run({ ...(isUrl ? { url: t } : { path: t }), name: name.trim() || undefined, full, history });
    if (res) onStarted(res.repo, res.after);
  };
  return (
    <form onSubmit={submit} className="rounded-xl border border-border bg-card/50 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="min-w-0 flex-1">
          <Label htmlFor="target" className="mb-1.5 text-xs text-fog">
            Local path on the API host, or an https git URL
          </Label>
          <div className="relative">
            {isUrl && <Github className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fog" aria-hidden />}
            <Input
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="/srv/code/myrepo  or  https://github.com/owner/repo"
              className={cn("font-mono text-sm", isUrl && "pl-8")}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <div className="md:w-44">
          <Label htmlFor="name" className="mb-1.5 text-xs text-fog">
            Name <span className="text-ash">(optional)</span>
          </Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="from the folder" className="font-mono text-sm" />
        </div>
        <Button type="submit" disabled={!target.trim() || start.loading} className="md:w-32">
          <Plus className="size-4" /> {start.loading ? "Starting…" : "Index"}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-2">
          <Switch checked={history} onCheckedChange={setHistory} aria-label="Mine git history" /> Git history (owners, co-change)
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={full} onCheckedChange={setFull} aria-label="Full re-parse" /> Full re-parse
        </label>
        <span className="ml-auto hidden md:inline">Re-indexing is incremental: only changed files are parsed again.</span>
      </div>
      {start.error && <ErrorNote error={start.error} className="mt-3" />}
    </form>
  );
}

function RepoCard({ repo, onDropped }: { repo: Repo; onDropped: () => void }) {
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
    <div className="group epi-in relative flex flex-col rounded-xl border border-border bg-card/50 p-4 transition-colors hover:border-smoke">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <Link href={repoHref(repo.name)} className="font-mono text-[15px] text-paper after:absolute after:inset-0 after:content-['']">
            {repo.name}
          </Link>
          <div className="mt-0.5 truncate font-mono text-[11px] text-fog">
            {repo.commit ? repo.commit.slice(0, 10) : "no commit"} · {relTime(repo.indexed_at)}
            {repo.url ? ` · ${repo.url.replace(/^https:\/\//, "")}` : ""}
          </div>
        </div>
        {repo.indexing ? (
          <span className="ml-auto rounded-full bg-gold/10 px-2 py-0.5 text-[11px] text-gold">indexing</span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className={cn("relative z-10 ml-auto h-7 px-2 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100", confirm && "text-coral-red opacity-100")}
            onClick={remove}
            disabled={drop.loading}
            aria-label={confirm ? `Confirm: drop ${repo.name}` : `Drop ${repo.name}`}
          >
            <Trash className="size-3.5" /> {confirm ? "Drop graph?" : ""}
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
            <dt className="text-[10px] tracking-[0.08em] text-fog uppercase">{k}</dt>
            <dd className="font-mono text-lg text-paper tabular-nums">{num(v)}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4">
        <div className="mb-1 flex justify-between text-[11px] text-fog">
          <span>call sites resolved</span>
          <span className="font-mono">{pct(repo.resolution_rate)}</span>
        </div>
        <Meter value={repo.resolution_rate ?? 0} barClassName="bg-gold/80" />
      </div>
      <div className="mt-4 flex items-center gap-1 text-xs text-fog group-hover:text-mist">
        Open <ArrowRight className="size-3.5" />
      </div>
    </div>
  );
}

const STEPS = [
  [Plus, "Index a repository", "Paste a local path or a public git URL below. Python, TypeScript, JavaScript, Go, Java and Rust."],
  [Zap, "Pick what you are changing", "A function, a class, a file, or a whole diff. Say whether the signature or only the body changes."],
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
      <section className="relative mb-10 overflow-hidden rounded-xl border border-border bg-grid px-6 py-12 md:px-10 md:py-16">
        <div className="pointer-events-none absolute -top-32 -right-24 size-96 rounded-full bg-gold/5 blur-3xl" aria-hidden />
        <p className="mb-3 font-mono text-[11px] tracking-[0.14em] text-gold uppercase">Code dependency graph</p>
        <h1 className="max-w-3xl text-[44px] leading-[1.02] md:text-[60px]">What breaks if I change this?</h1>
        <p className="mt-4 max-w-2xl text-body-sm text-muted-foreground">
          Aftershock parses a repository into a FalkorDB graph of files, symbols, calls, inheritance, imports and git
          co-change, then answers with multi-hop traversals. Every answer shows its path, how each edge was resolved, and
          how sure it is.
        </p>
        <ol className="mt-8 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-3">
          {STEPS.map(([Icon, title, body], i) => (
            <li key={title} className="rounded-lg border border-border bg-background/60 p-4 backdrop-blur-sm">
              <div className="mb-2 flex items-center gap-2 text-sm text-paper">
                <span className="font-mono text-[11px] text-gold">{i + 1}</span>
                <Icon className="size-4 text-gold" aria-hidden /> {title}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <div id="index" className="mb-8 scroll-mt-20 space-y-3">
        <IndexForm onStarted={(repo, after) => setJob({ repo, after })} />
        {job && state && (
          <div className="space-y-2">
            <JobProgress repo={job.repo} job={state} />
            {state.status === "done" && (
              <Button size="sm" onClick={() => router.push(repoHref(job.repo))}>
                Open {job.repo} <ArrowRight className="size-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-subheading">Repositories</h2>
        <span className="font-mono text-xs text-fog">{list.length || ""}</span>
      </div>
      {repos.error ? (
        <ErrorNote error={repos.error} />
      ) : !repos.data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty title="Nothing indexed yet" icon={<Network className="size-6" />}>
          Index a local checkout or a public git URL above, or run <code className="font-mono text-paper">aftershock index ./repo</code>.
          Then open it and try <GitDiff className="inline size-3.5" aria-hidden /> Diff on your working tree.
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((r) => (
            <RepoCard key={r.name} repo={r} onDropped={repos.reload} />
          ))}
        </div>
      )}
    </Page>
  );
}
