"use client";

/**
 * The left rail — primary navigation.
 *
 * Why a rail and not a top nav: nine pages already crowd a horizontal bar at
 * 1280px (the old one hid its labels below `lg`), and the product keeps adding
 * questions it can answer. A rail is vertical, so it grows down the page
 * instead of competing for the same row as the repo switcher and the search.
 * Groups keep it scannable past a dozen entries.
 *
 * Collapsed state is a user preference, persisted, and is also what the
 * narrower desktop widths default to. Collapsed, the rail is icons with
 * tooltips and keeps the 44px hit target.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Sidebar } from "@/components/icons";
import { Eyebrow } from "@/components/ds/primitives";
import { isNavActive, REPO_NAV_GROUPS, repoHref, type NavItem } from "@/components/shell/nav";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const KEY = "as:rail";

/** Collapsed/expanded, persisted. Defaults to expanded on first visit. */
export function useRailCollapsed() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  return { collapsed, toggle };
}

function RailLink({ item, repo, collapsed }: { item: NavItem; repo: string; collapsed: boolean }) {
  const pathname = usePathname();
  const active = isNavActive(pathname, repo, item.href);
  const link = (
    <Link
      href={repoHref(repo, item.href)}
      aria-current={active ? "page" : undefined}
      data-hit
      className={cn(
        "group relative flex items-center gap-2.5 rounded-control py-1.5 text-body-sm transition-colors duration-[var(--dur-fast)]",
        collapsed ? "justify-center px-0" : "px-2.5",
        active ? "bg-brand/[0.1] text-ink-strong" : "text-ink-muted hover:bg-accent hover:text-ink",
      )}
    >
      {/* the active marker is a bar in the gutter, not a fill — it survives the
          collapsed rail and reads at a glance down the column */}
      <span
        aria-hidden
        className={cn(
          "absolute top-1/2 -left-2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand transition-opacity duration-[var(--dur-fast)]",
          active ? "opacity-100" : "opacity-0",
        )}
      />
      <item.Icon className={cn("size-4 shrink-0", active && "text-brand")} aria-hidden />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {collapsed && <span className="sr-only">{item.label}</span>}
    </Link>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-56">
        <span className="font-medium">{item.label}</span>
        <span className="mt-0.5 block text-ink-muted">{item.blurb}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function RailNav({ repo, collapsed = false, className }: { repo: string; collapsed?: boolean; className?: string }) {
  return (
    <nav className={cn("flex flex-col gap-4", className)} aria-label="Repository">
      {REPO_NAV_GROUPS.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          {collapsed ? (
            <span className="mx-auto mb-1 h-px w-5 bg-line" aria-hidden />
          ) : (
            <Eyebrow className="px-2.5 pb-1">{group.label}</Eyebrow>
          )}
          {group.items.map((item) => (
            <RailLink key={item.href} item={item} repo={repo} collapsed={collapsed} />
          ))}
        </div>
      ))}
    </nav>
  );
}

export function Rail({ repo, collapsed, onToggle }: { repo: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <aside
      className="sticky top-[var(--topbar-h)] hidden h-[calc(100svh-var(--topbar-h))] shrink-0 border-r border-line bg-base/60 md:flex md:flex-col"
      style={{ width: collapsed ? "var(--rail-w-collapsed)" : "var(--rail-w)" }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <RailNav repo={repo} collapsed={collapsed} />
      </div>
      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-hit
          className={cn(
            "flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-body-sm text-ink-muted transition-colors hover:bg-accent hover:text-ink",
            collapsed && "justify-center px-0",
          )}
        >
          <Sidebar className={cn("size-4 shrink-0", collapsed && "rotate-180")} aria-hidden />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
