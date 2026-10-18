"use client";

import Link from "next/link";
import { useEffect } from "react";

import { ErrorNote } from "@/components/ds";
import { Button } from "@/components/ui/button";

/**
 * A top-level page crashed while rendering: keep the shell, say what happened,
 * offer a retry.
 *
 * A <div>, not a <main>: the shell already owns the single `<main id="content">`,
 * and this renders inside it.
 */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-16">
      <h1 className="text-subheading text-ink-strong">This page hit an error</h1>
      <ErrorNote error={error.message || "Something went wrong while rendering this page."} onRetry={reset} />
      {/* The digest is the only handle on the server-side stack trace, so it is
          shown rather than swallowed — without it a bug report is unactionable. */}
      {error.digest && <p className="font-mono text-micro text-ink-faint">digest {error.digest}</p>}
      <Button asChild variant="outline" size="sm">
        <Link href="/">Back to repositories</Link>
      </Button>
    </div>
  );
}
