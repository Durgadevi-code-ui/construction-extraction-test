"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

export type ManagedTask = {
  id: string;
  label: string;
  conditional: boolean;
  status: "Active" | "Inactive";
};

type Props = {
  workItemId: string;
  tasks: ManagedTask[];
};

/**
 * Inline "Tasks" configuration for one Work Item — the smallest UI
 * needed to let an authorized Contractor/Supervisor/Manager or
 * Subcontractor/Foreman add/edit/deactivate the actual project-specific
 * tasks a Worker will select from (see /api/workflow/work-item-tasks,
 * lib/workflow.ts createWorkItemTask/updateWorkItemTask). Reused
 * wherever a work item is already listed with an inline editor (same
 * pattern as PlannedQuantityEditor) — AssignmentManager (Subcontractor)
 * and SupervisorPanel (Contractor). Server-side authorization is the
 * real gate (this component renders for any caller who reaches it; a
 * Worker never sees this component at all since it's never rendered on
 * the Worker Dashboard, and the API rejects an unauthorized caller
 * regardless).
 */
export default function WorkItemTaskManager({ workItemId, tasks }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItemId, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed.");
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    if (!newLabel.trim()) return;
    const ok = await post("/api/workflow/work-item-tasks", "POST", { label: newLabel.trim() });
    if (ok) {
      setNewLabel("");
      setAdding(false);
    }
  }

  async function handleSaveEdit(taskId: string) {
    if (!editLabel.trim()) return;
    const ok = await post("/api/workflow/work-item-tasks", "PATCH", { taskId, label: editLabel.trim() });
    if (ok) setEditingId(null);
  }

  async function handleToggleStatus(task: ManagedTask) {
    await post("/api/workflow/work-item-tasks", "PATCH", {
      taskId: task.id,
      status: task.status === "Active" ? "Inactive" : "Active",
    });
  }

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-xs font-medium text-brand hover:underline"
      >
        {expanded ? "Hide Tasks" : `Manage Tasks (${tasks.filter((t) => t.status === "Active").length} active)`}
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1.5 rounded-lg border border-line bg-surface-soft p-2.5">
          {tasks.length === 0 && !adding && (
            <p className="text-xs text-foreground-secondary">No tasks configured yet.</p>
          )}
          {tasks.map((task) => (
            <div key={task.id} className="flex items-center justify-between gap-2 text-xs">
              {editingId === task.id ? (
                <>
                  <Input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    className="!py-1 !text-xs flex-1"
                  />
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" className="!px-2 !py-1 !text-xs" onClick={() => handleSaveEdit(task.id)} disabled={busy}>
                      Save
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="!px-2 !py-1 !text-xs"
                      onClick={() => setEditingId(null)}
                      disabled={busy}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <span className={task.status === "Inactive" ? "text-foreground-muted line-through" : "text-foreground"}>
                    {task.label}
                  </span>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="!px-2 !py-1 !text-xs"
                      onClick={() => {
                        setEditingId(task.id);
                        setEditLabel(task.label);
                      }}
                      disabled={busy}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="!px-2 !py-1 !text-xs"
                      onClick={() => handleToggleStatus(task)}
                      disabled={busy}
                    >
                      {task.status === "Active" ? "Deactivate" : "Reactivate"}
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}

          {adding ? (
            <div className="flex items-center gap-2 pt-1">
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Task name"
                className="!py-1 !text-xs flex-1"
              />
              <Button size="sm" className="!px-2 !py-1 !text-xs" onClick={handleAdd} disabled={busy || !newLabel.trim()}>
                Save
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="!px-2 !py-1 !text-xs"
                onClick={() => {
                  setAdding(false);
                  setNewLabel("");
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="text-xs font-medium text-brand hover:underline pt-1"
            >
              + Add Task
            </button>
          )}

          {error && (
            <p className="rounded border border-error-border bg-error-soft px-2 py-1 text-xs text-error">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
