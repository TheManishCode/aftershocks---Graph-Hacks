"use client";

/**
 * The shell: one fixed, blurred bar and nothing else. GROUNDTRUTH has no rail —
 * the page is the instrument, the bar is how you move between instruments.
 *
 *   left    the mark, then (inside a repo) the repository switcher
 *   centre  the repo's pages, mono caps, single-key hints; the current one is chartreuse
 *   right   graph health, ⌘K, settings, motion
 *
 * Below xl the page links fold into a full-height sheet behind the menu button.
 * The shell owns no product state; a page gets it by existing at a route.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { FileCode, Menu, Search, Settings, X } from "@/components/icons";
import { REPO_NAV, REPO_NAV_GROUPS, isNavActive, repoHref } from "@/components/shell/nav";
import { useNavKeys } from "@/components/shell/use-nav-keys";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { symName } from "@/lib/format";
import { useDebounced, useModKey, useQuery, useRepo } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------- health */

function Health() {
  const h = useQuery("health", api.health, 20_000);
  const ok = h.data?.ok;
  const label = h.error ? (h.error.status === 503 ? "Graph down" : "API unreachable") : !h.data ? "Checking" : ok ? "Graph online" : "Degraded";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="flex items-center gap-2 py-1 font-mono text-[10px] tracking-[.12em] text-ink-dim uppercase" aria-label={label}>
          <span className={cn("size-[7px]", h.error ? "bg-fail" : !h.data ? "bg-ink-faint" : ok ? "bg-mark" : "bg-warn")} aria-hidden />
          <span className="hidden 2xl:inline">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-[11px]">
        {h.error ? h.error.message : h.data ? `api ${h.data.version} · falkordb ${h.data.falkordb}` : "…"}
      </TooltipContent>
    </Tooltip>
  );
}

/* ---------------------------------------------------------- repo switcher */

