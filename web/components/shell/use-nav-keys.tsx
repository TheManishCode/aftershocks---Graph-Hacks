"use client";

/**
 * Single-key page jumps (`i` → Impact, `d` → Diff, …), declared in nav.ts.
 *
 * This is a power-user affordance for a tool people live in during a review.
 * It deliberately does nothing while a text field, textarea, contenteditable
 * or any modifier key is active — otherwise typing a symbol name into the
 * Cypher box would navigate away mid-word.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { REPO_NAV, repoHref } from "@/components/shell/nav";

const isTyping = (el: EventTarget | null): boolean => {
  const n = el as HTMLElement | null;
  if (!n) return false;
  const tag = n.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || n.isContentEditable === true;
};

export function useNavKeys(repo: string) {
  const router = useRouter();
  useEffect(() => {
    if (!repo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const hit = REPO_NAV.find((n) => n.key && n.key === e.key.toLowerCase());
      if (!hit) return;
      e.preventDefault();
      router.push(repoHref(repo, hit.href));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [repo, router]);
}
