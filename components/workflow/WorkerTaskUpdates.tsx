"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { formatDateUS, formatPercent, formatTimeUS } from "@/lib/format";
import { errorMessage, readApiJson } from "@/lib/apiClient";
import type { WorkItemTaskView } from "@/components/workflow/WorkItemSelector";

/**
 * A Worker's view of one assigned work item's tasks (My Assigned Work →
 * Tasks): each task's latest task-level update, and — only where the
 * Contractor/Subcontractor turned Task Update Access on — an inline
 * form to record progress %, mark it done and add a short note
 * (/api/workflow/task-progress, which re-checks assignment, task and
 * access server-side). Tasks without access say so: their progress goes
 * through the normal Work Item update. A Worker can't add, rename,
 * remove or reassign tasks here.
 */
export default function WorkerTaskUpdates({
  workItemId,
  workItemLabel,
  tasks,
}: {
  workItemId: string;
  workItemLabel: string;
  tasks: WorkItemTaskView[];
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [percent, setPercent] = useState("");
  const [completed, setCompleted] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  function startEdit(task: WorkItemTaskView) {
    setEditingId(task.id);
    setPercent(task.progress?.percent != null ? String(task.progress.percent) : "");
    setCompleted(task.progress?.completed ?? false);
    setNote("");
    setError(null);
    setSavedId(null);
  }

  async function save(taskId: string) {
    const value = percent.trim() === "" ? null : Number(percent);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) {
      setError("Enter a progress between 0 and 100.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/workflow/task-progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItemId, taskId, percent: value, completed, note: note.trim() || null }),
      });
      await readApiJson(res, "The task update couldn't be saved. Please try again.");
      setEditingId(null);
      setSavedId(taskId);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err, "The task update couldn't be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-line-soft bg-surface-soft px-4 py-3 space-y-2 text-sm">
      <p className="text-xs font-semibold text-foreground">
        Tasks for <span className="text-brand">{workItemLabel}</span>
      </p>
      <ul className="divide-y divide-line rounded-lg border border-line bg-white">
        {tasks.map((task) => (
          <li key={task.id} className="px-3 py-2.5 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="font-medium text-foreground">{task.label}</span>
                {task.conditional && <span className="text-xs text-foreground-muted"> (if applicable)</span>}
              </span>
              <span className="flex items-center gap-2">
                {task.progress?.completed ? (
                  <Badge variant="success">Done</Badge>
                ) : task.progress?.percent != null ? (
                  <Badge variant="info">{formatPercent(task.progress.percent)}</Badge>
                ) : (
                  <Badge variant="neutral">No update yet</Badge>
                )}
                {task.updateAccess && editingId !== task.id && (
                  <Button variant="secondary" size="sm" onClick={() => startEdit(task)}>
                    Update task
                  </Button>
                )}
              </span>
            </div>
            {task.progress && (
              <p className="text-xs text-foreground-secondary">
                Last update {formatDateUS(task.progress.updatedAt, "/")} {formatTimeUS(task.progress.updatedAt)} by{" "}
                {task.progress.updatedByName}
                {task.progress.note ? ` — “${task.progress.note}”` : ""}
              </p>
            )}
            {savedId === task.id && <p className="text-xs text-success">Task update saved.</p>}
            {!task.updateAccess && (
              <p className="text-xs text-foreground-muted">
                Task updates aren&apos;t turned on for this task — report its progress through Update Progress.
              </p>
            )}
            {editingId === task.id && (
              <div className="space-y-2 rounded-lg border border-line bg-surface-soft p-2.5">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-foreground-secondary">
                    Progress
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={percent}
                      onChange={(e) => setPercent(e.target.value)}
                      className="!w-20 !py-1 tabular-nums"
                      aria-label={`Progress for ${task.label} (%)`}
                    />
                    %
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-foreground-secondary">
                    <input type="checkbox" checked={completed} onChange={(e) => setCompleted(e.target.checked)} />
                    Mark task done
                  </label>
                </div>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  maxLength={1000}
                  placeholder="What was done on this task? (optional)"
                  className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
                {error && <p className="text-xs text-error">{error}</p>}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => save(task.id)} disabled={busy}>
                    {busy ? "Saving…" : "Save task update"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditingId(null)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-foreground-muted">
        Task updates are your own report on each task. Work item progress is still approved through Update Progress.
      </p>
    </div>
  );
}
