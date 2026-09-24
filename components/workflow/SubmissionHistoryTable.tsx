import { History } from "lucide-react";
import { formatDateTimeUS, formatDateUS, formatPercent, type WorkerSubmissionStatusCode } from "@/lib/format";
import Badge, { type BadgeVariant } from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";

export type SubmissionHistoryRow = {
  submissionId: string;
  submittedAt: string;
  workerName: string;
  departmentName: string;
  workItemCode: string;
  workItemDescription: string;
  submittedProgress: number;
  submittedQuantity: number | null;
  unit: string | null;
  reviewStatusLabel: string;
  /** Optional review detail (present on rows from getSubmissionHistory). */
  reviewStatusCode?: WorkerSubmissionStatusCode;
  correctedProgress?: number | null;
  approvalComments?: string | null;
  /** Reviewer who approved (see lib/workflow.ts withApproverNames). */
  approvedBy?: string | null;
  /** When it was approved (user_validations.approved_at). */
  approvedAt?: string | null;
  /** Task recorded on the submission at submit time. */
  taskLabel?: string | null;
};

/** Light status tint per review state — green approved, light red
 * returned, light amber anything still in review. */
const STATUS_VARIANT: Record<WorkerSubmissionStatusCode, BadgeVariant> = {
  APPROVED: "success",
  ROLLED_BACK: "error",
  AWAITING_FOREMAN_REVIEW: "warning",
  AWAITING_SUPERVISOR_APPROVAL: "warning",
};

/**
 * Date window for Submission History — everything before yesterday
 * (Today's/Yesterday's submissions already have their own place in
 * Reviews) back a year, which comfortably covers this project's full
 * history. One definition shared by the standalone history route and the
 * Contractor/Subcontractor History tabs.
 */
export function submissionHistoryBounds(): { from: string; to: string } {
  const offset = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return { from: offset(-365), to: offset(-2) };
}

/** Read-only Submission History table (rows from lib/workflow.ts
 * getSubmissionHistory — department-scoped server-side). Shared by
 * app/workflow/supervisor/history/page.tsx and the History tabs. */
export default function SubmissionHistoryTable({ items }: { items: SubmissionHistoryRow[] }) {
  return (
    <Card className="!p-0 overflow-hidden">
      {items.length === 0 ? (
        <EmptyState icon={History} title="No older submissions found" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-soft text-[11px] uppercase tracking-wide text-foreground-muted">
              <tr>
                <th className="text-left px-5 py-2.5 font-medium">Date</th>
                <th className="text-left px-5 py-2.5 font-medium">Worker</th>
                <th className="text-left px-5 py-2.5 font-medium">Work Item</th>
                <th className="text-right px-5 py-2.5 font-medium">Submitted</th>
                <th className="text-left px-5 py-2.5 font-medium">Status &amp; Review</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((item) => (
                <tr key={item.submissionId} className="transition-colors duration-150 hover:bg-surface-hover">
                  <td className="px-5 py-3 whitespace-nowrap text-foreground-secondary tabular-nums">
                    {formatDateUS(item.submittedAt)}
                  </td>
                  <td className="px-5 py-3">
                    <span className="font-medium">{item.workerName}</span>{" "}
                    <span className="text-foreground-muted">({item.departmentName})</span>
                  </td>
                  <td className="px-5 py-3">
                    <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
                    {item.workItemDescription}
                    {item.taskLabel && (
                      <span className="block text-xs text-foreground-secondary">Task: {item.taskLabel}</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right font-medium tabular-nums whitespace-nowrap">
                    {item.submittedQuantity !== null
                      ? `${item.submittedQuantity} ${item.unit ?? ""}`.trim()
                      : `${item.submittedProgress}%`}
                    {item.correctedProgress != null && item.correctedProgress !== item.submittedProgress && (
                      <span className="block text-xs font-normal text-foreground-secondary">
                        adjusted to {formatPercent(item.correctedProgress)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 space-y-0.5">
                    {item.reviewStatusCode ? (
                      <Badge variant={STATUS_VARIANT[item.reviewStatusCode]}>{item.reviewStatusLabel}</Badge>
                    ) : (
                      item.reviewStatusLabel
                    )}
                    {item.approvedBy && (
                      <span className="block text-xs text-foreground-secondary">
                        Approved by {item.approvedBy}
                        {item.approvedAt ? ` · ${formatDateTimeUS(item.approvedAt)}` : ""}
                      </span>
                    )}
                    {item.approvalComments && (
                      <span className="block text-xs text-foreground-secondary">Comment: {item.approvalComments}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
