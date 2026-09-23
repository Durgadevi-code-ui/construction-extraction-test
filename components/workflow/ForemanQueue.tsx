"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import StatusFlow from "@/components/workflow/StatusFlow";
import { formatPercent } from "@/lib/format";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import Input from "@/components/ui/Input";

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkLock = useRef(false);

  async function forwardOne(item: ForemanQueueItem) {
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
  }

  async function handleForward(item: ForemanQueueItem) {
    setBusyId(item.submissionId);
    setError(null);
    setSuccessMessage(null);
    try {
      await forwardOne(item);
      setSuccessMessage("Submission forwarded to Contractor.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Forward failed.");
    } finally {
      setBusyId(null);
    }
  }

  // Universal action for the Subcontractor: this queue's approval step is
  // "Forward to Contractor" (the only action it has), so the one button
  // runs that same per-item action over the ticked items. A ref lock
  // stops repeated clicks from starting a second batch.
  const selectedItems = items.filter((item) => selectedIds.has(item.submissionId));
  const allSelected = items.length > 0 && selectedItems.length === items.length;

  function selectAll() {
    setSelectedIds(new Set(items.map((item) => item.submissionId)));
  }

  async function forwardSelected() {
    if (bulkLock.current || selectedItems.length === 0) return;
    bulkLock.current = true;
    setBulkBusy(true);
    setError(null);
    setSuccessMessage(null);
    let done = 0;
    let firstError: string | null = null;
    for (const item of selectedItems) {
      try {
        await forwardOne(item);
        done += 1;
      } catch (err) {
        firstError ??= err instanceof Error ? err.message : "Forward failed.";
      }
    }
    setSelectedIds(new Set());
    if (done > 0) setSuccessMessage(`${done} submission${done === 1 ? "" : "s"} forwarded to Contractor.`);
    if (firstError) setError(`${selectedItems.length - done} failed: ${firstError}`);
    router.refresh();
    setBulkBusy(false);
    bulkLock.current = false;
  }

  if (items.length === 0) {
    return (
      <div className="space-y-2">
        {successMessage && (
          <p className="rounded-lg border border-success-border bg-success-soft px-3 py-2 text-sm text-success">
            {successMessage}
          </p>
        )}
        <p className="text-sm text-foreground-muted">No submissions waiting for review.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {successMessage && (
        <p className="rounded-lg border border-success-border bg-success-soft px-3 py-2 text-sm text-success">
          {successMessage}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-soft px-3 py-2 text-sm">
        <label
          className="flex items-center gap-2 text-foreground-secondary"
          title="Double-click to select all items"
        >
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => (allSelected ? setSelectedIds(new Set()) : selectAll())}
            onDoubleClick={selectAll}
            disabled={bulkBusy}
          />
          Select
        </label>
        <Button size="sm" onClick={forwardSelected} disabled={bulkBusy || selectedItems.length === 0}>
          {bulkBusy ? "Forwarding…" : `Forward to Contractor${selectedItems.length ? ` (${selectedItems.length})` : ""}`}
        </Button>
        <span className="text-xs text-foreground-muted">
          Tick items to forward them together. Double-click the checkbox to select all.
        </span>
      </div>
      {items.map((item) => {
        const draft = drafts[item.submissionId];
        const isEditing = editingId === item.submissionId;
        const isCommenting = commentingId === item.submissionId;
        const currentProgress = draft?.progress ?? item.submittedProgress;
        const displayedProgress = isEditing ? progressDraft : currentProgress;

        return (
          <Card key={item.submissionId} className="space-y-2 text-sm">
            <label className="flex items-center gap-2 text-xs text-foreground-secondary">
              <input
                type="checkbox"
                checked={selectedIds.has(item.submissionId)}
                onChange={() =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.submissionId)) next.delete(item.submissionId);
                    else next.add(item.submissionId);
                    return next;
                  })
                }
                onDoubleClick={selectAll}
                disabled={bulkBusy}
                title="Double-click to select all items"
              />
              Select to forward
            </label>
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
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={progressDraft}
                    onChange={(e) => setProgressDraft(Number(e.target.value))}
                    className="w-24 tabular-nums"
                  />
                  %
                </div>
              </div>
            ) : (
              <p>
                <span className="text-foreground-secondary">Submitted Progress:</span>{" "}
                <span className="font-medium tabular-nums">{formatPercent(displayedProgress)}</span>
              </p>
            )}

            {isCommenting ? (
              <textarea
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                rows={2}
                placeholder="Add a comment…"
                className="w-full rounded-lg border border-line px-3 py-2 text-sm transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
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
                <span className="font-medium tabular-nums">
                  {item.estimatedAmount !== null
                    ? `$${item.estimatedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                    : "—"}
                </span>
              </p>
            )}
            <p className="flex flex-wrap items-center gap-1.5">
              <span className="text-foreground-secondary">Status:</span>{" "}
              <span className="font-medium">Awaiting Subcontractor Review</span>
              <Badge variant={item.isCompleted ? "success" : "neutral"}>
                {item.isCompleted ? "Completed" : "Not Completed"}
              </Badge>
            </p>
            <StatusFlow statusCode="AWAITING_FOREMAN_REVIEW" />

            <div className="flex gap-2 pt-1 flex-wrap">
              {isEditing ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      setDrafts((prev) => ({
                        ...prev,
                        [item.submissionId]: { ...prev[item.submissionId], progress: progressDraft },
                      }));
                      setEditingId(null);
                    }}
                  >
                    Save
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setEditingId(item.submissionId);
                    setProgressDraft(currentProgress);
                  }}
                >
                  Edit
                </Button>
              )}

              {isCommenting ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      setDrafts((prev) => ({
                        ...prev,
                        [item.submissionId]: { ...prev[item.submissionId], comment: commentDraft },
                      }));
                      setCommentingId(null);
                    }}
                  >
                    Save Comment
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setCommentingId(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setCommentingId(item.submissionId);
                    setCommentDraft(draft?.comment ?? "");
                  }}
                >
                  Add Comment
                </Button>
              )}

              <Button size="sm" onClick={() => handleForward(item)} disabled={busyId === item.submissionId || bulkBusy}>
                {busyId === item.submissionId ? "Forwarding…" : "Forward to Contractor"}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
