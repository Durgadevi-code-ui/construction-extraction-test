import { formatPercent, formatQuantity } from "@/lib/format";

/**
 * The primary Worker screen — "what work is assigned to me, what's the
 * target, how much have I done, how much is left" answered in one
 * glance, before anything else on the page (see AGENTS.md master
 * prompt section 3/12: "minimum cognitive load"). Pure display, no
 * client state — the numbers come straight from getWorkerDashboard,
 * the same cumulative-approved-only calculation used everywhere else
 * (see lib/calculations.ts), never a separate/duplicated computation.
 *
 * Target/Completed/Remaining are formatted for DISPLAY ONLY via
 * formatQuantity (lib/format.ts) — summed decimal quantities in JS can
 * produce artifacts like 219.98000000000002; formatQuantity rounds to
 * 2dp and strips trailing zeros for the screen only. `remaining` itself
 * (the subtraction) is unchanged — still computed from the raw,
 * unrounded values, only the rendered string is cleaned up.
 */
export default function WorkerHeroCard({
  workItemCode,
  workItemDescription,
  plannedQuantity,
  unitOfMeasure,
  submittedQuantity,
  approvedQuantity,
  progressPercentage,
  isCompleted,
}: {
  workItemCode: string;
  workItemDescription: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  /** Sum of completed_quantity as originally SUBMITTED across every one
   * of this Worker's own submissions for this work item, whether or not
   * each has been reviewed/approved yet (see
   * app/workflow/worker/page.tsx, derived from
   * getWorkerSubmissionHistory — no new query). Distinct from
   * approvedQuantity below: a submission counts here the moment it's
   * submitted, not only once it clears review — this is what makes
   * "500 LF submitted, only 300 LF approved so far" visible instead of
   * treating a pending submission as already completed. Null in
   * percentage-only legacy mode, same convention as approvedQuantity. */
  submittedQuantity: number | null;
  approvedQuantity: number | null;
  progressPercentage: number | null;
  isCompleted: boolean;
}) {
  const hasQuantities = plannedQuantity !== null && approvedQuantity !== null;
  const remaining = hasQuantities ? Math.max(0, plannedQuantity! - approvedQuantity!) : null;
  const pct = progressPercentage ?? 0;

  const encouragement = isCompleted
    ? "Work completed!"
    : pct >= 90
      ? "Almost complete!"
      : pct >= 50
        ? "You're halfway there!"
        : pct > 0
          ? "Good start!"
          : null;

  return (
    <section className="bg-surface rounded-xl border border-line shadow-sm p-5 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-foreground-muted font-medium">My Work</p>
        <h2 className="text-xl font-bold text-foreground">{workItemDescription}</h2>
        <p className="text-xs text-foreground-muted">{workItemCode}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="bg-[#FAFAFA] rounded-lg py-3">
          <p className="text-lg font-bold text-foreground">{formatQuantity(plannedQuantity)}</p>
          <p className="text-[11px] text-foreground-secondary">Target {unitOfMeasure ?? ""}</p>
        </div>
        <div className="bg-purple-50 rounded-lg py-3">
          <p className="text-lg font-bold text-purple-700">
            {submittedQuantity !== null ? formatQuantity(submittedQuantity) : "—"}
          </p>
          <p className="text-[11px] text-foreground-secondary">
            Submitted / Estimated {submittedQuantity !== null ? (unitOfMeasure ?? "") : ""}
          </p>
        </div>
        <div className="bg-brand-soft rounded-lg py-3">
          <p className="text-lg font-bold text-brand">
            {approvedQuantity !== null ? formatQuantity(approvedQuantity) : formatPercent(pct)}
          </p>
          <p className="text-[11px] text-foreground-secondary">
            Approved / Completed {approvedQuantity !== null ? (unitOfMeasure ?? "") : ""}
          </p>
        </div>
        <div className="bg-amber-50 rounded-lg py-3">
          <p className="text-lg font-bold text-amber-700">{formatQuantity(remaining)}</p>
          <p className="text-[11px] text-foreground-secondary">Remaining {unitOfMeasure ?? ""}</p>
        </div>
      </div>

      <div>
        <div className="h-2.5 w-full rounded-full bg-[#F1E7DF] overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ease-out ${isCompleted ? "bg-green-500" : "bg-brand"}`}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-foreground-secondary">{formatPercent(pct)} complete</p>
          {encouragement && (
            <p className="text-xs font-medium text-brand">{encouragement}</p>
          )}
        </div>
      </div>
    </section>
  );
}
