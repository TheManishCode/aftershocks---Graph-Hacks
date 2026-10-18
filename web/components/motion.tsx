"use client";

/**
 * The motion primitives, which are the four cues the design brief names:
 * masked reveal, staggered entrance, scroll-triggered transition, hover lift.
 * (Hover lift and the stagger are pure CSS — `.as-lift` and `.as-stagger` in
 * globals.css. The two here need an observer, so they need a component.)
 *
 * There is exactly one IntersectionObserver implementation in the product, and
 * it lives in `useEnter` below. A page that writes its own observer is a page
 * whose motion drifts from everything else, and on a long route the duplicate
 * observers are a real scroll cost.
 *
 * Reduced motion is handled in CSS, not here: `[data-enter]`/`[data-reveal]`
 * collapse to their final state under `prefers-reduced-motion` and under
 * `data-motion="reduced"`.
 *
 * THE INVISIBLE-CONTENT FAILURE MODE, AND WHAT ACTUALLY PREVENTS IT
 * These components hide their children until an observer fires, so anything
 * that stops the observer firing is a blank page that still returns HTTP 200
 * and still has all its text in the DOM and the accessibility tree. It is a
 * bug no status code and no DOM assertion can see.
 *
 * What prevents it is not this file. It is the `html[data-anim="on"]` gate in
 * globals.css: the `opacity: 0` start states only exist once the inline script
 * in app/layout.tsx has run, and that script only runs when scripting works.
 * No JS, a blocked bundle, a hydration failure — the attribute is absent, the
 * start state never matches, and the content is simply visible with no
 * animation. Do not remove the empty-string attribute below without reading
 * that gate: `data-enter` must be present from the first render for the
 * transition to have a start state to animate from.
 */

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Marks an element "in" the first time it crosses into view, and then stops
 * observing it. Entrances do not replay on scroll-back — a section that
 * re-animates every time you pass it is noise, not rhythm.
 *
 * `threshold` defaults to 0, not to a fraction, and that is a correctness
 * choice rather than a taste one. `intersectionRatio` is visible area over
 * *total* area, so an element taller than 1/threshold viewports can never
 * reach a fractional threshold: at 0.15 anything over ~6.7 screens tall never
 * fires, stays at `opacity: 0`, and is invisible forever. Since these elements
 * hide their own content, that cliff is a blank section, not a missing
 * flourish. The "how far in" tuning belongs in `rootMargin`, which is measured
 * against the viewport and has no such ceiling.
 */
export function useEnter<T extends HTMLElement>(threshold = 0) {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        setShown(true);
        io.disconnect();
      },
      { threshold, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, threshold]);

  return { ref, shown };
}

/**
 * A scroll-triggered section. `index` staggers siblings against each other via
 * the `--i` custom property the CSS reads.
 */
export function Enter({
  children,
  index = 0,
  threshold,
  as: Tag = "div",
  className,
}: {
  children: React.ReactNode;
  index?: number;
  threshold?: number;
  as?: "div" | "section" | "li" | "article";
  className?: string;
}) {
  const { ref, shown } = useEnter<HTMLElement>(threshold);
  return (
    // `as` can be any of four elements, so the ref is widened to HTMLElement
    // and cast once here rather than making the whole component generic for
    // the sake of a ref nothing outside reads.
    <Tag
      ref={ref as React.Ref<never>}
      data-enter={shown ? "in" : ""}
      style={{ "--i": index } as React.CSSProperties}
      className={className}
    >
      {children}
    </Tag>
  );
}

/**
 * A masked reveal: each line rises out of its own clip box, staggered.
 *
 * Takes `lines` as an array rather than a single string, because the mask has
 * to be per-line and only the caller knows where the breaks belong. The whole
 * phrase is exposed to assistive tech as one string via `aria-label`, and the
 * per-line spans are `aria-hidden` — otherwise a screen reader announces a
 * headline as several unrelated fragments.
 */
export function Reveal({
  lines,
  as: Tag = "h1",
  className,
  lineClassName,
  delay = 0,
}: {
  lines: string[];
  as?: "h1" | "h2" | "p" | "div";
  className?: string;
  lineClassName?: string;
  /** Stagger offset in steps, for a second block that should follow the first. */
  delay?: number;
}) {
  const { ref, shown } = useEnter<HTMLElement>();
  return (
    <Tag
      ref={ref as React.Ref<never>}
      data-reveal={shown ? "in" : ""}
      className={className}
      aria-label={lines.join(" ")}
    >
      {lines.map((line, i) => (
        <span key={i} className={cn("rv-mask", lineClassName)} aria-hidden>
          <span className="rv-l" style={{ "--i": i + delay } as React.CSSProperties}>
            {line}
          </span>
        </span>
      ))}
    </Tag>
  );
}
