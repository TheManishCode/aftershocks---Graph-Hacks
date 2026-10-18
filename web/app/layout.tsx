import type { Metadata } from "next";
import { Instrument_Serif, Inter, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";

import { TopBar } from "@/components/shell/top-bar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

// Inter for UI, JetBrains Mono for code and ids, Instrument Serif italic for page titles (globals.css h1).
const sans = Inter({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const display = Instrument_Serif({ variable: "--font-landing-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: "Aftershock",
  description: "What breaks if I change this? Code dependency analysis on a FalkorDB graph, with the evidence for every answer.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable} ${display.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <TooltipProvider delayDuration={200}>
          <Suspense>
            <TopBar />
            {children}
          </Suspense>
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </body>
    </html>
  );
}
