"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatPercent, humanizeApprovalStatus } from "@/lib/format";
import StatusFlow from "./StatusFlow";
import PlannedQuantityEditor from "./PlannedQuantityEditor";
import AssignmentManager, {
  type AssignmentWorkerOption,
  type AssignmentWorkItemOption,
  type AssignmentRow,
} from "./AssignmentManager";

export type DelegatedWorkItem = {
  workItemId: string;
  code: string;
  description: string;
  scheduledValue: number | null;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
};

/**
 * Mirrors lib/workflow.ts's QueueItem shape (the fields this panel's
 * review cards actually need) — defined locally rather than imported,
 * same reason SupervisorPanel.tsx's own local SupervisorQueueItem type
 * is: lib/workflow.ts carries "server-only" and must never be pulled
 * into a client bundle, even for a type.
 */
export type DelegatedReviewItem = {
  submissionId: string;
  workerName: string;
  workItemCode: string;
  workItemDescription: string;
  submittedProgress: number;
  description: string;
  validationId: string | null;
  correctedProgress: number | null;
  approvalStatus: string | null;
  scheduledValue: number | null;
  estimatedAmount: number | null;
  isCompleted: boolean;
};

export type DelegatedDepartmentScope = {
  departmentId: string;
  departmentName: string;
  canManageWorkItems: boolean;
  canManageAssignments: boolean;
  canReviewProgress: boolean;
  workItems: DelegatedWorkItem[];
  assignmentWorkers: AssignmentWorkerOption[];
  assignmentWorkItems: AssignmentWorkItemOption[];
  assignments: AssignmentRow[];
  progressReviewQueue: DelegatedReviewItem[];
};

type Props = {
  contractorUserId: string;
  scopes: DelegatedDepartmentScope[];
};

/**
 * Shown on the Contractor dashboard only while at least one Admin
 * delegation is currently active for this Contractor (see
 * app/workflow/supervisor/page.tsx, lib/delegation.ts). Gives access
 * only to what was explicitly delegated, only in the delegated
 * department(s) — never a blanket Admin view. Disappears automatically
 * the moment every delegation expires or is revoked (the page simply
 * stops passing any scopes).
 */
