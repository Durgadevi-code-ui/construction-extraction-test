"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import PlannedQuantityEditor from "./PlannedQuantityEditor";
import WorkItemTaskManager from "./WorkItemTaskManager";
import WorkItemList, { workItemStatus, type WorkItemListRow } from "@/components/workflow/WorkItemList";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/ui/EmptyState";
import Input from "@/components/ui/Input";
import { ClipboardList, Search, X } from "lucide-react";

import { errorMessage, readApiJson } from "@/lib/apiClient";
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
  /** Cumulative approved progress (WorkItemOption.progressPercentage) and
   * completion — shown in the shared Work Items list, same as the
   * Contractor's. Optional so a caller without them still compiles. */
  progressPercentage?: number | null;
  isCompleted?: boolean;
  /** Earned value at that progress (calculateEstimatedAmount). */
  earnedAmount?: number | null;
};

/** A deactivated work item (see lib/workflow.ts setWorkItemActive). */
export type AssignmentInactiveWorkItem = {
  workItemId: string;
  code: string;
  description: string;
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
  /** Deactivated work items, listed so they can be reactivated. */
  inactiveWorkItems?: AssignmentInactiveWorkItem[];
  /** Show Activate/Deactivate for work items — only for callers the
   * server authorizes to configure work items (the department's own
   * Subcontractor); a Worker Assignment delegation alone does not. */
  canChangeWorkItemStatus?: boolean;
};

/**
 * Subcontractor-facing Work Item Management, rendered through the shared
 * WorkItemList (same layout and per-row "View Updates" as the
 * Contractor's Work Items) with this role's capabilities added: Manage
 * (assign/remove workers, planned quantity, tasks, deactivate) and
 * Activate for deactivated items. Writes to the existing
 * work_item_assignments table (assignWorkItemToWorker /
 * removeWorkItemAssignment in lib/workflow.ts) and work_items.status
 * (setWorkItemActive). Many-to-many by design: one work item can have
 * several workers and one worker several work items — each pair is its
 * own assignment row, so removing one worker never touches another.
 * Every action is scoped and authorized server-side regardless of what
 * this UI offers.
 */
