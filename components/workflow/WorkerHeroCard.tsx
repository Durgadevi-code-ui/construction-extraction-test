"use client";

import { Target, Send, CheckCircle2, Hourglass } from "lucide-react";
import { formatPercent, formatQuantity, type WorkerSubmissionStatusCode } from "@/lib/format";
import { progressColorClass } from "@/lib/progressColor";
import { useCountUp } from "@/components/workflow/useCountUp";
import Card from "@/components/ui/Card";

/** Label under the Submitted value for the submission's review state. An
 * approval the reviewer adjusted says what it was approved as. */
const SUBMISSION_STATE: Record<
  WorkerSubmissionStatusCode,
  (s: { submittedProgress: number; correctedProgress: number | null }) => { text: string; className: string }
> = {
  AWAITING_FOREMAN_REVIEW: () => ({ text: "Pending approval", className: "text-warning" }),
  AWAITING_SUPERVISOR_APPROVAL: () => ({ text: "Pending approval", className: "text-warning" }),
  APPROVED: (s) =>
    s.correctedProgress !== null && s.correctedProgress !== s.submittedProgress
      ? { text: `Approved as ${formatPercent(s.correctedProgress)}`, className: "text-success" }
      : { text: "Approved", className: "text-success" },
  ROLLED_BACK: () => ({ text: "Returned for correction", className: "text-error" }),
};

const STAT_ICON_CHIP: Record<"neutral" | "info" | "brand" | "warning" | "error", string> = {
  neutral: "bg-navy text-white",
  info: "bg-info text-white",
  brand: "bg-brand text-white",
  warning: "bg-warning text-white",
  error: "bg-error text-white",
};

