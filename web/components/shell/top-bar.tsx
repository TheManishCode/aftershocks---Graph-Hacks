"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { FileCode, Menu, Pulse, Search, X } from "@/components/icons";
import { REPO_NAV, repoHref } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useDebounced, useQuery, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { symName } from "@/lib/format";

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 text-base font-medium tracking-[-0.012em] text-paper" aria-label="Aftershock home">
      <span className="grid size-6 place-items-center rounded-md bg-paper text-void">
        <Pulse className="size-4" aria-hidden />
      </span>
      <span className="hidden sm:inline">Aftershock</span>
    </Link>
  );
}

function HealthDot() {
  const h = useQuery("health", api.health, 20_000);
  const ok = h.data?.ok;
  const label = h.error ? (h.error.status === 503 ? "Graph down" : "API unreachable") : !h.data ? "Checking…" : ok ? "Graph online" : "Degraded";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent" aria-label={label}>
          <span className={cn("size-2 rounded-full", h.error ? "bg-st-refuted" : !h.data ? "bg-muted-foreground" : ok ? "bg-st-confirmed" : "bg-ov-missed")} />
          <span className="hidden xl:inline">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-xs">
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
      <SelectTrigger size="sm" className={cn("h-8 w-[170px] font-mono text-xs", className)} aria-label="Repository">
        <SelectValue placeholder="repository" />
      </SelectTrigger>
      <SelectContent>
        {names.map((n) => (
          <SelectItem key={n} value={n} className="font-mono text-xs">
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
      <Button variant="outline" size="sm" className="h-8 gap-2 text-fog" onClick={() => setOpen(true)}>
        <Search className="size-3.5" aria-hidden />
        <span className="sr-only md:not-sr-only">Jump to…</span>
        <kbd className="hidden rounded-sm bg-white/5 px-1 font-mono text-[10px] text-fog md:inline">⌘K</kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false} title="Jump to" description="Symbols, files, pages and repositories">
        {/* results come from the graph's own ranking; cmdk's fuzzy filter would re-sort and drop them */}
        <CommandInput placeholder={repo ? `Symbol or file in ${repo}…` : "Repository or page…"} value={text} onValueChange={setText} />
        <CommandList>
          <CommandEmpty>{hits.loading ? "Searching…" : "Nothing matches."}</CommandEmpty>
          {repo && (hits.data?.symbols.length ?? 0) > 0 && (
            <CommandGroup heading="Symbols">
              {hits.data!.symbols.map((s) => (
                <CommandItem key={s.id} value={`sym ${s.id}`} onSelect={() => go(repoHref(repo, `/explore?ref=${encodeURIComponent(s.id)}`))}>
                  <span className="w-14 shrink-0 font-mono text-[10px] text-fog uppercase">{s.kind}</span>
                  <span className="truncate font-mono text-xs text-paper">{symName(s.qname)}</span>
                  <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{s.file}:{s.line}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {repo && (hits.data?.files.length ?? 0) > 0 && (
            <CommandGroup heading="Files">
              {hits.data!.files.slice(0, 8).map((f) => (
                <CommandItem key={f.path} value={`file ${f.path}`} onSelect={() => go(repoHref(repo, `/explore?file=${encodeURIComponent(f.path)}`))}>
                  <FileCode className="size-4" aria-hidden />
                  <span className="truncate font-mono text-xs">{f.path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {repo && (
            <CommandGroup heading="Pages">
              {REPO_NAV.filter((n) => !q || n.label.toLowerCase().includes(q.toLowerCase())).map(({ href, label, Icon }) => (
                <CommandItem key={href} value={`page ${label}`} onSelect={() => go(repoHref(repo, href))}>
                  <Icon className="size-4" aria-hidden /> {label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Repositories">
            {(repos.data?.repos ?? [])
              .filter((r) => !q || r.name.includes(q.toLowerCase()))
              .map((r) => (
                <CommandItem key={r.name} value={`repo ${r.name}`} onSelect={() => go(repoHref(r.name))}>
                  <span className="font-mono text-xs">{r.name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{r.symbols ?? 0} symbols</span>
                </CommandItem>
              ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
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
  const base = repo ? repoHref(repo) : "";
  const isActive = (href: string) => (href === "" ? pathname === base : pathname.startsWith(base + href));
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-void/85 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-4 px-4 lg:px-6">
        <Logo />
        {repo && (
          <nav className="hidden items-center gap-0.5 md:flex" aria-label="Repository">
            {REPO_NAV.map(({ href, label, Icon }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={repoHref(repo, href)}
                  aria-current={active ? "page" : undefined}
                  aria-label={label}
                  className={cn(
                    "relative flex h-14 items-center gap-1.5 px-2 text-[13px] text-fog transition-colors hover:text-mist lg:px-2.5",
                    active && "text-paper after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-gold",
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  <span className="hidden lg:inline">{label}</span>
                </Link>
              );
            })}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">
          <HealthDot />
          <CommandPalette />
          <RepoSwitcher className="hidden md:flex" />
          {repo && (
            <Button variant="ghost" size="sm" className="size-8 p-0 md:hidden" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="mobile-nav" aria-label={menu ? "Close menu" : "Open menu"}>
              {menu ? <X className="size-4" /> : <Menu className="size-4" />}
            </Button>
          )}
        </div>
      </div>
      {menu && repo && (
        <div id="mobile-nav" className="epi-in border-t border-border bg-void/95 px-4 pt-2 pb-4 backdrop-blur-xl md:hidden">
          <nav className="grid grid-cols-2 gap-1" aria-label="Repository">
            {REPO_NAV.map(({ href, label, Icon }) => (
              <Link key={href} href={repoHref(repo, href)} aria-current={isActive(href) ? "page" : undefined}
                className={cn("flex items-center gap-2 rounded-md px-3 py-2.5 text-sm text-fog hover:bg-accent hover:text-mist", isActive(href) && "bg-accent text-paper")}>
                <Icon className="size-4" aria-hidden /> {label}
              </Link>
            ))}
          </nav>
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            Repository <RepoSwitcher className="ml-auto w-[200px]" />
          </div>
        </div>
      )}
    </header>
  );
}
