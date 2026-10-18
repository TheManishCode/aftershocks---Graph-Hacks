import { Page, Skeleton } from "@/components/gt";

/** A skeleton in the shape of a repo page (head, then an aside/main split) so the layout does not jump. */
export default function RepoLoading() {
  return (
    <Page>
      <div role="status" aria-label="Loading">
        <Skeleton className="mb-3 h-3 w-28" />
        <Skeleton className="mb-10 h-12 w-[min(560px,80%)]" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
        <Skeleton className="mt-4 h-80" />
        <span className="sr-only">Loading…</span>
      </div>
    </Page>
  );
}