function StatCell({
  icon: Icon,
  tone,
  value,
  label,
  valueClassName,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: "neutral" | "info" | "brand" | "warning" | "error";
  value: React.ReactNode;
  label: string;
  valueClassName: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-white py-3 px-2">
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${STAT_ICON_CHIP[tone]}`}>
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <p className={`text-lg font-bold tabular-nums leading-tight ${valueClassName}`}>{value}</p>
      <p className="text-[11px] text-foreground-secondary text-center">{label}</p>
    </div>
  );
}

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
  latestSubmission = null,
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
  /** The Worker-side submission for this work item (latest awaiting
   * review, else latest of any state) and its review state — what
   * "submitted" means in percentage-only mode. Never approved progress. */
  latestSubmission?: {
    submittedProgress: number;
    correctedProgress: number | null;
    reviewStatusCode: WorkerSubmissionStatusCode;
  } | null;
  approvedQuantity: number | null;
  progressPercentage: number | null;
  isCompleted: boolean;
}) {
  // All four cards describe THIS work item only (the page's current/
  // active one). Two existing modes (see getWorkItemCurrentStatus):
  //  - quantity mode (planned_quantity > 0): Target/Submitted/Approved/
  //    Remaining in the work item's unit; Remaining = planned − approved.
  //  - percentage-only mode (no planned quantity — every work item
  //    stored today): approved progress is a cumulative % of the whole
  //    scope, so the target is 100%; Submitted is the cumulative figure
  //    approved % + the most recent submission's % while it awaits
  //    approval (e.g. 95% approved + 2% recently submitted = 97%, capped
  //    at 100 — the same rule approval applies, lib/workflow.ts
  //    toApprovedTotalData), with the recently submitted % and its review
  //    state under it; Remaining = 100% − approved %.
  // Submitted is the WORKER side; Approved/Remaining use ONLY
  // Contractor-approved progress, so a pending submission never changes
  // them until it is approved.
  // A value that genuinely doesn't exist reads "N/A", never a fake 0.
  const quantityMode = plannedQuantity !== null && plannedQuantity > 0;
  const unit = unitOfMeasure?.trim() ?? "";
  const withUnit = (value: number) => `${formatQuantity(value)}${unit ? ` ${unit}` : ""}`;
  const pct = progressPercentage ?? 0;
  const targetValue = quantityMode ? withUnit(plannedQuantity!) : "100%";
  // Percentage mode: approved + the recent submission awaiting approval
  // (as a reviewer has adjusted it so far, else as submitted — the value
  // approval will add), as one cumulative %.
  const isPending =
    latestSubmission?.reviewStatusCode === "AWAITING_FOREMAN_REVIEW" ||
    latestSubmission?.reviewStatusCode === "AWAITING_SUPERVISOR_APPROVAL";
  const pending =
    !quantityMode && latestSubmission && isPending
      ? (latestSubmission.correctedProgress ?? latestSubmission.submittedProgress)
      : null;
  const cumulativeSubmitted = Math.min(100, Math.round((pct + (pending ?? 0)) * 100) / 100);
  const submittedValue = quantityMode
    ? submittedQuantity !== null
      ? `${formatQuantity(submittedQuantity)} / ${withUnit(plannedQuantity!)}`
      : "N/A"
    : latestSubmission !== null
      ? `${formatPercent(cumulativeSubmitted)} / 100%`
      : "N/A";
  // Review state under the Submitted value (both modes), so a pending
  // submission can't be mistaken for current progress.
  const submissionState = latestSubmission
    ? SUBMISSION_STATE[latestSubmission.reviewStatusCode](latestSubmission)
    : null;
  // Percentage mode: the recently submitted part of that figure, so it
  // stays identifiable. Approved / Remaining keep using approved progress
  // only until a reviewer approves it.
  const recentSubmittedText =
    quantityMode || !latestSubmission
      ? null
      : pending !== null
        ? `Recent submitted: +${formatPercent(pending)}`
        : `Latest submitted: ${formatPercent(latestSubmission.submittedProgress)}`;
  const approvedValue =
    quantityMode && approvedQuantity !== null ? (
      <>
        {withUnit(approvedQuantity)}
        <span className="block text-xs font-medium text-foreground-secondary">{formatPercent(pct)}</span>
      </>
    ) : (
      formatPercent(pct)
    );
  const remainingValue = quantityMode
    ? approvedQuantity !== null
      ? withUnit(Math.max(0, plannedQuantity! - approvedQuantity))
      : "N/A"
    : formatPercent(Math.max(0, Math.round((100 - pct) * 10) / 10));
  // Same count-up as the Contractor Overall Progress (display only): the
  // bar width, its color and the "% complete" text all follow the CURRENT
  // animated value, so the color steps red → orange → yellow → green.
  const shownPct = useCountUp(progressPercentage) ?? 0;

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
    <Card className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-foreground-muted font-medium">My Work</p>
        <h2 className="text-xl font-bold text-foreground leading-snug">{workItemDescription}</h2>
        <p className="text-xs text-foreground-muted">{workItemCode}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCell
          icon={Target}
          tone="error"
          valueClassName="text-error"
          value={targetValue}
          label={quantityMode ? "Target" : "Target (full scope)"}
        />
        <StatCell
          icon={Send}
          tone="info"
          valueClassName="text-info"
          value={
            submissionState ? (
              <>
                {submittedValue}
                <span className={`block text-xs font-medium ${submissionState.className}`}>{submissionState.text}</span>
                {recentSubmittedText && (
                  <span className="block text-xs font-normal text-foreground-secondary">{recentSubmittedText}</span>
                )}
              </>
            ) : (
              submittedValue
            )
          }
          label={quantityMode ? "Submitted / Estimated" : "Submitted (incl. awaiting approval)"}
        />
        <StatCell
          icon={CheckCircle2}
          tone="brand"
          valueClassName="text-brand"
          value={approvedValue}
          label="Approved / Completed"
        />
        <StatCell
          icon={Hourglass}
          tone="warning"
          valueClassName="text-warning"
          value={remainingValue}
          label="Remaining"
        />
      </div>

      <div>
        <div className="h-2.5 w-full rounded-full bg-line-soft overflow-hidden">
          <div
            className={`h-full rounded-full ${progressColorClass(shownPct, "bg")}`}
            style={{ width: `${Math.min(100, Math.max(0, shownPct))}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-foreground-secondary tabular-nums">{formatPercent(shownPct)} complete</p>
          {encouragement && (
            <p className="text-xs font-medium text-brand">{encouragement}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
