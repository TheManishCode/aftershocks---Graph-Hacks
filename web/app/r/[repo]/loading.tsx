import { Grid, Page, Skeleton } from "@/components/ds";

/**
 * A skeleton in the shape of a repo page (header, then a main/aside split) so the
 * layout does not jump when the real content arrives.
 *
 * A <div>, not a <main>: the shell already renders the page's single
 * `<main id="content">` and this is nested inside it.
 */
export default function RepoLoading() {
  return (
    <Page role="status" aria-label="Loading">
      <Skeleton className="mb-6 h-9 w-56" />
      <Grid cols="aside-main">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </Grid>
      <Skeleton className="mt-4 h-80" />
      <span className="sr-only">Loading…</span>
    </Page>
  );
}
