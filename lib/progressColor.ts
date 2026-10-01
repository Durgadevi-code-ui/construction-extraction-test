/**
 * Maps an already-computed progress percentage to its semantic display
 * color — purely a presentation lookup on a number the caller already
 * computed (getWorkItemCurrentStatus, etc.); never a new calculation and
 * never touches how progress itself is derived. Used as the shared
 * default for ProgressRing/ProgressBar/ProgressValue so every progress
 * indicator across Worker/Subcontractor/Contractor/Admin screens
 * communicates project health the same way: 0–25% red, >25–50% orange,
 * >50–75% yellow, >75–100% green. This is the ONLY place those
 * thresholds live. Animated indicators pass their CURRENT (counting-up)
 * value, so the color steps through the bands as the number climbs.
 */
export type ProgressBand = "none" | "low" | "medium" | "mediumHigh" | "high";

export function progressBand(percent: number | null): ProgressBand {
  if (percent === null || !Number.isFinite(percent)) return "none";
  if (percent <= 25) return "low";
  if (percent <= 50) return "medium";
  if (percent <= 75) return "mediumHigh";
  return "high";
}

const TEXT: Record<ProgressBand, string> = {
  none: "text-foreground-muted",
  low: "text-error",
  medium: "text-warning",
  mediumHigh: "text-caution",
  high: "text-success",
};

const BG: Record<ProgressBand, string> = {
  none: "bg-foreground-muted",
  low: "bg-error",
  medium: "bg-warning",
  mediumHigh: "bg-caution",
  high: "bg-success",
};

/** Light tint (background + border) for a progress surface — the same
 * soft theme tokens the status Badge uses, never a saturated fill. Pair
 * with text-foreground for the number so contrast stays readable. */
const SOFT: Record<ProgressBand, string> = {
  none: "bg-surface-soft border-line",
  low: "bg-error-soft border-error-border",
  medium: "bg-warning-soft border-warning-border",
  mediumHigh: "bg-caution-soft border-caution-border",
  high: "bg-success-soft border-success-border",
};

export function progressColorClass(
  percent: number | null,
  kind: "text" | "bg" = "text"
): string {
  const band = progressBand(percent);
  return kind === "text" ? TEXT[band] : BG[band];
}

export function progressSoftClass(percent: number | null): string {
  return SOFT[progressBand(percent)];
}
