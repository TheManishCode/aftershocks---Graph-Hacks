import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";

import { Shell } from "@/components/shell/shell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

/**
 * GROUNDTRUTH type: a neo-grotesk for what a person says (titles, names, prose)
 * and a mono for what the instrument reads out (labels, paths, figures). Inter
 * stands in where Helvetica Neue is not installed.
 */
const mono = JetBrains_Mono({ variable: "--font-ui-mono", subsets: ["latin"], display: "swap" });
const display = Inter({ variable: "--font-ui-display", subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Aftershock", template: "%s · Aftershock" },
  description: "What breaks if I change this? Code dependency analysis on a FalkorDB graph, with the evidence for every answer.",
};

export const viewport: Viewport = {
  themeColor: "#4e5050",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${mono.variable} ${display.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-void font-sans text-ink antialiased">
        {/* Must stay inline, tiny and first. `data-anim="on"` is what licenses
            every hidden entrance state in globals.css, so it is set before the
            try: a throwing localStorage must never leave animations armed
            without the flag that says scripting works. Then the motion pref. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `var r=document.documentElement;r.setAttribute("data-anim","on");try{var p=JSON.parse(localStorage.getItem("as:prefs")||"{}");if(p.motion)r.setAttribute("data-motion",p.motion)}catch(e){}`,
          }}
        />
        <TooltipProvider delayDuration={200}>
          <Suspense>
            <Shell>{children}</Shell>
          </Suspense>
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </body>
    </html>
  );
}
