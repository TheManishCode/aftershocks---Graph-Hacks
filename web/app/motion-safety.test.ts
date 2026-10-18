/**
 * Guards the one UI failure mode that every other check is blind to.
 *
 * The entrance animations work by painting an element at `opacity: 0` and
 * revealing it when an IntersectionObserver fires. If anything stops that
 * second half happening — scripting off, a blocked bundle, a hydration error,
 * an unreachable threshold — the content stays invisible permanently. The
 * route still returns 200, the text is still in the DOM and still in the
 * accessibility tree, and a screenshot is the only thing that would notice.
 * This repository shipped exactly that bug once; these tests are why it
 * cannot ship twice.
 *
 * They read the source rather than a browser on purpose: the invariant is
 * "no hidden state exists outside the gate", which is a property of the
 * stylesheet, and jsdom computes no cascade worth asserting against.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

const GATE = 'html[data-anim="on"]';

/** Strips comments so prose about `opacity: 0` is not mistaken for a rule. */
function rulesWithHiddenStart(css: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  // Selector(s) followed by a block containing an `opacity: 0` resting state.
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = m;
    if (!/opacity:\s*0\s*[;}]/.test(body)) continue;
    // A keyframe step is a from/to/percentage, not a resting state, and an
    // animation always runs to completion on its own.
    if (/^\s*(from|to|\d+%)\s*$/.test(selector)) continue;
    out.push(selector.trim().replace(/\s+/g, " "));
  }
  return out;
}

describe("entrance animations cannot strand content invisible", () => {
  const css = read("globals.css");

  it("puts every hidden resting state behind the scripting gate", () => {
    const ungated = rulesWithHiddenStart(css).filter((sel) =>
      // `data-enter`/`data-reveal` are the hiding mechanisms. Anything else
      // using opacity:0 (a hover wash, a focus ring) reveals itself without
      // needing JavaScript and is not in scope.
      /\[data-(enter|reveal)\]?/.test(sel) && !sel.includes(GATE),
    );
    expect(ungated).toEqual([]);
  });

  it("resolves the shown state at the same specificity as the hidden one", () => {
    // `[data-enter="in"]` is (0,1,0) and would silently lose to a gated
    // (0,2,1) start state, leaving the element hidden after the observer
    // fired — the same blank page by a subtler route.
    for (const attr of ["data-enter", "data-reveal"]) {
      expect(css).toContain(`${GATE} [${attr}="in"]`);
    }
  });

  it("arms the gate before reading preferences, so a storage throw cannot blank the page", () => {
    const layout = read("layout.tsx");
    const setsGate = layout.indexOf('setAttribute("data-anim","on")');
    const opensTry = layout.indexOf("try{");
    expect(setsGate).toBeGreaterThan(-1);
    // Inside or after the try/catch, a localStorage throw in private mode
    // would skip the assignment while the stylesheet still hides everything.
    expect(setsGate).toBeLessThan(opensTry);
  });
});

describe("the entrance observer can always fire", () => {
  const motion = read(join("..", "components", "motion.tsx"));

  it("uses a zero threshold, which no element height can outgrow", () => {
    // intersectionRatio is visible area / total area, so an element taller
    // than 1/threshold viewports never reaches a fractional threshold and
    // never becomes visible. Depth tuning belongs in rootMargin.
    const thresholds = [...motion.matchAll(/useEnter<[^>]*>\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      // The declaration itself writes a default (`threshold = 0`); it is
      // asserted separately below. Only call sites are of interest here.
      .filter((t) => !t.includes("="));
    expect(thresholds.length).toBeGreaterThan(0);
    for (const t of thresholds) {
      expect(["", "threshold", "0"]).toContain(t);
    }
    expect(motion).toMatch(/useEnter<T extends HTMLElement>\(threshold = 0\)/);
  });

  it("renders the hiding attribute from the first paint", () => {
    // Omitting the attribute until shown means the transition has no start
    // state and the entrance silently does nothing.
    expect(motion).toContain('data-enter={shown ? "in" : ""}');
    expect(motion).toContain('data-reveal={shown ? "in" : ""}');
  });
});
