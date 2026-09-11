"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatPercent, formatQuantity, humanizeApprovalStatus } from "@/lib/format";
import StatusFlow from "@/components/workflow/StatusFlow";
import PlannedQuantityEditor from "@/components/workflow/PlannedQuantityEditor";

export type SupervisorQueueItem = {
  submissionId: string;
  validationId: string | null;
  workerName: string;
  projectName: string;
  departmentName: string;
  workItemCode: string;
  workItemDescription: string;
  submittedProgress: number;
  /** Quantity/unit as originally submitted — null for percentage-only
   * work items or legacy submissions. */
  submittedQuantity: number | null;
  unit: string | null;
  correctedProgress: number | null;
  comments: string | null;
  approvalComments: string | null;
  approvalStatus: string | null;
  description: string;
  scheduledValue: number | null;
  estimatedAmount: number | null;
  isCompleted: boolean;
  /** Where this specific submission sits in the review pipeline right
   * now — distinguishes "not yet forwarded" from "forwarded, awaiting
   * approval" even though both read as approvalStatus === null. */
  reviewStatusLabel: string;
};

/** One work item's cumulative progress (MTD / Work Summary tab) — the
 * broader all-time view, one entry per Active work item in the
 * department regardless of whether it had activity recently. */
export type WorkItemProgressView = {
  workItemId: string;
  workItemCode: string;
  workItemDescription: string;
  scheduledValue: number | null;
  /** work_items.planned_quantity / unit_of_measure — null/null when not
   * configured yet. */
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  /** Cumulative approved quantity behind `progress` — null in
   * percentage-only legacy mode (no planned_quantity configured). */
  approvedQuantity: number | null;
  progress: number | null;
  estimatedAmount: number | null;
  isCompleted: boolean;
};

export type WorkSummaryView = {
  projectName: string;
  departmentName: string;
  reportingPeriodLabel: string | null;
  totalWorkItems: number;
  approvedCount: number;
  pendingCount: number;
  rolledBackCount: number;
  workItems: WorkItemProgressView[];
};

type Props = {
  supervisorUserId: string;
  queue: SupervisorQueueItem[];
  /** Actual submissions made today — empty when nothing was submitted,
   * never one row per Active work item. */
  todaysProgress: SupervisorQueueItem[];
  /** Same, bounded to the previous calendar day. */
  yesterdaysProgress: SupervisorQueueItem[];
  mtdProgress: WorkItemProgressView[];
  workSummary: WorkSummaryView;
};

/** Renders every work item's cumulative progress inside a single card
 * (MTD / Work Summary tab only). */