export default function AssignmentManager({
  subcontractorUserId,
  departmentName,
  workers,
  workItems,
  assignments,
  inactiveWorkItems = [],
  canChangeWorkItemStatus = false,
}: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // Which work item's Manage panel is open (one at a time).
  const [openId, setOpenId] = useState<string | null>(null);
  // Workers ticked in the open panel's "Add workers" list.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = (...texts: (string | null | undefined)[]) =>
    !needle || texts.some((t) => (t ?? "").toLowerCase().includes(needle));

  const assignedTo = (workItemId: string) => assignments.filter((a) => a.workItemId === workItemId);

  // Search: code, name, task, or an assigned worker's name/email.
  const shownWorkItems = workItems.filter((w) =>
    matches(
      w.code,
      w.description,
      ...(w.tasks ?? []).map((t) => t.label),
      ...assignedTo(w.workItemId).flatMap((a) => [a.workerDisplayName, a.workerEmail])
    )
  );
  const shownInactive = inactiveWorkItems.filter((w) => matches(w.code, w.description));
  const workItemById = new Map(workItems.map((w) => [w.workItemId, w]));
  const inactiveIds = new Set(inactiveWorkItems.map((w) => w.workItemId));

  // One worker -> their active work items (assignments on a deactivated
  // work item are kept but not counted here).
  const byWorker = workers
    .map((worker) => ({
      worker,
      items: assignments.filter((a) => a.userId === worker.userId && workItemById.has(a.workItemId)),
    }))
    .filter(
      ({ worker, items }) =>
        matches(worker.displayName, worker.email) ||
        items.some((a) => matches(a.workItemCode, a.workItemDescription))
    );

  async function postAssignment(body: Record<string, unknown>) {
    const res = await fetch("/api/workflow/foreman/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subcontractorUserId, ...body }),
    });
    await readApiJson(res, "The assignment couldn't be saved. Please try again.");
  }

  function toggleOpen(workItemId: string) {
    setOpenId((prev) => (prev === workItemId ? null : workItemId));
    setSelected(new Set());
    setError(null);
  }

  function toggleSelected(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  // One request per selected worker (the existing assign API) — each
  // creates or reactivates its own (work item, worker) row.
  async function assignSelected(workItemId: string) {
    if (selected.size === 0) return;
    setBusyKey(`assign:${workItemId}`);
    setError(null);
    const failed: string[] = [];
    for (const workerUserId of selected) {
      try {
        await postAssignment({ action: "assign", workerUserId, workItemId });
      } catch (err) {
        const name = workers.find((w) => w.userId === workerUserId)?.displayName ?? workerUserId;
        failed.push(`${name}: ${errorMessage(err, "Assign failed.")}`);
      }
    }
    setBusyKey(null);
    setSelected(new Set());
    if (failed.length > 0) setError(failed.join(" · "));
    router.refresh();
  }

  async function removeAssignment(row: AssignmentRow) {
    const key = `remove:${row.workItemId}:${row.userId}`;
    setBusyKey(key);
    setError(null);
    try {
      await postAssignment({ action: "remove", workerUserId: row.userId, workItemId: row.workItemId });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err, "Remove failed."));
    } finally {
      setBusyKey(null);
    }
  }

  async function setActive(workItemId: string, active: boolean) {
    if (!active && !window.confirm("Deactivate this work item? Workers will no longer see it. Its history and assignments are kept, and you can activate it again at any time.")) {
      return;
    }
    setBusyKey(`status:${workItemId}`);
    setError(null);
    try {
      const res = await fetch("/api/workflow/work-item-status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItemId, active }),
      });
      await readApiJson(res, "The work item status couldn't be changed. Please try again.");
      if (!active) setOpenId(null);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err, "Status change failed."));
    } finally {
      setBusyKey(null);
    }
  }

  const rows: WorkItemListRow[] = [
    ...shownWorkItems.map((w) => {
      const assigned = assignedTo(w.workItemId);
      const progressPercentage = w.progressPercentage ?? null;
      return {
        workItemId: w.workItemId,
        code: w.code,
        description: w.description,
        progressPercentage,
        earnedAmount: w.earnedAmount ?? null,
        status: workItemStatus({ isCompleted: w.isCompleted ?? false, progressPercentage }),
        workersLabel: assigned.length === 0 ? "None" : `${assigned.length} worker${assigned.length === 1 ? "" : "s"}`,
        workersTitle: assigned.map((a) => a.workerDisplayName).join(", "),
      };
    }),
    ...shownInactive.map((w) => {
      const kept = assignedTo(w.workItemId).length;
      return {
        workItemId: w.workItemId,
        code: w.code,
        description: w.description,
        progressPercentage: null,
        status: workItemStatus({ isCompleted: false, progressPercentage: null, inactive: true }),
        workersLabel: kept === 0 ? "None" : `${kept} kept`,
        workersTitle: "Kept, and restored on activation",
        dimmed: true,
      };
    }),
  ];

  function renderActions(row: WorkItemListRow) {
    if (inactiveIds.has(row.workItemId)) {
      return canChangeWorkItemStatus ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setActive(row.workItemId, true)}
          disabled={busyKey === `status:${row.workItemId}`}
        >
          {busyKey === `status:${row.workItemId}` ? "Activating…" : "Activate"}
        </Button>
      ) : null;
    }
    const open = openId === row.workItemId;
    return (
      <Button variant={open ? "primary" : "secondary"} size="sm" onClick={() => toggleOpen(row.workItemId)}>
        {open ? "Close" : "Manage"}
      </Button>
    );
  }

  function renderDetail(row: WorkItemListRow) {
    const w = workItemById.get(row.workItemId);
    if (!w || openId !== row.workItemId) return null;
    const assigned = assignedTo(w.workItemId);
    const assignedIds = new Set(assigned.map((a) => a.userId));
    const available = workers.filter((wk) => !assignedIds.has(wk.userId));
    return (
      <div className="space-y-3 border-t border-line-soft bg-surface-soft px-4 py-3">
        <div>
          <p className="text-xs font-medium text-foreground-secondary mb-1.5">Assigned workers ({assigned.length})</p>
          {assigned.length === 0 ? (
            <p className="text-foreground-muted">No workers assigned yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {assigned.map((a) => {
                const key = `remove:${a.workItemId}:${a.userId}`;
                return (
                  <span
                    key={a.userId}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface pl-2.5 pr-1 py-0.5 text-xs"
                    title={a.workerEmail}
                  >
                    {a.workerDisplayName}
                    <button
                      type="button"
                      onClick={() => removeAssignment(a)}
                      disabled={busyKey === key}
                      aria-label={`Remove ${a.workerDisplayName} from ${w.code}`}
                      className="rounded-full p-0.5 text-foreground-muted transition-colors duration-150 hover:bg-error-soft hover:text-error disabled:opacity-50"
                    >
                      <X className="h-3 w-3" strokeWidth={2.5} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <p className="text-xs font-medium text-foreground-secondary mb-1.5">Add workers</p>
          {workers.length === 0 ? (
            <p className="text-foreground-muted">No active workers in {departmentName} yet.</p>
          ) : available.length === 0 ? (
            <p className="text-foreground-muted">Every worker in {departmentName} is already assigned.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              {available.map((wk) => (
                <label key={wk.userId} className="flex items-center gap-1.5 text-xs" title={wk.email}>
                  <input type="checkbox" checked={selected.has(wk.userId)} onChange={() => toggleSelected(wk.userId)} />
                  {wk.displayName}
                </label>
              ))}
              <Button
                size="sm"
                onClick={() => assignSelected(w.workItemId)}
                disabled={selected.size === 0 || busyKey === `assign:${w.workItemId}`}
              >
                {busyKey === `assign:${w.workItemId}` ? "Assigning…" : `Assign${selected.size ? ` (${selected.size})` : ""}`}
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
          <span className="flex items-center gap-2">
            <span className="text-xs text-foreground-secondary">Planned quantity:</span>
            <PlannedQuantityEditor
              actorUserId={subcontractorUserId}
              workItemId={w.workItemId}
              plannedQuantity={w.plannedQuantity}
              unitOfMeasure={w.unitOfMeasure}
            />
          </span>
          {canChangeWorkItemStatus && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setActive(w.workItemId, false)}
              disabled={busyKey === `status:${w.workItemId}`}
            >
              {busyKey === `status:${w.workItemId}` ? "Deactivating…" : "Deactivate work item"}
            </Button>
          )}
        </div>
        <WorkItemTaskManager workItemId={w.workItemId} tasks={w.tasks ?? []} />
      </div>
    );
  }

  const noMatches = needle && shownWorkItems.length === 0 && shownInactive.length === 0 && byWorker.length === 0;

  return (
    <Card className="space-y-4 text-sm">
      {/* Department sits to the right of the title (not its own line) to
          keep the card's header compact. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-foreground">Work Item Management</h2>
          <p className="text-xs text-foreground-secondary mt-0.5">
            Assign workers, set planned quantities, manage tasks and activate or deactivate work items for your department.
            Each work item&apos;s photos and voice notes are under View Updates.
          </p>
        </div>
        <p className="text-sm shrink-0">
          <span className="text-foreground-secondary">Department:</span>{" "}
          <span className="font-medium text-foreground">{departmentName}</span>
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
      {noMatches && <p className="text-foreground-muted">No work items or workers match “{query.trim()}”.</p>}

      {error && (
        <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
      )}

      {/* Workers sit in a right-hand column beside the list on wide
          screens instead of below it; stacked as before on smaller ones. */}
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_15rem] 2xl:items-start">
      {workItems.length === 0 && inactiveWorkItems.length === 0 ? (
        <EmptyState icon={ClipboardList} title={`No work items configured for ${departmentName} yet`} />
      ) : (
        rows.length > 0 && (
          <div className="rounded-lg border border-line overflow-hidden">
            <WorkItemList rows={rows} showWorkers renderActions={renderActions} renderDetail={renderDetail} />
          </div>
        )
      )}

      {workers.length > 0 && byWorker.length > 0 && (
        <div className="2xl:rounded-lg 2xl:border 2xl:border-line 2xl:p-3">
          <h3 className="text-xs font-medium text-foreground-secondary uppercase tracking-wide mb-2">
            Workers ({byWorker.length})
          </h3>
          <div className="divide-y divide-line">
            {byWorker.map(({ worker, items }) => (
              <div key={worker.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-medium" title={worker.email}>
                  {worker.displayName}
                </span>
                <span className="text-xs text-foreground-muted">
                  {items.length} work item{items.length === 1 ? "" : "s"}
                </span>
                <span className="flex flex-wrap gap-1">
                  {items.map((a) => (
                    <button
                      key={a.workItemId}
                      type="button"
                      onClick={() => toggleOpen(a.workItemId)}
                      title={`${a.workItemDescription} — open to manage`}
                    >
                      <Badge variant="brand" dot={false}>
                        {a.workItemCode}
                      </Badge>
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
    </Card>
  );
}
