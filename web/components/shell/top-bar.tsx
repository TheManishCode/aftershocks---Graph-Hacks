"use client";

/**
 * The top bar — identity and global controls only.
 *
 * Page navigation moved to the rail (components/shell/rail.tsx). What is left
 * here is the set of controls that apply to *every* page: which repo, is the
 * graph up, jump to anything, how should this look. Keeping those separate
 * from page nav is what lets both grow without fighting for the same row.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { FileCode, Menu, Pulse, Search, Settings, X } from "@/components/icons";
import { Kbd } from "@/components/ds/primitives";
import { REPO_NAV, repoHref } from "@/components/shell/nav";
import { Preferences } from "@/components/shell/preferences";
import { RailNav } from "@/components/shell/rail";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { symName } from "@/lib/format";
import { useDebounced, useModKey, useQuery, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

function Logo() {
  return (
    <Link
      href="/"
      className="flex shrink-0 items-center gap-2 text-ink-strong transition-opacity hover:opacity-80"
      aria-label="Aftershock home"
    >
      <span className="grid size-6 place-items-center rounded-control bg-brand-solid text-white shadow-[var(--shadow-accent-glow)]">
        <Pulse className="size-4" aria-hidden />
      </span>
      <span className="hidden font-display text-[1.05rem] leading-none font-medium tracking-[0.01em] uppercase sm:inline">
        Aftershock
      </span>
    </Link>
  );
}

function HealthDot() {
  const h = useQuery("health", api.health, 20_000);
  const ok = h.data?.ok;
  const label = h.error
    ? h.error.status === 503
      ? "Graph down"
      : "API unreachable"
    : !h.data
      ? "Checking…"
      : ok
        ? "Graph online"
        : "Degraded";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="flex items-center gap-2 rounded-control px-2 py-1 font-mono text-micro uppercase text-ink-muted hover:bg-accent"
          aria-label={label}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              h.error ? "bg-fail" : !h.data ? "bg-ink-faint" : ok ? "bg-pass as-pulse" : "bg-warn",
            )}
          />
          <span className="hidden xl:inline">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-caption">
        {h.error ? h.error.message : h.data ? `api ${h.data.version} · falkordb ${h.data.falkordb}` : "…"}
      </TooltipContent>
    </Tooltip>
  );
}

function RepoSwitcher({ className }: { className?: string }) {
  const repo = useRepo();
  const router = useRouter();
  const pathname = usePathname();
  const repos = useQuery("repos", api.repos);
  const names = repos.data?.repos.map((r) => r.name) ?? (repo ? [repo] : []);
  const switchTo = (name: string) => {
    // stay on the same page (impact, diff…) of the other repo; query strings name symbols, so they don't carry over
    const rest = repo ? pathname.slice(repoHref(repo).length) : "";
    router.push(repoHref(name, rest));
  };
  return (
    <Select value={repo || undefined} onValueChange={switchTo}>
      <SelectTrigger size="sm" className={cn("h-8 w-[170px] font-mono text-caption", className)} aria-label="Repository">
        <SelectValue placeholder="repository" />
      </SelectTrigger>
      <SelectContent>
        {names.map((n) => (
          <SelectItem key={n} value={n} className="font-mono text-caption">
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const router = useRouter();
  const repo = useRepo();
  const q = useDebounced(text.trim(), 150);
  const mod = useModKey();
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);
  const hits = useQuery(open && repo && q ? `palette:${repo}:${q}` : null, () => api.search(repo, q, 12));
  const repos = useQuery(open ? "palette:repos" : null, api.repos);
  const go = (href: string) => {
    setOpen(false);
    setText("");
    router.push(href);
  };
  return (
    <>
      <Button variant="outline" size="sm" className="h-8 gap-2 text-ink-muted" onClick={() => setOpen(true)}>
        <Search className="size-3.5" aria-hidden />
        <span className="sr-only md:not-sr-only">Jump to…</span>
        <Kbd className="hidden md:inline-flex">{mod === "⌘" ? "⌘K" : "Ctrl K"}</Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        shouldFilter={false}
        title="Jump to"
        description="Symbols, files, pages and repositories"
      >
        {/* results come from the graph's own ranking; cmdk's fuzzy filter would re-sort and drop them */}
        <CommandInput placeholder={repo ? `Symbol or file in ${repo}…` : "Repository or page…"} value={text} onValueChange={setText} />
        <CommandList>
          <CommandEmpty>{hits.loading ? "Searching…" : "Nothing matches."}</CommandEmpty>
          {repo && (hits.data?.symbols.length ?? 0) > 0 && (
            <CommandGroup heading="Symbols">
              {hits.data!.symbols.map((s) => (
                <CommandItem key={s.id} value={`sym ${s.id}`} onSelect={() => go(repoHref(repo, `/explore?ref=${encodeURIComponent(s.id)}`))}>
                  <span className="w-14 shrink-0 font-mono text-micro uppercase text-ink-faint">{s.kind}</span>
                  <span className="truncate font-mono text-caption text-ink-strong">{symName(s.qname)}</span>
                  <span className="ml-auto truncate font-mono text-micro text-ink-muted">
                    {s.file}:{s.line}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {repo && (hits.data?.files.length ?? 0) > 0 && (
            <CommandGroup heading="Files">
              {hits.data!.files.slice(0, 8).map((f) => (
                <CommandItem key={f.path} value={`file ${f.path}`} onSelect={() => go(repoHref(repo, `/explore?file=${encodeURIComponent(f.path)}`))}>
                  <FileCode className="size-4" aria-hidden />
                  <span className="truncate font-mono text-caption">{f.path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {repo && (
            <CommandGroup heading="Pages">
              {REPO_NAV.filter((n) => !q || n.label.toLowerCase().includes(q.toLowerCase()) || n.blurb.toLowerCase().includes(q.toLowerCase())).map(
                ({ href, label, blurb, Icon }) => (
                  <CommandItem key={href} value={`page ${label}`} onSelect={() => go(repoHref(repo, href))}>
                    <Icon className="size-4" aria-hidden />
                    <span>{label}</span>
                    <span className="ml-auto hidden truncate text-micro text-ink-muted sm:inline">{blurb}</span>
                  </CommandItem>
                ),
              )}
            </CommandGroup>
          )}
          <CommandGroup heading="Repositories">
            {(repos.data?.repos ?? [])
              .filter((r) => !q || r.name.includes(q.toLowerCase()))
              .map((r) => (
                <CommandItem key={r.name} value={`repo ${r.name}`} onSelect={() => go(repoHref(r.name))}>
                  <span className="font-mono text-caption">{r.name}</span>
                  <span className="ml-auto text-micro text-ink-muted">{r.symbols ?? 0} symbols</span>
                </CommandItem>
              ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

/**
 * Settings lives beside Appearance because both answer "how does this behave for me?".
 * It is a link rather than a popover: provider keys are a task with its own page, not a
 * two-click toggle, and a secret field inside a dismissable popover is a way to lose input.
 */
function SettingsLink() {
  const pathname = usePathname();
  const here = pathname.startsWith("/settings");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className={cn("size-8 p-0 text-ink-muted hover:text-ink-strong", here && "text-brand")}
        >
          <Link href="/settings/models" aria-label="Settings" aria-current={here ? "page" : undefined}>
            <Settings className="size-4" aria-hidden />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Settings</TooltipContent>
    </Tooltip>
  );
}

export function TopBar() {
  const pathname = usePathname();
  const repo = useRepo();
  const [menu, setMenu] = useState(false);
  // a tap on a link closes the menu
  useEffect(() => {
    setMenu(false);
  }, [pathname]);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ground/85 backdrop-blur-xl">
      <div className="flex h-[var(--topbar-h)] items-center gap-3 px-3 lg:px-4">
        {repo && (
          <Button
            variant="ghost"
            size="sm"
            className="size-8 shrink-0 p-0 md:hidden"
            onClick={() => setMenu((m) => !m)}
            aria-expanded={menu}
            aria-controls="mobile-nav"
            aria-label={menu ? "Close menu" : "Open menu"}
          >
            {menu ? <X className="size-4" /> : <Menu className="size-4" />}
          </Button>
        )}
        <Logo />
        {repo && (
          <>
            <span className="hidden h-5 w-px shrink-0 bg-line md:block" aria-hidden />
            <RepoSwitcher className="hidden md:flex" />
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <HealthDot />
          <CommandPalette />
          <SettingsLink />
          <Preferences />
        </div>
      </div>
      {menu && repo && (
        <div id="mobile-nav" className="as-in border-t border-line bg-ground/95 px-4 pt-3 pb-4 backdrop-blur-xl md:hidden">
          <RailNav repo={repo} />
          <div className="mt-4 flex items-center gap-2 font-mono text-micro uppercase text-ink-muted">
            Repository <RepoSwitcher className="ml-auto w-[200px]" />
          </div>
        </div>
      )}
    </header>
  );
}
