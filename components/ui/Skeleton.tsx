/** Shared loading skeleton — pulsing placeholder instead of "Loading…" text. */
export default function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-line-soft ${className}`} />;
}

/** A few skeleton rows shaped like a simple list/table. */
export function SkeletonRows({ count = 3, rowHeight = "h-14" }: { count?: number; rowHeight?: string }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={`w-full ${rowHeight}`} />
      ))}
    </div>
  );
}
