import { Measuring, Page } from "@/components/gt";

/** Shown while a route's code and first data load. */
export default function Loading() {
  return (
    <Page>
      <Measuring label="Loading" />
    </Page>
  );
}
