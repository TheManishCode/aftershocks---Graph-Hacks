import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

/**
 * Four faces, each with exactly one job (see DESIGN.md §Typography):
 *   Barlow Condensed → display. Headings and big metric readouts. Condensed buys
 *                      ~20% more characters per line, which is what lets a fully
 *                      qualified symbol name sit in a page title without truncating.
 *   Inter            → UI and prose.
 *   JetBrains Mono   → code, ids, paths, numbers, technical labels.
 *   Instrument Serif → the landing page's editorial lines only. Never in the app.
 */
const sans = Inter({ variable: "--font-ui-sans", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-ui-mono", subsets: ["latin"], display: "swap" });
const display = Barlow_Condensed({
  variable: "--font-ui-display",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});
const editorial = Instrument_Serif({
  variable: "--font-ui-editorial",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Aftershock", template: "%s · Aftershock" },
  description:
    "What breaks if I change this? Code dependency analysis on a FalkorDB graph, with the evidence for every answer.",
};

export const viewport: Viewport = {
  themeColor: "#070a08",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${sans.variable} ${mono.variable} ${display.variable} ${editorial.variable}`}
      /* Runtime switches live on <html> so CSS alone can respond to them; the
         preference reader in components/shell/preferences.tsx only writes here. */
      data-density="comfortable"
      suppressHydrationWarning
    >
      <body className="min-h-screen font-sans antialiased">
        {/* Applies the persisted theme/density/motion before first paint, so the
            shell never flashes the default skin. Must stay inline and tiny. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var p=JSON.parse(localStorage.getItem("as:prefs")||"{}");var r=document.documentElement;if(p.theme==="light"){r.setAttribute("data-theme","light");r.classList.remove("dark")}if(p.density)r.setAttribute("data-density",p.density);if(p.motion)r.setAttribute("data-motion",p.motion)}catch(e){}`,
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