export default function DelegatedAdminPanel({ contractorUserId, scopes }: Props) {
  if (scopes.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
        You currently hold temporary delegated Admin capabilities. They apply only to the
        department(s) below and expire automatically — see the delegation banner above for exact
        timing.
      </div>

      {scopes.map((scope) => (
        <div key={scope.departmentId} className="space-y-4">
          {scope.canManageAssignments && (
            <AssignmentManager
              subcontractorUserId={contractorUserId}
              departmentName={scope.departmentName}
              workers={scope.assignmentWorkers}
              workItems={scope.assignmentWorkItems}
              assignments={scope.assignments}
            />
          )}

          {scope.canManageWorkItems && (
            <DelegatedWorkItemManager
              contractorUserId={contractorUserId}
              departmentId={scope.departmentId}
              departmentName={scope.departmentName}
              workItems={scope.workItems}
            />
          )}

          {scope.canReviewProgress && (
            <DelegatedProgressReviewQueue
              contractorUserId={contractorUserId}
              departmentName={scope.departmentName}
              items={scope.progressReviewQueue}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function reviewStatusFlowCode(
  approvalStatus: string | null
): "AWAITING_SUPERVISOR_APPROVAL" | "APPROVED" | "ROLLED_BACK" {
  if (approvalStatus === "APPROVED") return "APPROVED";
  if (approvalStatus === "ROLLED_BACK") return "ROLLED_BACK";
  return "AWAITING_SUPERVISOR_APPROVAL";
}

/**
 * Delegated PROGRESS_REVIEW UI — same actions (approve/edit/comment/
 * rollback) as SupervisorPanel's own queue cards, posting to the same
 * /api/workflow/supervisor route (already delegation-aware server-side
 * via lib/workflow.ts's assertCanReviewProgress). Deliberately a
 * separate, self-contained component rather than reusing
 * SupervisorPanel directly — that component is tightly coupled to a
 * Contractor's own Today's/MTD/Work-Summary dashboard props, which
 * don't apply to a delegated department's review queue. Kept visually
 * distinct (own section, own heading) so "reviewing my own department"
 * and "reviewing a delegated department" are never confused for one
 * another, per the business requirement.
 */
function DelegatedProgressReviewQueue({
  contractorUserId,
  departmentName,
  items,
}: {
  contractorUserId: string;
  departmentName: string;
  items: DelegatedReviewItem[];
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [commentingId, setCommentingId] = useState<string | null>(null);
  const [progressDraft, setProgressDraft] = useState<number>(0);
  const [commentDraft, setCommentDraft] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(validationId: string, action: string, extra: Record<string, unknown> = {}) {
    setBusyId(validationId);
    setError(null);
    try {
      const res = await fetch("/api/workflow/supervisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          validationId,
          supervisorUserId: contractorUserId,
          action,
          ...extra,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Action failed.");
      setEditingId(null);
      setCommentingId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  const reviewable = items.filter((item) => item.validationId !== null);

  return (
    <section className="bg-white rounded-lg border border-line p-4 space-y-3 text-sm">
      <div>
        <h2 className="font-semibold text-foreground">Progress Review — {departmentName}</h2>
        <p className="text-xs text-foreground-secondary mt-0.5">Delegated Admin capability (temporary).</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {reviewable.length === 0 ? (
        <p className="text-foreground-muted">No submissions to review.</p>
      ) : (
        <div className="space-y-3">
          {reviewable.map((item) => {
            const validationId = item.validationId as string;
            const isEditing = editingId === validationId;
            const isCommenting = commentingId === validationId;
            const currentProgress = item.correctedProgress ?? item.submittedProgress;
            const displayedProgress = isEditing ? progressDraft : currentProgress;

            return (
              <div key={validationId} className="border border-line rounded p-3 space-y-1.5">
                <p>
                  <span className="text-foreground-secondary">Worker:</span>{" "}
                  <span className="font-medium">{item.workerName}</span>
                </p>
                <p>
                  <span className="text-foreground-secondary">Work ID:</span> {item.workItemCode}
                </p>
                <p>
                  <span className="text-foreground-secondary">Work:</span> {item.workItemDescription}
                </p>
                {item.description && (
                  <p>
                    <span className="text-foreground-secondary">Description:</span> {item.description}
                  </p>
                )}

                {isEditing ? (
                  <div>
                    <label className="block text-foreground-secondary mb-1">
                      {item.correctedProgress !== null ? "Corrected Progress:" : "Submitted Progress:"}
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={progressDraft}
                      onChange={(e) => setProgressDraft(Number(e.target.value))}
                      className="w-24 rounded border border-line px-2 py-1"
                    />
                    %
                  </div>
                ) : (
                  <p>
                    <span className="text-foreground-secondary">
                      {item.correctedProgress !== null ? "Corrected Progress:" : "Submitted Progress:"}
                    </span>{" "}
                    <span className="font-medium">{formatPercent(displayedProgress)}</span>
                  </p>
                )}

                {item.scheduledValue !== null && (
                  <p>
                    <span className="text-foreground-secondary">Estimated Amount:</span>{" "}
                    <span className="font-medium">
                      {item.estimatedAmount !== null
                        ? `$${item.estimatedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                        : "—"}
                    </span>
                  </p>
                )}
                <p>
                  <span className="text-foreground-secondary">Status:</span>{" "}
                  <span className="font-medium">{humanizeApprovalStatus(item.approvalStatus)}</span>
                </p>
                <StatusFlow statusCode={reviewStatusFlowCode(item.approvalStatus)} />

                {isCommenting && (
                  <textarea
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    rows={2}
                    placeholder="Add a comment…"
                    className="w-full rounded border border-line px-2 py-1"
                  />
                )}

                <div className="flex gap-2 pt-1 flex-wrap">
                  <button
                    onClick={() => run(validationId, "approve")}
                    disabled={busyId === validationId}
                    className="text-xs px-3 py-1.5 rounded bg-green-600 text-white disabled:opacity-50"
                  >
                    Approve
                  </button>
                  {!isEditing ? (
                    <button
                      onClick={() => {
                        setEditingId(validationId);
                        setProgressDraft(currentProgress);
                      }}
                      className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
                    >
                      Edit
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => run(validationId, "edit", { progressPercentage: progressDraft })}
                        disabled={busyId === validationId}
                        className="text-xs px-3 py-1.5 rounded bg-brand text-white disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        disabled={busyId === validationId}
                        className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {!isCommenting ? (
                    <button
                      onClick={() => {
                        setCommentingId(validationId);
                        setCommentDraft("");
                      }}
                      className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
                    >
                      Add Comment
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => run(validationId, "comment", { comment: commentDraft })}
                        disabled={busyId === validationId}
                        className="text-xs px-3 py-1.5 rounded bg-brand text-white disabled:opacity-50"
                      >
                        Save Comment
                      </button>
                      <button
                        onClick={() => setCommentingId(null)}
                        disabled={busyId === validationId}
                        className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {item.approvalStatus === "APPROVED" && (
                    <button
                      onClick={() => run(validationId, "rollback")}
                      disabled={busyId === validationId}
                      className="text-xs px-3 py-1.5 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      Rollback
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DelegatedWorkItemManager({
  contractorUserId,
  departmentId,
  departmentName,
  workItems,
}: {
  contractorUserId: string;
  departmentId: string;
  departmentName: string;
  workItems: DelegatedWorkItem[];
}) {
  const router = useRouter();
  const [lineItemNo, setLineItemNo] = useState("");
  const [descriptionOfWork, setDescriptionOfWork] = useState("");
  const [scheduledValue, setScheduledValue] = useState("");
  const [unitOfMeasure, setUnitOfMeasure] = useState("");
  const [plannedQuantity, setPlannedQuantity] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/work-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorUserId: contractorUserId,
          departmentId,
          lineItemNo,
          descriptionOfWork,
          scheduledValue,
          unitOfMeasure,
          plannedQuantity,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create work item.");
      setLineItemNo("");
      setDescriptionOfWork("");
      setScheduledValue("");
      setUnitOfMeasure("");
      setPlannedQuantity("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create work item.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="bg-white rounded-lg border border-line p-4 space-y-3 text-sm">
      <div>
        <h2 className="font-semibold text-foreground">Work Item Management — {departmentName}</h2>
        <p className="text-xs text-foreground-secondary mt-0.5">Delegated Admin capability (temporary).</p>
      </div>

      <form onSubmit={handleCreate} className="grid grid-cols-2 gap-2">
        <input
          value={lineItemNo}
          onChange={(e) => setLineItemNo(e.target.value)}
          placeholder="Line Item No"
          required
          className="rounded border border-line px-2 py-1.5 text-sm col-span-1"
        />
        <input
          value={descriptionOfWork}
          onChange={(e) => setDescriptionOfWork(e.target.value)}
          placeholder="Description of Work"
          required
          className="rounded border border-line px-2 py-1.5 text-sm col-span-1"
        />
        <input
          type="number"
          value={plannedQuantity}
          onChange={(e) => setPlannedQuantity(e.target.value)}
          placeholder="Planned Quantity"
          className="rounded border border-line px-2 py-1.5 text-sm"
        />
        <input
          value={unitOfMeasure}
          onChange={(e) => setUnitOfMeasure(e.target.value)}
          placeholder="Unit (e.g. m, LF)"
          className="rounded border border-line px-2 py-1.5 text-sm"
        />
        <input
          type="number"
          value={scheduledValue}
          onChange={(e) => setScheduledValue(e.target.value)}
          placeholder="Scheduled Value"
          className="rounded border border-line px-2 py-1.5 text-sm col-span-2"
        />
        <button
          type="submit"
          disabled={submitting}
          className="col-span-2 rounded bg-brand text-white text-sm font-medium px-4 py-1.5 disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create Work Item"}
        </button>
        {error && <p className="col-span-2 text-sm text-red-600">{error}</p>}
      </form>

      <div>
        <h3 className="text-xs font-medium text-foreground-secondary mb-2">Existing Work Items</h3>
        {workItems.length === 0 ? (
          <p className="text-foreground-muted">None yet.</p>
        ) : (
          <ul className="space-y-1">
            {workItems.map((w) => (
              <li key={w.workItemId} className="flex items-center justify-between gap-2 py-1 border-b border-line last:border-0">
                <span>
                  <span className="font-medium">{w.code}</span> — {w.description}
                </span>
                <PlannedQuantityEditor
                  actorUserId={contractorUserId}
                  workItemId={w.workItemId}
                  plannedQuantity={w.plannedQuantity}
                  unitOfMeasure={w.unitOfMeasure}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
