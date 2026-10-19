/**
 * The navigation registry — the single place a page is declared.
 *
 * Nav is grouped rather than flat because a flat list stops working at about a
 * dozen entries, and this product will keep growing questions it can answer.
 * Groups give new pages a home that does not require redesigning the rail:
 *
 *   Answer     — "what breaks?" The questions a reviewer opens the tool for.
 *   Understand — reading the graph itself: structure, tests, history.
 *   Build      — the escape hatches: free-form queries, raw Cypher.
 *
 * To add a page: add one entry here. The rail, the mobile nav, the command
 * palette and the overview's quick cards all read from this file, so nothing
 * else needs touching.
 */
import { Bento, Bot, Bug, Clock, Database, Flow, Search, GitDiff, TestTube, Zap, type Icon } from "@/components/icons";

export interface NavItem {
  /** Relative to `/r/<repo>`. The empty string is the repo root. */
  href: string;
  label: string;
  Icon: Icon;
  /** One line, shown in the rail tooltip, the palette and the overview cards. */
  blurb: string;
  /** Single key that jumps here when pressed with no modifier (see use-nav-keys). */
  key?: string;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const REPO_NAV_GROUPS: NavGroup[] = [
  {
    id: "answer",
    label: "Answer",
    items: [
      { href: "", label: "Overview", Icon: Bento, blurb: "Shape of the graph: subsystems, hotspots, debt.", key: "o" },
      { href: "/impact", label: "Impact", Icon: Zap, blurb: "Change a symbol, see the blast radius with evidence.", key: "i" },
      { href: "/diff", label: "Diff", Icon: GitDiff, blurb: "Score a working diff before you open the PR.", key: "d" },
      { href: "/culprit", label: "Culprit", Icon: Bug, blurb: "A test broke — rank the changes that could explain it.", key: "c" },
    ],
  },
  {
    id: "understand",
    label: "Understand",
    items: [
      { href: "/path", label: "Path", Icon: Flow, blurb: "How does A reach B? Hop-by-hop, with resolution.", key: "p" },
      { href: "/tests", label: "Tests", Icon: TestTube, blurb: "What covers this, and what is uncovered.", key: "t" },
      { href: "/runs", label: "Runs", Icon: Clock, blurb: "Every recorded test run; open one for its graph, culprit and fix.", key: "r" },
      { href: "/explore", label: "Explore", Icon: Search, blurb: "Walk symbols, files, callers and callees.", key: "e" },
    ],
  },
  {
    id: "build",
    label: "Build",
    items: [
      { href: "/ask", label: "Ask", Icon: Bot, blurb: "Natural language over the graph, answers with receipts.", key: "a" },
      { href: "/cypher", label: "Cypher", Icon: Database, blurb: "Raw read-only Cypher against FalkorDB.", key: "y" },
    ],
  },
];

/** Flat view, in rail order. Kept for the palette and anything that just wants a list. */
export const REPO_NAV: NavItem[] = REPO_NAV_GROUPS.flatMap((g) => g.items);

export const repoHref = (repo: string, href = "") => `/r/${encodeURIComponent(repo)}${href}`;

/**
 * Is `href` the active page for `pathname`? The repo root matches exactly;
 * everything else matches its own prefix, so `/impact/anything` stays lit.
 */
export function isNavActive(pathname: string, repo: string, href: string): boolean {
  const base = repoHref(repo);
  return href === "" ? pathname === base || pathname === `${base}/` : pathname.startsWith(base + href);
}
