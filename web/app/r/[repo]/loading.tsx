/** A skeleton in the shape of a repo page (header, then tiles) while the route loads, so the layout does not jump. */
export default function RepoLoading() {
  return (
    <main className="mx-auto w-full max-w-[1400px] px-4 pt-6 pb-16 lg:px-6" role="status" aria-label="Loading">
      <div className="mb-6 h-9 w-56 animate-pulse rounded-md bg-white/[0.05]" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="h-64 animate-pulse rounded-xl border border-graphite bg-white/[0.02]" />
        <div className="h-64 animate-pulse rounded-xl border border-graphite bg-white/[0.02]" />
      </div>
      <div className="mt-4 h-80 animate-pulse rounded-xl border border-graphite bg-white/[0.02]" />
      <span className="sr-only">Loading…</span>
    </main>
  );
}
