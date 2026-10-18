"use client";

import Link from "next/link";
import { useEffect } from "react";

import { ErrorNote } from "@/components/ds";
import { Button } from "@/components/ui/button";

/**
 * A page under a repository crashed while rendering. The repo navigation stays
 * up, because the failure is almost always one view's data and not the graph —
 * sending the reader back to the root would cost them their place for nothing.
 */
export default function RepoError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-16">
      <h1 className="text-subheading text-ink-strong">This view hit an error</h1>
      <ErrorNote error={error.message || "Something went wrong while rendering this page."} onRetry={reset} />
      {error.digest && <p className="font-mono text-micro text-ink-faint">digest {error.digest}</p>}
      <Button asChild variant="outline" size="sm">
        <Link href="/">Back to repositories</Link>
      </Button>
    </div>
  );
}
