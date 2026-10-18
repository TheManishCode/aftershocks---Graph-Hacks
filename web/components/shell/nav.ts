import { Bento, Bot, Bug, Database, Flow, GitDiff, Search, Zap } from "@/components/icons";

/** Per-repo pages, in the order a reviewer reaches for them. `href` is relative to `/r/<repo>`. */
export const REPO_NAV = [
  { href: "", label: "Overview", Icon: Bento },
  { href: "/impact", label: "Impact", Icon: Zap },
  { href: "/diff", label: "Diff", Icon: GitDiff },
  { href: "/path", label: "Path", Icon: Flow },
  { href: "/culprit", label: "Culprit", Icon: Bug },
  { href: "/ask", label: "Ask", Icon: Bot },
  { href: "/explore", label: "Explore", Icon: Search },
  { href: "/cypher", label: "Cypher", Icon: Database },
];

export const repoHref = (repo: string, href = "") => `/r/${encodeURIComponent(repo)}${href}`;
