/**
 * Reusable SVG donut ring for a single KPI percentage (e.g. "Overall
 * Progress" on the Dashboard's KPI row) — hand-built (stroke-dasharray
 * on a circle), no charting library per this feature's no-new-
 * dependency constraint.
 */
export default function ProgressRing({
  percent,
  label,
  size = 88,
  strokeWidth = 10,
  colorClass = "text-brand",
}: {
  /** 0-100, or null when there's nothing to compute yet — renders an
   * empty ring with "—", never a fabricated 0%. */
  percent: number | null;
  label?: string;
  size?: number;
  strokeWidth?: number;
  colorClass?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="flex flex-col items-center gap-1" title={label}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-gray-100"
          />
          {percent !== null && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
              className={`${colorClass} stroke-current transition-[stroke-dashoffset]`}
            />
          )}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-foreground">
          {percent !== null ? `${percent}%` : "—"}
        </span>
      </div>
      {label && <span className="text-xs text-foreground-secondary text-center">{label}</span>}
    </div>
  );
}
