"use client";

/**
 * Appearance preferences — theme, density and motion.
 *
 * All three are plain attributes on <html>, so CSS alone responds to them and
 * no component needs to know a preference exists. The inline script in
 * app/layout.tsx applies the persisted values before first paint; this file is
 * the only thing that writes them.
 *
 * Density is not a cosmetic toggle: an engineer triaging a 400-symbol blast
 * radius wants compact rows, and the same person demoing it wants comfortable.
 * Shipping both is cheaper than arguing about one.
 */

import { useEffect, useState } from "react";

import { Moon, Sliders, Sun } from "@/components/icons";
import { Segmented } from "@/components/ds/primitives";
import { clearColorCache } from "@/components/ds/tokens";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const KEY = "as:prefs";

export type Theme = "dark" | "light";
export type Density = "comfortable" | "compact";
export type Motion = "full" | "reduced";

export interface Prefs {
  theme: Theme;
  density: Density;
  motion: Motion;
}

const DEFAULTS: Prefs = { theme: "dark", density: "comfortable", motion: "full" };

function read(): Prefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

function apply(p: Prefs) {
  const r = document.documentElement;
  r.classList.toggle("dark", p.theme === "dark");
  if (p.theme === "light") r.setAttribute("data-theme", "light");
  else r.removeAttribute("data-theme");
  r.setAttribute("data-density", p.density);
  r.setAttribute("data-motion", p.motion);
  // canvas and SVG colours are resolved from the stylesheet and cached
  clearColorCache();
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode — the session still works, it just will not persist */
  }
}

/** Read/write the preference triple. Returns defaults until mounted, to keep SSR stable. */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  useEffect(() => setPrefs(read()), []);
  const set = (patch: Partial<Prefs>) =>
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      apply(next);
      return next;
    });
  return { prefs, set };
}

export function Preferences() {
  const { prefs, set } = usePrefs();
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="size-8 p-0 text-ink-muted hover:text-ink-strong" aria-label="Appearance">
              <Sliders className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Appearance</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 space-y-3.5 p-3.5">
        <Row label="Theme">
          <Segmented
            label="Theme"
            size="sm"
            value={prefs.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { value: "dark", label: <Moon className="size-3.5" aria-hidden />, title: "Dark" },
              { value: "light", label: <Sun className="size-3.5" aria-hidden />, title: "Light" },
            ]}
          />
        </Row>
        <Row label="Density" hint="Row height and panel padding across every table.">
          <Segmented
            label="Density"
            size="sm"
            value={prefs.density}
            onChange={(density) => set({ density })}
            options={[
              { value: "comfortable", label: "Cozy" },
              { value: "compact", label: "Dense" },
            ]}
          />
        </Row>
        <Row label="Motion" hint="Reduced also follows your system setting by default.">
          <Segmented
            label="Motion"
            size="sm"
            value={prefs.motion}
            onChange={(motion) => set({ motion })}
            options={[
              { value: "full", label: "Full" },
              { value: "reduced", label: "Reduced" },
            ]}
          />
        </Row>
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-micro uppercase text-ink-muted">{label}</span>
        {children}
      </div>
      {hint && <p className="text-caption leading-snug text-ink-faint">{hint}</p>}
    </div>
  );
}
