"use client";

/**
 * The application shell: top bar + rail + content region.
 *
 * Two layouts, chosen by route, because the product genuinely has two:
 *   /          — the index/landing route. Full bleed, no rail; there is no
 *                repository in scope yet, so a repo rail would be empty chrome.
 *   /r/<repo>  — the workspace. Rail on the left, scrolling content on the right.
 *
 * The shell owns no product state. It reads the repo from the URL (useRepo) and
 * the collapsed flag from localStorage. A new page gets the shell for free by
 * existing at a route; it never imports anything from this file.
 */

import { usePathname } from "next/navigation";

import { Rail, useRailCollapsed } from "@/components/shell/rail";
import { TopBar } from "@/components/shell/top-bar";
import { useNavKeys } from "@/components/shell/use-nav-keys";
import { useRepo } from "@/lib/hooks";

export function AppShell({ children }: { children: React.ReactNode }) {
  const repo = useRepo();
  const pathname = usePathname();
  const { collapsed, toggle } = useRailCollapsed();
  useNavKeys(repo);

  // Routes that render their own full-bleed canvas (the landing page).
  const bare = !repo;

  return (
    <div className="flex min-h-svh flex-col">
      {/* Keyboard users land here first; the rail and content both have anchors. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-brand-solid focus:px-3 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>
      <TopBar />
      {bare ? (
        <main id="content" className="flex-1">
          {children}
        </main>
      ) : (
        <div className="flex flex-1 items-start">
          <Rail repo={repo} collapsed={collapsed} onToggle={toggle} />
          <main id="content" key={pathname} className="as-in min-w-0 flex-1">
            {children}
          </main>
        </div>
      )}
    </div>
  );
}
