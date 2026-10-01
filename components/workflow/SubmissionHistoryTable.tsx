import type { WorkerSubmissionStatusCode } from "@/lib/format";
import SubmissionHistoryView from "@/components/workflow/SubmissionHistoryView";

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

/**
 * Date window for Submission History — the past year up to and including
 * today, so a submission that was just forwarded or approved is already
 * in History (a notification for a handled submission points here). The
 * History filters (see SubmissionHistoryView) narrow it by date. One
 * definition shared by the standalone history route and the
 * Contractor/Subcontractor History tabs. Kept in this server-safe module
 * (no "use client") because server pages call it directly.
 */
export function submissionHistoryBounds(): { from: string; to: string } {
  const offset = (days: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return { from: offset(-365), to: offset(0) };
}

/** Submission History with filters and sorting (rows from lib/workflow.ts
 * getSubmissionHistory — already project/department-scoped server-side;
 * filtering only ever narrows those rows). Shared by
 * app/workflow/supervisor/history/page.tsx and the Contractor/
 * Subcontractor/Worker History tabs — the same screen for all three. */
export default function SubmissionHistoryTable(props: React.ComponentProps<typeof SubmissionHistoryView>) {
  return <SubmissionHistoryView {...props} />;
}
