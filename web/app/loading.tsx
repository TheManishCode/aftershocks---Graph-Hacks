import { Page, Spinner } from "@/components/ds";

/**
 * Shown while a route's code and first data load.
 *
 * `Page` is a <div>, deliberately: the shell already renders the one
 * `<main id="content">` and this markup is nested inside it. A second <main>
 * gives a screen reader two "main content" landmarks and breaks the skip link,
 * which is exactly what this file used to do.
 */
export default function Loading() {
  return (
    <Page>
      <Spinner />
    </Page>
  );
}
