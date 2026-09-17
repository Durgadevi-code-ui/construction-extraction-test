/**
 * Reusable horizontal progress indicator (CSS/Tailwind, no SVG needed)
 * — used for a single work item's or department's percent complete
 * wherever the Dashboard needs "one bar per row" (see
 * app/workflow/dashboard). `tooltip` uses the native title attribute
 * per the no-new-dependency constraint on this feature.
 */
export default function ProgressBar({
  percent,
  tooltip,
  colorClass = "bg-brand",
  showLabel = false,
}: {
  /** 0-100, or null when there's nothing to show yet (renders an empty
   * track, never a fabricated 0% bar). */
  percent: number | null;
  tooltip?: string;
  colorClass?: string;
  /** When true, renders the percentage as tabular-nums text above the
   * track — construction convention of pairing a bar with its number. */
  showLabel?: boolean;
}) {
  const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent));

  return (
    <div className="w-full">
      {showLabel && (
        <div className="mb-1 flex justify-end">
          <span className="text-xs font-medium text-foreground-secondary tabular-nums">
            {percent === null ? "—" : `${Math.round(clamped)}%`}
          </span>
        </div>
      )}
      <div
        className="w-full h-2 rounded-full bg-line-soft overflow-hidden"
        title={tooltip}
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {percent !== null && (
          <div
            className={`h-full rounded-full ${colorClass} transition-[width] duration-500 ease-out`}
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
    </div>
  );
}
