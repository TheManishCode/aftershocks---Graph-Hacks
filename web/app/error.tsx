"use client";

import Link from "next/link";
import { useEffect } from "react";

import { ErrorNote } from "@/components/kit";
import { Button } from "@/components/ui/button";

/** A top-level page crashed while rendering: keep the shell, say what happened, offer a retry. */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-16">
      <h1 className="text-lg text-paper">This page hit an error</h1>
      <ErrorNote error={error.message || "Something went wrong while rendering this page."} onRetry={reset} />
      <Button asChild variant="outline" size="sm">
        <Link href="/">Back to repositories</Link>
      </Button>
    </div>
  );
}