function RepoSwitcher({ className }: { className?: string }) {
  const repo = useRepo();
  const router = useRouter();
  const pathname = usePathname();
  const repos = useQuery("repos", api.repos);
  const names = repos.data?.repos.map((r) => r.name) ?? (repo ? [repo] : []);
  const switchTo = (name: string) => {
    // stay on the same page of the other repo; query strings name symbols, so they don't carry over
    const rest = repo ? pathname.slice(repoHref(repo).length) : "";
    router.push(repoHref(name, rest));
  };
  return (
    <Select value={repo || undefined} onValueChange={switchTo}>
      <SelectTrigger size="sm" className={cn("h-8 w-[168px] border-line-loud bg-transparent font-mono text-[11.5px]", className)} aria-label="Repository">
        <SelectValue placeholder="repository" />
      </SelectTrigger>
      {/* popper, not item-aligned: aligning the selected repo over the trigger pushed the others off-screen */}
      <SelectContent position="popper" align="start">
        {names.map((n) => (
          <SelectItem key={n} value={n} className="font-mono text-[12px]">
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ---------------------------------------------------------------- palette */

function Palette() {
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
  const ql = q.toLowerCase();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-2 border border-line-loud px-2.5 font-mono text-[10.5px] tracking-[.1em] text-ink-dim uppercase transition-colors hover:border-mark hover:text-mark"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="sr-only md:not-sr-only">Jump</span>
        <kbd className="hidden font-mono text-[9.5px] text-ink-faint md:inline">{mod === "⌘" ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false} title="Jump to" description="Symbols, files, pages and repositories">
        {/* results come from the graph's own ranking; cmdk's fuzzy filter would re-sort and drop them */}
        <CommandInput placeholder={repo ? `Symbol or file in ${repo}…` : "Repository or page…"} value={text} onValueChange={setText} />
        <CommandList>
          <CommandEmpty>{hits.loading ? "Searching…" : "Nothing matches."}</CommandEmpty>
          {repo && (hits.data?.symbols.length ?? 0) > 0 && (
            <CommandGroup heading="Symbols">
              {hits.data!.symbols.map((s) => (
                <CommandItem key={s.id} value={`sym ${s.id}`} onSelect={() => go(repoHref(repo, `/explore?ref=${encodeURIComponent(s.id)}`))}>
                  <span className="w-14 shrink-0 font-mono text-[9.5px] tracking-[.1em] text-ink-faint uppercase">{s.kind}</span>
                  <span className="truncate font-mono text-[12px] text-ink">{symName(s.qname)}</span>
                  <span className="ml-auto truncate font-mono text-[10.5px] text-ink-dim">
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
                  <span className="truncate font-mono text-[12px]">{f.path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {repo && (
            <CommandGroup heading="Pages">
              {REPO_NAV.filter((n) => !q || n.label.toLowerCase().includes(ql) || n.blurb.toLowerCase().includes(ql)).map(({ href, label, blurb, Icon }) => (
                <CommandItem key={href} value={`page ${label}`} onSelect={() => go(repoHref(repo, href))}>
                  <Icon className="size-4" aria-hidden />
                  <span>{label}</span>
                  <span className="ml-auto hidden truncate text-[11px] text-ink-dim sm:inline">{blurb}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading="Repositories">
            {(repos.data?.repos ?? [])
              .filter((r) => !q || r.name.includes(ql))
              .map((r) => (
                <CommandItem key={r.name} value={`repo ${r.name}`} onSelect={() => go(repoHref(r.name))}>
                  <span className="font-mono text-[12px]">{r.name}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-ink-dim">{r.symbols ?? 0} symbols</span>
                </CommandItem>
              ))}
          </CommandGroup>
          <CommandGroup heading="Settings">
            <CommandItem value="settings models" onSelect={() => go("/settings/models")}>
              <Settings className="size-4" aria-hidden />
              <span>Models &amp; keys</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

/* ----------------------------------------------------------------- motion */

type MotionPref = "full" | "reduced";
const PREFS = "as:prefs";

/** The one appearance preference GROUNDTRUTH keeps. Written to <html>; CSS does the rest. */
function MotionToggle() {
  const [motion, setMotion] = useState<MotionPref>("full");
  useEffect(() => {
    setMotion(document.documentElement.getAttribute("data-motion") === "reduced" ? "reduced" : "full");
  }, []);
  const flip = () => {
    const next: MotionPref = motion === "full" ? "reduced" : "full";
    setMotion(next);
    document.documentElement.setAttribute("data-motion", next);
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) || "{}");
      localStorage.setItem(PREFS, JSON.stringify({ ...p, motion: next }));
    } catch {
      /* private mode — it still applies for this session */
    }
  };
  return (
    <button
      type="button"
      onClick={flip}
      aria-pressed={motion === "reduced"}
      className="hidden font-mono text-[10px] tracking-[.12em] text-ink-dim uppercase hover:text-mark lg:block"
      title="Motion"
    >
      Motion {motion === "full" ? "on" : "off"}
    </button>
  );
}

/* ------------------------------------------------------------------- bar */

function Links({ repo, pathname }: { repo: string; pathname: string }) {
  return (
    <nav aria-label="Pages" className="gt-links hidden min-w-0 xl:flex">
      {REPO_NAV.map((n) => {
        const on = isNavActive(pathname, repo, n.href);
        return (
          <Link key={n.href} href={repoHref(repo, n.href)} aria-current={on ? "page" : undefined} title={n.blurb}>
            {n.label}
            {n.key && <kbd aria-hidden>{n.key}</kbd>}
          </Link>
        );
      })}
    </nav>
  );
}

function MenuSheet({ repo, pathname, onClose }: { repo: string; pathname: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  return (
    <div id="menu-sheet" className="fixed inset-x-0 top-[var(--nav)] bottom-0 z-50 overflow-y-auto bg-deep/97 px-[var(--gutter)] pt-6 pb-10 backdrop-blur-xl xl:hidden">
      {repo && (
        <div className="mb-6 flex items-center gap-3 md:hidden">
          <span className="gt-label">Repository</span>
          <RepoSwitcher className="ml-auto w-[220px]" />
        </div>
      )}
      {repo &&
        REPO_NAV_GROUPS.map((g, gi) => (
          <div key={g.id} className="mb-6">
            <div className="gt-no mb-2">
              {String(gi + 1).padStart(2, "0")} · {g.label}
            </div>
            <div className="gt-ledger">
              {g.items.map((n) => {
                const on = isNavActive(pathname, repo, n.href);
                return (
                  <Link
                    key={n.href}
                    href={repoHref(repo, n.href)}
                    onClick={onClose}
                    data-on={on ? "true" : undefined}
                    aria-current={on ? "page" : undefined}
                    className="gt-row grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <span>
                      <span className="gt-row__name block text-[17px]">{n.label}</span>
                      <span className="mt-0.5 block text-[12.5px] text-ink-dim">{n.blurb}</span>
                    </span>
                    {n.key && <span className="gt-f">{n.key}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      <Link href="/settings/models" onClick={onClose} className="gt-row grid-cols-1 border-t border-line">
        <span className="gt-row__name text-[17px]">Models &amp; keys</span>
      </Link>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const repo = useRepo();
  const pathname = usePathname();
  const [menu, setMenu] = useState(false);
  useNavKeys(repo);
  useEffect(() => setMenu(false), [pathname]);
  const settings = pathname.startsWith("/settings");

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[80] focus:bg-mark focus:px-3 focus:py-2 focus:font-mono focus:text-[11px] focus:tracking-[.1em] focus:text-on-mark focus:uppercase"
      >
        Skip to content
      </a>
      <header className="gt-nav">
        <Link href="/" className="gt-mark text-ink hover:text-mark" aria-label="Aftershock home">
          AFTERSHOCK
        </Link>
        {repo && <RepoSwitcher className="hidden md:flex" />}
        {repo && <Links repo={repo} pathname={pathname} />}
        <div className="ml-auto flex items-center gap-4">
          <Health />
          <MotionToggle />
          <Palette />
          <Link
            href="/settings/models"
            aria-label="Models and keys"
            aria-current={settings ? "page" : undefined}
            className={cn("hidden size-8 place-items-center border border-transparent sm:grid hover:text-mark", settings ? "text-mark" : "text-ink-dim")}
          >
            <Settings className="size-4" aria-hidden />
          </Link>
          {repo && (
            <button
              type="button"
              className="grid size-8 place-items-center border border-line-loud text-ink xl:hidden"
              onClick={() => setMenu((m) => !m)}
              aria-expanded={menu}
              aria-controls="menu-sheet"
              aria-label={menu ? "Close menu" : "Open menu"}
            >
              {menu ? <X className="size-4" /> : <Menu className="size-4" />}
            </button>
          )}
        </div>
      </header>
      {menu && <MenuSheet repo={repo} pathname={pathname} onClose={() => setMenu(false)} />}
      <div key={pathname}>{children}</div>
    </>
  );
}
