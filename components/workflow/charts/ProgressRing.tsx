"use client";

import { progressColorClass } from "@/lib/progressColor";
import { useCountUp } from "@/components/workflow/useCountUp";

/**
 * Reusable SVG donut ring for a single KPI percentage (e.g. "Overall
 * Progress" on the Dashboard's KPI row) — hand-built (stroke-dasharray
 * on a circle), no charting library per this feature's no-new-
 * dependency constraint. Defaults its stroke color to the shared
 * progress-health banding (see lib/progressColor.ts) — callers can still
 * override via `colorClass` for a non-progress use of this ring.
 */
export default function ProgressRing({
  percent,
  label,
  size = 88,
  strokeWidth = 10,
  colorClass,
  animate = false,
}: {
  /** 0-100, or null when there's nothing to compute yet — renders an
   * empty ring with "—", never a fabricated 0%. */
  percent: number | null;
  label?: string;
  size?: number;
  strokeWidth?: number;
  colorClass?: string;
  /** Count up 0 → percent when shown (display only, see useCountUp).
   * Off by default so existing rings render exactly as before. */
  animate?: boolean;
}) {
  const shown = useCountUp(percent, animate);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = shown === null ? 0 : Math.max(0, Math.min(100, shown));
  const offset = circumference * (1 - clamped / 100);
  const resolvedColorClass = colorClass ?? progressColorClass(percent);

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
            className="stroke-line-soft"
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
              className={`${resolvedColorClass} stroke-current transition-[stroke-dashoffset]`}
            />
          )}
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-foreground">
          {shown !== null ? `${shown}%` : "—"}
        </span>
      </div>
      {label && <span className="text-xs text-foreground-secondary text-center">{label}</span>}
    </div>
  );
}
