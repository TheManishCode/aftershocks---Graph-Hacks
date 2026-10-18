"use client";

/**
 * Entrances and the scramble-in figure.
 *
 * Every hidden start state lives in globals.css behind `html[data-anim="on"]`,
 * which the inline script in layout.tsx sets before anything else. If this file
 * never runs, nothing is hidden. The observer uses a zero threshold so no
 * element is ever too tall to be revealed (app/motion-safety.test.ts).
 */

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

function reduced(): boolean {
  if (typeof window === "undefined") return true;
  return (
    document.documentElement.getAttribute("data-motion") === "reduced" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** True once the element has entered the viewport (and stays true). */
export function useEnter<T extends HTMLElement>(threshold = 0) {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    // A safety net: anything still hidden after 1.6s is shown regardless.
    const t = setTimeout(() => setShown(true), 1600);
    return () => {
      io.disconnect();
      clearTimeout(t);
    };
  }, [threshold]);
  return { ref, shown };
}

/** One block that fades up as it arrives. */
export function Reveal({ children, className, as: Tag = "div" }: { children: React.ReactNode; className?: string; as?: "div" | "section" | "header" }) {
  const { ref, shown } = useEnter<HTMLDivElement>();
  return (
    <Tag ref={ref} className={className} data-reveal={shown ? "in" : ""}>
      {children}
    </Tag>
  );
}

/** A list whose direct children arrive one after another. */
export function Enter({ children, className, as: Tag = "div" }: { children: React.ReactNode; className?: string; as?: "div" | "ul" | "ol" | "dl" }) {
  const { ref, shown } = useEnter<HTMLDivElement>();
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Tag ref={ref as any} className={className} data-enter={shown ? "in" : ""}>
      {children}
    </Tag>
  );
}

const GLYPHS = "0123456789";

/**
 * A figure that resolves digit by digit, like an instrument settling. Only the
 * digits scramble — units, separators and letters hold still — and the final
 * text is what screen readers get from the start.
 */
export function Scramble({ value, className }: { value: string; className?: string }) {
  const { ref, shown } = useEnter<HTMLSpanElement>();
  const [text, setText] = useState(value);
  useEffect(() => {
    if (!shown || reduced()) {
      setText(value);
      return;
    }
    let frame = 0;
    const total = 14;
    let raf = 0;
    const tick = () => {
      frame++;
      const settled = Math.floor((frame / total) * value.length);
      setText(
        [...value]
          .map((ch, i) =>
            i < settled || !/\d/.test(ch) ? ch : GLYPHS[(frame * 7 + i * 3) % 10],
          )
          .join(""),
      );
      if (frame < total) raf = requestAnimationFrame(tick);
      else setText(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shown, value]);
  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      <span aria-hidden>{text}</span>
      <span className="sr-only">{value}</span>
    </span>
  );
}
