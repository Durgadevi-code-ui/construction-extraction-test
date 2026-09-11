"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import PlannedQuantityEditor from "./PlannedQuantityEditor";

export type AssignmentWorkerOption = {
  userId: string;
  email: string;
  displayName: string;
};

export type AssignmentWorkItemOption = {
  workItemId: string;
  code: string;
  description: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
};

export type AssignmentRow = {
  workItemId: string;
  workItemCode: string;
  workItemDescription: string;
  userId: string;
  workerDisplayName: string;
  workerEmail: string;
};

type Props = {
  subcontractorUserId: string;
  departmentName: string;
  workers: AssignmentWorkerOption[];
  workItems: AssignmentWorkItemOption[];
  assignments: AssignmentRow[];
};

/**
 * Subcontractor-facing Work Item <-> Worker assignment management —
 * writes to the existing work_item_assignments table (see
 * assignWorkItemToWorker/removeWorkItemAssignment in lib/workflow.ts).
 * Every action here is scoped server-side to this Subcontractor's own
 * department; the worker/work-item pickers below only ever list this
 * department's own data (from getForemanAssignmentBoard), but the
 * department/role checks happen again on the server regardless.
 */
export default function AssignmentManager({
  subcontractorUserId,
  departmentName,
  workers,
  workItems,
  assignments,
}: Props) {
  const router = useRouter();
  const [workerId, setWorkerId] = useState(workers[0]?.userId ?? "");
  const [workItemId, setWorkItemId] = useState(workItems[0]?.workItemId ?? "");
  const [busy, setBusy] = useState(false);
  const [busyRowKey, setBusyRowKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/workflow/foreman/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subcontractorUserId, ...body }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error ?? "Request failed.");
    }
  }

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    if (!workerId || !workItemId) return;
    setBusy(true);
    setError(null);
    try {
      await post({ action: "assign", workerUserId: workerId, workItemId });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assign failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(row: AssignmentRow) {
    const key = `${row.workItemId}:${row.userId}`;
    setBusyRowKey(key);
    setError(null);
    try {
      await post({ action: "remove", workerUserId: row.userId, workItemId: row.workItemId });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed.");
    } finally {
      setBusyRowKey(null);
    }
  }

  return (
    <section className="bg-white rounded-lg border border-line p-4 space-y-4 text-sm">
      <div>
        <h2 className="font-semibold text-foreground">Work Item Assignments</h2>
        <p className="text-xs text-foreground-secondary mt-0.5">
          Assign {departmentName} work items to workers in your department.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {workItems.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-foreground-secondary mb-2">Planned Quantity</h3>
          <ul className="space-y-1">
            {workItems.map((w) => (
              <li key={w.workItemId} className="flex items-center justify-between gap-2 py-1">
                <span>
                  <span className="font-medium">{w.code}</span> — {w.description}
                </span>
                <PlannedQuantityEditor
                  actorUserId={subcontractorUserId}
                  workItemId={w.workItemId}
                  plannedQuantity={w.plannedQuantity}
                  unitOfMeasure={w.unitOfMeasure}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {workers.length === 0 ? (
        <p className="text-foreground-muted">No active workers in {departmentName} yet.</p>
      ) : workItems.length === 0 ? (
        <p className="text-foreground-muted">No work items configured for {departmentName} yet.</p>
      ) : (
        <form onSubmit={handleAssign} className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Worker</label>
            <select
              value={workerId}
              onChange={(e) => setWorkerId(e.target.value)}
              className="rounded border border-line px-2 py-1.5 text-sm"
            >
              {workers.map((w) => (
                <option key={w.userId} value={w.userId}>
                  {w.displayName} ({w.email})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Work Item</label>
            <select
              value={workItemId}
              onChange={(e) => setWorkItemId(e.target.value)}
              className="rounded border border-line px-2 py-1.5 text-sm"
            >
              {workItems.map((w) => (
                <option key={w.workItemId} value={w.workItemId}>
                  {w.code} — {w.description}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-brand text-white text-sm font-medium px-4 py-1.5 disabled:opacity-50"
          >
            {busy ? "Assigning…" : "Assign"}
          </button>
        </form>
      )}

      <div>
        <h3 className="text-xs font-medium text-foreground-secondary mb-2">Currently Assigned</h3>
        {assignments.length === 0 ? (
          <p className="text-foreground-muted">No work items assigned yet.</p>
        ) : (
          <ul className="space-y-1">
            {assignments.map((row) => {
              const key = `${row.workItemId}:${row.userId}`;
              return (
                <li
                  key={key}
                  className="flex items-center justify-between gap-2 py-1 border-b border-line last:border-0"
                >
                  <span>
                    <span className="font-medium">{row.workItemCode}</span>
                    {" — "}
                    {row.workItemDescription}
                    {" -> "}
                    {row.workerDisplayName} ({row.workerEmail})
                  </span>
                  <button
                    onClick={() => handleRemove(row)}
                    disabled={busyRowKey === key}
                    className="text-xs px-2 py-1 rounded border border-line text-foreground-secondary hover:bg-surface-soft disabled:opacity-50"
                  >
                    {busyRowKey === key ? "Removing…" : "Remove"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
