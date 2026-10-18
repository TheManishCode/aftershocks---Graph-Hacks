import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Any URL with no page behind it: say so plainly and offer the way back. */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl space-y-4 px-4 py-24 text-center">
      <p className="font-mono text-xs tracking-widest text-fog uppercase">404</p>
      <h1 className="text-[34px] leading-none">Nothing here</h1>
      <p className="text-sm text-muted-foreground">This page does not exist. The repository may have been renamed or never indexed.</p>
      <Button asChild size="sm">
        <Link href="/">Back to repositories</Link>
      </Button>
    </main>
  );
}
