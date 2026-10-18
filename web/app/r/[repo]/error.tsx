"use client";

import Link from "next/link";
import { useEffect } from "react";

import { ErrorNote, Head, Page } from "@/components/gt";
import { Button } from "@/components/ui/button";

/** A view under a repository crashed. The nav stays up: the failure is almost always one view's data, not the graph. */
export default function RepoError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <Page className="max-w-[720px]">
      <Head no="ERR · Render" title={<>This view <em>hit an error.</em></>} />
      <ErrorNote error={error.message || "Something went wrong while rendering this page."} onRetry={reset} />
      {/* The digest is the only handle on the server-side stack trace, so it is shown rather than swallowed. */}
      {error.digest && <p className="mt-3 font-mono text-[11px] text-ink-faint">digest {error.digest}</p>}
      <Button asChild variant="outline" size="sm" className="mt-6">
        <Link href="/">Back to repositories</Link>
      </Button>
    </Page>
  );
}
