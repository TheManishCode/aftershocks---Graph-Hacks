import Link from "next/link";

import { Head, Page } from "@/components/gt";
import { Button } from "@/components/ui/button";

/** Any URL with no page behind it: say so plainly and offer the way back. */
export default function NotFound() {
  return (
    <Page className="max-w-[720px]">
      <Head no="404 · Not found" title={<>Nothing <em>here.</em></>} lead="This page does not exist. The repository may have been renamed, or never indexed." />
      <Button asChild size="sm">
        <Link href="/">Back to repositories</Link>
      </Button>
    </Page>
  );
}
