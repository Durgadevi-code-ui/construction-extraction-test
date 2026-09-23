import { Target, Send, CheckCircle2, Hourglass } from "lucide-react";
import { formatPercent, formatQuantity } from "@/lib/format";
import { progressColorClass } from "@/lib/progressColor";
import Card from "@/components/ui/Card";

const STAT_ICON_CHIP: Record<"neutral" | "info" | "brand" | "warning", string> = {
  neutral: "bg-navy text-white",
  info: "bg-info text-white",
  brand: "bg-brand text-white",
  warning: "bg-warning text-white",
};

function StatCell({
  icon: Icon,
  tone,
  value,
  label,
  valueClassName,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: "neutral" | "info" | "brand" | "warning";
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
    <Card className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-foreground-muted font-medium">My Work</p>
        <h2 className="text-xl font-bold text-foreground leading-snug">{workItemDescription}</h2>
        <p className="text-xs text-foreground-muted">{workItemCode}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCell
          icon={Target}
          tone="neutral"
          valueClassName="text-foreground"
          value={formatQuantity(plannedQuantity)}
          label={`Target ${unitOfMeasure ?? ""}`}
        />
        <StatCell
          icon={Send}
          tone="info"
          valueClassName="text-info"
          value={submittedQuantity !== null ? formatQuantity(submittedQuantity) : "—"}
          label={`Submitted / Estimated ${submittedQuantity !== null ? (unitOfMeasure ?? "") : ""}`}
        />
        <StatCell
          icon={CheckCircle2}
          tone="brand"
          valueClassName="text-brand"
          value={approvedQuantity !== null ? formatQuantity(approvedQuantity) : formatPercent(pct)}
          label={`Approved / Completed ${approvedQuantity !== null ? (unitOfMeasure ?? "") : ""}`}
        />
        <StatCell
          icon={Hourglass}
          tone="warning"
          valueClassName="text-warning"
          value={formatQuantity(remaining)}
          label={`Remaining ${unitOfMeasure ?? ""}`}
        />
      </div>

      <div>
        <div className="h-2.5 w-full rounded-full bg-line-soft overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ease-out ${progressColorClass(pct, "bg")}`}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-foreground-secondary tabular-nums">{formatPercent(pct)} complete</p>
          {encouragement && (
            <p className="text-xs font-medium text-brand">{encouragement}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
