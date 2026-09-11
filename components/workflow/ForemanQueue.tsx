"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import StatusFlow from "@/components/workflow/StatusFlow";
import { formatPercent } from "@/lib/format";

export type ForemanQueueItem = {
  submissionId: string;
  workerName: string;
  projectName: string;
  departmentName: string;
  workItemCode: string;
  workItemDescription: string;
  submittedProgress: number;
  description: string;
  scheduledValue: number | null;
  estimatedAmount: number | null;
  isCompleted: boolean;
};

type Props = {
  foremanUserId: string;
  items: ForemanQueueItem[];
};

/** Local, not-yet-forwarded edits for one submission — held in the UI
 * only. There is nowhere to persist a Foreman comment/correction before
 * forwarding (the user_validations row that stores them doesn't exist
 * until Forward creates it), so a draft here is sent along with the
 * Forward call rather than saved independently. */
type Draft = { progress?: number; comment?: string };

export default function ForemanQueue({ foremanUserId, items }: Props) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [commentingId, setCommentingId] = useState<string | null>(null);
  const [progressDraft, setProgressDraft] = useState<number>(0);
  const [commentDraft, setCommentDraft] = useState<string>("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleForward(item: ForemanQueueItem) {
    setBusyId(item.submissionId);
    setError(null);
    setSuccessMessage(null);
    try {
      const draft = drafts[item.submissionId];
      const res = await fetch("/api/workflow/foreman", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          foremanUserId,
          action: "submit",
          submissionId: item.submissionId,
          progressPercentage: draft?.progress,
          comment: draft?.comment,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Forward failed.");

      setDrafts((prev) => {
        const next = { ...prev };
        delete next[item.submissionId];
        return next;
      });
      setSuccessMessage("Submission forwarded to Contractor.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Forward failed.");
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="space-y-2">
        {successMessage && <p className="text-sm text-green-600">{successMessage}</p>}
        <p className="text-sm text-foreground-muted">No submissions waiting for review.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {successMessage && <p className="text-sm text-green-600">{successMessage}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {items.map((item) => {
        const draft = drafts[item.submissionId];
        const isEditing = editingId === item.submissionId;
        const isCommenting = commentingId === item.submissionId;
        const currentProgress = draft?.progress ?? item.submittedProgress;
        const displayedProgress = isEditing ? progressDraft : currentProgress;

        return (
          <section
            key={item.submissionId}
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
                <label className="block text-foreground-secondary mb-1">Submitted Progress:</label>
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
                <span className="text-foreground-secondary">Submitted Progress:</span>{" "}
                <span className="font-medium">{formatPercent(displayedProgress)}</span>
              </p>
            )}

            {isCommenting ? (
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                rows={2}
                placeholder="Add a comment…"
                className="w-full rounded border border-line px-2 py-1"
              />
            ) : (
              draft?.comment && (
                <p>
                  <span className="text-foreground-secondary">Comment:</span> {draft.comment}
                </p>
              )
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
              <span className="font-medium">Awaiting Subcontractor Review</span>{" "}
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
            <StatusFlow statusCode="AWAITING_FOREMAN_REVIEW" />

            <div className="flex gap-2 pt-1 flex-wrap">
              {isEditing ? (
                <>
                  <button
                    onClick={() => {
                      setDrafts((prev) => ({
                        ...prev,
                        [item.submissionId]: { ...prev[item.submissionId], progress: progressDraft },
                      }));
                      setEditingId(null);
                    }}
                    className="text-xs px-3 py-1.5 rounded bg-brand text-white"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    setEditingId(item.submissionId);
                    setProgressDraft(currentProgress);
                  }}
                  className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
                >
                  Edit
                </button>
              )}

              {isCommenting ? (
                <>
                  <button
                    onClick={() => {
                      setDrafts((prev) => ({
                        ...prev,
                        [item.submissionId]: { ...prev[item.submissionId], comment: commentDraft },
                      }));
                      setCommentingId(null);
                    }}
                    className="text-xs px-3 py-1.5 rounded bg-brand text-white"
                  >
                    Save Comment
                  </button>
                  <button
                    onClick={() => setCommentingId(null)}
                    className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => {
                    setCommentingId(item.submissionId);
                    setCommentDraft(draft?.comment ?? "");
                  }}
                  className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
                >
                  Add Comment
                </button>
              )}

              <button
                onClick={() => handleForward(item)}
                disabled={busyId === item.submissionId}
                className="text-xs px-3 py-1.5 rounded bg-green-600 text-white disabled:opacity-50"
              >
                {busyId === item.submissionId ? "Forwarding…" : "Forward to Contractor"}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
