"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import PlannedQuantityEditor from "./PlannedQuantityEditor";
import WorkItemTaskManager from "./WorkItemTaskManager";
import LiveUpdateFeed from "@/components/workflow/LiveUpdateFeed";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/ui/EmptyState";
import Input, { Select } from "@/components/ui/Input";
import { Search, Users } from "lucide-react";

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
  /** This work item's own task list (Active and Inactive) — see
   * lib/workflow.ts WorkItemTask. Optional only so any older caller
   * that doesn't pass it keeps compiling; every real caller (see
   * app/workflow/foreman/page.tsx) supplies it. */
  tasks?: { id: string; label: string; conditional: boolean; status: "Active" | "Inactive" }[];
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
  // Toggled inline directly under the Department heading — never a
  // navigation to the general Live Updates tab. Image-only
  // (mode="imageOnly"), no per-item filter: the underlying feed is
  // already scoped server-side to THIS Subcontractor's own department
  // (see /api/workflow/live-updates listLiveUpdatesForReviewer), so it
  // can never show another department's images.
  const [showLiveUpdates, setShowLiveUpdates] = useState(false);
  // Search narrows the work item list and the active assignments below
  // (case-insensitive, client-side over data already loaded) — the Assign
  // form's pickers always keep the full list.
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = (...texts: (string | null | undefined)[]) =>
    !needle || texts.some((t) => (t ?? "").toLowerCase().includes(needle));
  const shownWorkItems = workItems.filter((w) =>
    matches(w.code, w.description, ...(w.tasks ?? []).map((t) => t.label))
  );
  const shownAssignments = assignments.filter((a) =>
    matches(a.workItemCode, a.workItemDescription, a.workerDisplayName, a.workerEmail)
  );

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
    <Card className="space-y-4 text-sm">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm">
          <span className="text-foreground-secondary">Department:</span>{" "}
          <span className="font-medium text-foreground">{departmentName}</span>
        </p>
        <Button variant="secondary" size="sm" onClick={() => setShowLiveUpdates((v) => !v)}>
          {showLiveUpdates ? "Hide Live Updates" : "View Live Updates"}
        </Button>
      </div>

      {showLiveUpdates && (
        <div className="rounded-lg border border-line bg-surface-soft p-3">
          <LiveUpdateFeed mode="imageOnly" />
        </div>
      )}

      <div>
        <h2 className="font-semibold text-foreground">Work Item Management</h2>
        <p className="text-xs text-foreground-secondary mt-0.5">
          Assign work items to workers, set planned quantities and manage tasks for your department.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground-muted"
          strokeWidth={2}
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by code, name, task or worker"
          aria-label="Search work items"
          className="pl-9"
        />
      </div>
      {needle && shownWorkItems.length === 0 && shownAssignments.length === 0 && (
        <p className="text-foreground-muted">No work items or assignments match “{query.trim()}”.</p>
      )}

      {error && (
        <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
      )}

      {shownWorkItems.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-foreground-secondary uppercase tracking-wide mb-2">
            Work Items — Planned Quantity &amp; Tasks
          </h3>
          <div className="divide-y divide-line">
            {shownWorkItems.map((w) => (
              <div key={w.workItemId} className="py-2 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{w.code}</span> — {w.description}
                  </span>
                  <PlannedQuantityEditor
                    actorUserId={subcontractorUserId}
                    workItemId={w.workItemId}
                    plannedQuantity={w.plannedQuantity}
                    unitOfMeasure={w.unitOfMeasure}
                  />
                </div>
                <WorkItemTaskManager workItemId={w.workItemId} tasks={w.tasks ?? []} />
              </div>
            ))}
          </div>
        </div>
      )}

      {workers.length === 0 ? (
        <p className="text-foreground-muted">No active workers in {departmentName} yet.</p>
      ) : workItems.length === 0 ? (
        <p className="text-foreground-muted">No work items configured for {departmentName} yet.</p>
      ) : (
        <form
          onSubmit={handleAssign}
          className="flex flex-wrap items-end gap-2 rounded-lg border border-line-soft bg-surface-soft p-3"
        >
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Worker</label>
            <Select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
              {workers.map((w) => (
                <option key={w.userId} value={w.userId}>
                  {w.displayName} ({w.email})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Work Item</label>
            <Select value={workItemId} onChange={(e) => setWorkItemId(e.target.value)}>
              {workItems.map((w) => (
                <option key={w.workItemId} value={w.workItemId}>
                  {w.code} — {w.description}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Assigning…" : "Assign"}
          </Button>
        </form>
      )}

      <div>
        <h3 className="text-xs font-medium text-foreground-secondary uppercase tracking-wide mb-2">
          Active Assignments{needle ? ` (${shownAssignments.length} of ${assignments.length})` : ` (${assignments.length})`}
        </h3>
        {assignments.length === 0 ? (
          <EmptyState icon={Users} title="No work items assigned yet" />
        ) : shownAssignments.length === 0 ? (
          <p className="text-foreground-muted">No assignments match “{query.trim()}”.</p>
        ) : (
          <div className="divide-y divide-line">
            {shownAssignments.map((row) => {
              const key = `${row.workItemId}:${row.userId}`;
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-2 py-2.5 transition-colors duration-150 hover:bg-surface-hover"
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="brand" dot={false}>
                      {row.workItemCode}
                    </Badge>
                    <span className="text-foreground-secondary">{row.workItemDescription}</span>
                    <span className="text-foreground-muted">→</span>
                    <span className="font-medium">{row.workerDisplayName}</span>
                    <span className="text-foreground-muted">({row.workerEmail})</span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleRemove(row)}
                    disabled={busyRowKey === key}
                  >
                    {busyRowKey === key ? "Removing…" : "Remove"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
