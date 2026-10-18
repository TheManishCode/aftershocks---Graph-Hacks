import { Spinner } from "@/components/kit";

/** Shown while a route's code and first data load. */
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 pt-6 lg:px-6">
      <Spinner />
    </main>
  );
}
