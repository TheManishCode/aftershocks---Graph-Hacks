import Link from "next/link";

import { Eyebrow } from "@/components/ds";
import { Button } from "@/components/ui/button";

/**
 * Any URL with no page behind it: say so plainly and offer the way back.
 *
 * A <div>, not a <main>: the shell already owns the single `<main id="content">`.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 py-24 text-center">
      <Eyebrow className="tracking-[0.2em]">404</Eyebrow>
      <h1 className="text-display leading-none">Nothing here</h1>
      <p className="text-body-sm text-ink-muted">
        This page does not exist. The repository may have been renamed, or never indexed.
      </p>
      <Button asChild size="sm">
        <Link href="/">Back to repositories</Link>
      </Button>
    </div>
  );
}
