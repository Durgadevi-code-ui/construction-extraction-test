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
}: {
  /** 0-100, or null when there's nothing to show yet (renders an empty
   * track, never a fabricated 0% bar). */
  percent: number | null;
  tooltip?: string;
  colorClass?: string;
}) {
  const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent));

  return (
    <div
      className="w-full h-2 rounded-full bg-gray-100 overflow-hidden"
      title={tooltip}
      role="progressbar"
      aria-valuenow={percent ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {percent !== null && (
        <div
          className={`h-full rounded-full ${colorClass} transition-[width]`}
          style={{ width: `${clamped}%` }}
        />
      )}
    </div>
  );
}
