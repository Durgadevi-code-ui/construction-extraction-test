/**
 * Maps an already-computed progress percentage to its semantic display
 * color — purely a presentation lookup on a number the caller already
 * computed (getWorkItemCurrentStatus, etc.); never a new calculation and
 * never touches how progress itself is derived. Used as the shared
 * default for ProgressRing/ProgressBar so every progress indicator
 * across Worker/Subcontractor/Contractor/Admin screens communicates
 * project health the same way: below 30% reads as at-risk (red), 30–50%
 * as needing attention (amber), and 50%+ as healthy (green).
 */
export function progressColorClass(
  percent: number | null,
  kind: "text" | "bg" = "text"
): string {
  if (percent === null) return kind === "text" ? "text-foreground-muted" : "bg-foreground-muted";
  if (percent < 30) return kind === "text" ? "text-error" : "bg-error";
  if (percent < 50) return kind === "text" ? "text-warning" : "bg-warning";
  return kind === "text" ? "text-success" : "bg-success";
}
