"use client";

/**
 * The ambient mesh — the "supporting layer behind the content" the design calls
 * for, and the only decorative pixel in the product.
 *
 * WHY A 2D CANVAS AND NOT THREE.JS
 * The source is tagged `webgl, threejs`, and the brief says to rebuild such
 * effects as a layer behind the content, "performant, responsive, and secondary
 * to the interface". The visual is a drifting node mesh: ~60 points and their
 * near-neighbour links. That is a few hundred line segments a frame, which a 2D
 * context draws for free — shipping a WebGL renderer and a scene graph to draw
 * it would add ~600 KB to every route and a GPU context to every tab, for a
 * layer the reader is not supposed to look at. The brief's own ordering
 * (performant, secondary) decides this.
 *
 * WHAT IT COSTS, AND THE FOUR THINGS THAT STOP IT COSTING MORE
 *   1. It does not run at all under reduced motion — a single static frame is
 *      painted instead, so the composition is unchanged but nothing moves.
 *   2. It stops when scrolled out of view (IntersectionObserver) and when the
 *      tab is hidden (visibilitychange). A background tab costs zero frames.
 *   3. Device pixel ratio is capped at 1.5. On a 3× phone this is the
 *      difference between 2M and 500K pixels a frame for a layer at 40% alpha.
 *   4. It is `aria-hidden` and `pointer-events-none`: it cannot be focused,
 *      read, or clicked through to.
 *
 * Colour comes from the token bridge, never a literal, so a re-skin moves it.
 */

import { useEffect, useRef } from "react";

import { color, prefersReducedMotion } from "@/components/ds/tokens";
import { cn } from "@/lib/utils";

type Node = { x: number; y: number; vx: number; vy: number; r: number };

/** Link distance as a fraction of the smaller viewport edge. */
const LINK_RATIO = 0.17;
const MAX_DPR = 1.5;

export function AmbientMesh({
  className,
  density = 1,
  opacity = 0.5,
}: {
  className?: string;
  /** Multiplier on the node count. The hero uses 1; page grounds use ~0.6. */
  density?: number;
  opacity?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const still = prefersReducedMotion();
    const lineColor = color("line-strong");
    const nodeColor = color("ink-faint");
    const hotColor = color("invert-strong");

    let nodes: Node[] = [];
    let w = 0;
    let h = 0;
    let raf = 0;
    let visible = true;
    let running = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Node count scales with area so a phone does not draw a desktop's mesh.
      const count = Math.round(Math.min(72, Math.max(18, (w * h) / 22000)) * density);
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.09,
        vy: (Math.random() - 0.5) * 0.09,
        // A few nodes are "relays" — slightly brighter and larger. They are what
        // gives the field a focal structure instead of reading as noise.
        r: Math.random() < 0.12 ? 2 : 1,
      }));
      draw();
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const link = Math.min(w, h) * LINK_RATIO;

      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > link * link) continue;
          // Links fade with distance, which is what reads as depth.
          ctx.globalAlpha = (1 - Math.sqrt(d2) / link) * 0.55;
          ctx.strokeStyle = lineColor;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      for (const n of nodes) {
        ctx.globalAlpha = n.r > 1 ? 0.5 : 0.28;
        ctx.fillStyle = n.r > 1 ? hotColor : nodeColor;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const tick = () => {
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        // Wrap rather than bounce: a bounce reads as a wall, and the mesh is
        // meant to feel unbounded.
        if (n.x < -4) n.x = w + 4;
        if (n.x > w + 4) n.x = -4;
        if (n.y < -4) n.y = h + 4;
        if (n.y > h + 4) n.y = -4;
      }
      draw();
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running || still) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const sync = () => (visible && !document.hidden ? start() : stop());

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        sync();
      },
      { rootMargin: "80px" },
    );
    io.observe(canvas);
    document.addEventListener("visibilitychange", sync);
    sync();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [density]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 size-full", className)}
      style={{ opacity }}
    />
  );
}

/**
 * The full background stack for a hero or a section ground: mesh over a fading
 * measurement grid, with a vignette so the content above it keeps its contrast.
 * Pages compose this rather than stacking the layers themselves, so there is
 * one definition of "the background" to change.
 */
export function AmbientField({
  className,
  density = 1,
  grid = true,
}: {
  className?: string;
  density?: number;
  grid?: boolean;
}) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      {grid ? <div className="absolute inset-0 bg-grid-fade" /> : null}
      <AmbientMesh density={density} opacity={0.55} />
      {/* The vignette is what keeps body text at its measured contrast ratio
          while the mesh is on. Without it the ratios in DESIGN.md are a lie. */}
      <div className="absolute inset-0 bg-[radial-gradient(90%_70%_at_50%_0%,transparent_0%,var(--color-ground)_85%)]" />
    </div>
  );
}