function ProgressListCard({ title, items }: { title: string; items: WorkItemProgressView[] }) {
  return (
    <section className="bg-white rounded-lg border border-line p-4 space-y-2 text-sm">
      <h2 className="font-semibold text-foreground">{title}</h2>
      {items.length === 0 ? (
        <p className="text-foreground-muted">No work items.</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => (
            <p key={item.workItemId}>
              <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
              <span>{item.workItemDescription}:</span>{" "}
              {item.approvedQuantity !== null && (
                <span className="font-medium">
                  {formatQuantity(item.approvedQuantity)} of {formatQuantity(item.plannedQuantity)}{" "}
                  {item.unitOfMeasure ?? ""} ·{" "}
                </span>
              )}
              <span className="font-medium">{formatPercent(item.progress)}</span>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** Renders the actual submission activity for one date (Today /
 * Yesterday) — one card per submission, not one per work item, so a
 * quiet day shows "No submissions" instead of every work item with
 * "—". Shows exactly what the mentor asked for: worker, department,
 * work ID, work description, submitted progress/quantity, and review
 * status — read-only (review/approve stays in Today's Work Summary
 * below, unchanged).
 *
 * Collapsed by default (just a count) so a busy day doesn't make the
 * dashboard long — the detailsLabel button expands the full list
 * in-place. Own local state, so Today's and Yesterday's cards expand
 * independently. */
function SubmissionActivityCard({
  title,
  items,
  detailsLabel,
}: {
  title: string;
  items: SupervisorQueueItem[];
  detailsLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="bg-white rounded-lg border border-line p-4 space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-foreground-muted">
          {items.length} submission{items.length === 1 ? "" : "s"}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="text-foreground-muted">No submissions.</p>
      ) : !expanded ? (
        <button
          onClick={() => setExpanded(true)}
          className="text-sm text-brand hover:underline"
        >
          {detailsLabel}
        </button>
      ) : (
        <>
          <button
            onClick={() => setExpanded(false)}
            className="text-sm text-brand hover:underline"
          >
            Hide Details
          </button>
          <div className="space-y-3">
            {items.map((item) => (
              <div
                key={item.submissionId}
                className="border border-line rounded p-2 space-y-0.5"
              >
                <p>
                  <span className="text-foreground-secondary">Worker:</span>{" "}
                  <span className="font-medium">{item.workerName}</span>{" "}
                  <span className="text-foreground-muted">({item.departmentName})</span>
                </p>
                <p>
                  <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
                  <span>{item.workItemDescription}</span>
                </p>
                <p>
                  <span className="text-foreground-secondary">Submitted:</span>{" "}
                  <span className="font-medium">
                    {item.submittedQuantity !== null
                      ? `${formatQuantity(item.submittedQuantity)} ${item.unit ?? ""}`.trim()
                      : formatPercent(item.submittedProgress)}
                  </span>
                </p>
                <p>
                  <span className="text-foreground-secondary">Status:</span>{" "}
                  <span className="font-medium">{item.reviewStatusLabel}</span>
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white rounded-lg border border-line p-3 text-center">
      <p className="text-xl font-semibold text-foreground">{value}</p>
      <p className="text-xs text-foreground-secondary">{label}</p>
    </div>
  );
}

function approvalStatusFlowCode(
  approvalStatus: string | null
): "AWAITING_SUPERVISOR_APPROVAL" | "APPROVED" | "ROLLED_BACK" {
  if (approvalStatus === "APPROVED") return "APPROVED";
  if (approvalStatus === "ROLLED_BACK") return "ROLLED_BACK";
  return "AWAITING_SUPERVISOR_APPROVAL";
}

export default function SupervisorPanel({
  supervisorUserId,
  queue,
  todaysProgress,
  yesterdaysProgress,
  mtdProgress,
  workSummary,
  forcedTab,
}: Props & {
  /** When set, this panel shows only that one view and hides its own
   * Today's Progress/MTD Summary tab switcher — used by
   * ContractorTabs.tsx, which now owns those two as separate top-level
   * Contractor tabs. Omitted (default), this component keeps its
   * original standalone behavior: its own switcher, starting on
   * "today". Nothing about the underlying data/actions changes either
   * way. */
  forcedTab?: "today" | "mtd";
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"today" | "mtd">(forcedTab ?? "today");
  const activeTab = forcedTab ?? tab;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [commentingId, setCommentingId] = useState<string | null>(null);
  const [progressDraft, setProgressDraft] = useState<number>(0);
  const [commentDraft, setCommentDraft] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Completed + Approved work items are display-only history on this
  // dashboard — same queue data, same fields (isCompleted,
  // approvalStatus) already returned by lib/workflow.ts, just split for
  // rendering. A rollback flips approvalStatus away from "APPROVED", so
  // the item naturally reappears in currentItems on the next refresh —
  // nothing pins it to history.
  const historyItems = queue.filter(
    (item) => item.isCompleted && item.approvalStatus === "APPROVED"
  );
  const currentItems = queue.filter(
    (item) => !(item.isCompleted && item.approvalStatus === "APPROVED")
  );

  async function post(validationId: string, body: Record<string, unknown>) {
    const res = await fetch("/api/workflow/supervisor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ validationId, supervisorUserId, ...body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Action failed.");
  }

  async function run(validationId: string, action: string, extra: Record<string, unknown> = {}) {
    setBusyId(validationId);
    setError(null);
    try {
      await post(validationId, { action, ...extra });
      setEditingId(null);
      setCommentingId(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  function renderQueueItem(item: SupervisorQueueItem) {
    if (!item.validationId) return null;
    const validationId = item.validationId;
    const isEditing = editingId === validationId;
    const isCommenting = commentingId === validationId;
    const currentProgress = item.correctedProgress ?? item.submittedProgress;
    const displayedProgress = isEditing ? progressDraft : currentProgress;

    return (
      <section
        key={validationId}
        className="bg-white rounded-lg border border-line p-4 space-y-2 text-sm"
      >
        <p>
          <span className="text-foreground-secondary">Worker:</span>{" "}
          <span className="font-medium">{item.workerName}</span>
        </p>
        <p>
          <span className="text-foreground-secondary">Project:</span> {item.projectName}
        </p>
        <p>
          <span className="text-foreground-secondary">Department:</span> {item.departmentName}
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
        ) : item.correctedProgress !== null ? (
          <>
            <p>
              <span className="text-foreground-secondary">Corrected Progress:</span>{" "}
              <span className="font-medium">{formatPercent(displayedProgress)}</span>
            </p>
            <p>
              <span className="text-foreground-secondary">Originally Submitted:</span>{" "}
              {formatPercent(item.submittedProgress)}
            </p>
          </>
        ) : (
          <p>
            <span className="text-foreground-secondary">Submitted Progress:</span>{" "}
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
          <span className="font-medium">{humanizeApprovalStatus(item.approvalStatus)}</span>{" "}
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              item.isCompleted ? "bg-green-100 text-green-700" : "bg-gray-100 text-foreground-secondary"
            }`}
          >
            {item.isCompleted ? "Completed" : "Not Completed"}
          </span>
        </p>
        <StatusFlow statusCode={approvalStatusFlowCode(item.approvalStatus)} />

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
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {!forcedTab && (
        <div className="flex gap-2">
          <button
            onClick={() => setTab("today")}
            className={`text-sm px-3 py-1.5 rounded ${
              tab === "today" ? "bg-brand text-white" : "bg-white border border-line text-foreground-secondary"
            }`}
          >
            Today&apos;s Progress
          </button>
          <button
            onClick={() => setTab("mtd")}
            className={`text-sm px-3 py-1.5 rounded ${
              tab === "mtd" ? "bg-brand text-white" : "bg-white border border-line text-foreground-secondary"
            }`}
          >
            MTD / Work Summary
          </button>
        </div>
      )}

      {activeTab === "today" ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <SubmissionActivityCard
              title="Today's Progress"
              items={todaysProgress}
              detailsLabel="View Today's Details"
            />
            <SubmissionActivityCard
              title="Yesterday"
              items={yesterdaysProgress}
              detailsLabel="View Yesterday's Details"
            />
          </div>

          <Link
            href="/workflow/supervisor/history"
            className="inline-block text-sm text-brand hover:underline"
          >
            View Submission History
          </Link>

          <div>
            <h2 className="font-semibold text-foreground mb-3">Today&apos;s Work Summary</h2>
            {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
            {queue.length === 0 ? (
              <p className="text-sm text-foreground-muted">No submissions to review.</p>
            ) : currentItems.length === 0 ? (
              <p className="text-sm text-foreground-muted">No current work items.</p>
            ) : (
              <div className="space-y-4">{currentItems.map(renderQueueItem)}</div>
            )}

            {historyItems.length > 0 && (
              <div className="mt-4">
                <button
                  onClick={() => setShowHistory((v) => !v)}
                  className="text-sm text-brand hover:underline"
                >
                  {showHistory ? "Hide History" : "View History"}
                </button>
                {showHistory && (
                  <div className="mt-3 space-y-4">
                    <h3 className="font-semibold text-foreground text-sm">
                      Previously Completed Work
                    </h3>
                    {historyItems.map(renderQueueItem)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <ProgressListCard title="MTD Progress" items={mtdProgress} />

          <section className="bg-white rounded-lg border border-line p-4 space-y-3 text-sm">
            <h2 className="font-semibold text-foreground">Work Summary</h2>
            <p>
              <span className="text-foreground-secondary">Project:</span> {workSummary.projectName}
            </p>
            <p>
              <span className="text-foreground-secondary">Department:</span> {workSummary.departmentName}
            </p>
            {workSummary.reportingPeriodLabel && (
              <p>
                <span className="text-foreground-secondary">Reporting Period (MTD):</span>{" "}
                {workSummary.reportingPeriodLabel}
              </p>
            )}

            <div className="pt-2 space-y-3">
              {workSummary.workItems.map((item) => (
                <div
                  key={item.workItemId}
                  className="border border-line rounded p-3 space-y-1"
                >
                  <p>
                    <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
                    <span className="font-medium">{item.workItemDescription}</span>
                  </p>
                  <p>
                    <span className="text-foreground-secondary">Estimated Amount (Scheduled Value):</span>{" "}
                    {item.scheduledValue !== null
                      ? `$${item.scheduledValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                      : "Not set for this work item"}
                  </p>
                  <p>
                    <span className="text-foreground-secondary">Planned Quantity:</span>{" "}
                    <PlannedQuantityEditor
                      actorUserId={supervisorUserId}
                      workItemId={item.workItemId}
                      plannedQuantity={item.plannedQuantity}
                      unitOfMeasure={item.unitOfMeasure}
                    />
                  </p>
                  {(item.progress !== null || item.approvedQuantity !== null) && (
                    <p>
                      <span className="text-foreground-secondary">MTD Progress:</span>{" "}
                      {item.approvedQuantity !== null && (
                        <span className="font-medium">
                          {formatQuantity(item.approvedQuantity)} of {formatQuantity(item.plannedQuantity)}{" "}
                          {item.unitOfMeasure ?? ""} ·{" "}
                        </span>
                      )}
                      <span className="font-medium">{formatPercent(item.progress)}</span>
                      {item.scheduledValue !== null && (
                        <>
                          {" "}
                          <span className="text-foreground-secondary">· Estimated Amount:</span>{" "}
                          <span className="font-medium">
                            {item.estimatedAmount !== null
                              ? `$${item.estimatedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                              : "—"}
                          </span>
                        </>
                      )}{" "}
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          item.isCompleted
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-foreground-secondary"
                        }`}
                      >
                        {item.isCompleted ? "Completed" : "Not Completed"}
                      </span>
                    </p>
                  )}
                </div>
              ))}
            </div>

            <div className="pt-2">
              <p className="text-xs text-foreground-secondary mb-1">
                Distinct pieces of planned construction work — not a count of submissions.
              </p>
              <StatCard label="Total Work Items" value={workSummary.totalWorkItems} />
            </div>

            <div className="pt-2">
              <h3 className="text-xs font-semibold text-foreground-secondary uppercase tracking-wide mb-2">
                Workflow Summary
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <StatCard label="Approved" value={workSummary.approvedCount} />
                <StatCard label="Pending" value={workSummary.pendingCount} />
                <StatCard label="Rolled Back" value={workSummary.rolledBackCount} />
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
