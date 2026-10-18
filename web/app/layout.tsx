import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

/**
 * Two faces, which is the whole typographic system (see DESIGN.md §Typography):
 *
 *   Inter          → display only. Hero, section titles, large metric readouts.
 *   JetBrains Mono → everything else, including body prose.
 *
 * The split is inverted from the usual arrangement on purpose, and it carries
 * meaning rather than style: in Aftershock almost every string on screen is a
 * path, a symbol id, a count or a duration, so the machine face is the default
 * and Inter marks the handful of places a person is speaking. A reader can tell
 * the product's words from the graph's output without reading either.
 *
 * Inter is loaded at 500 only — the display weight the source specifies — so
 * there is no way to reach for 700 and break the "weights stop at 600" rule.
 */
const mono = JetBrains_Mono({ variable: "--font-ui-mono", subsets: ["latin"], display: "swap" });
const display = Inter({
  variable: "--font-ui-display",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Aftershock", template: "%s · Aftershock" },
  description:
    "What breaks if I change this? Code dependency analysis on a FalkorDB graph, with the evidence for every answer.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${mono.variable} ${display.variable}`}
      /* Runtime switches live on <html> so CSS alone can respond to them; the
         preference reader in components/shell/preferences.tsx only writes here. */
      data-density="comfortable"
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-ground font-mono antialiased">
        {/* Applies the persisted density/motion before first paint, so the shell
            never flashes the default skin. Must stay inline and tiny.

            It also sets `data-anim="on"`, which is what licenses every
            `opacity: 0` entrance state in globals.css. That assignment is
            deliberately outside the try/catch and first: a thrown
            localStorage (private mode, blocked storage) must not be able to
            leave the document in a state where the animations are armed but
            the attribute saying "scripting works" is missing — the page would
            render blank. Set the gate, then read preferences. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `var r=document.documentElement;r.setAttribute("data-anim","on");try{var p=JSON.parse(localStorage.getItem("as:prefs")||"{}");if(p.theme==="light"){r.setAttribute("data-theme","light");r.classList.remove("dark")}if(p.density)r.setAttribute("data-density",p.density);if(p.motion)r.setAttribute("data-motion",p.motion)}catch(e){}`,
          }}
        />
        <TooltipProvider delayDuration={200}>
          <Suspense>
            <AppShell>{children}</AppShell>
          </Suspense>
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </body>
    </html>
  );
}
