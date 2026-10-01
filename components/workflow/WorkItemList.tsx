"use client";

import { Fragment, useState } from "react";
import { Camera } from "lucide-react";
import ProgressBar from "@/components/workflow/charts/ProgressBar";
import { useCountUp } from "@/components/workflow/useCountUp";
import LiveUpdateFeed from "@/components/workflow/LiveUpdateFeed";
import { formatMoney, formatPercent } from "@/lib/format";
import Badge, { type BadgeVariant } from "@/components/ui/Badge";
import Button from "@/components/ui/Button";

export type WorkItemStatus = { label: string; variant: BadgeVariant };

/** One status rule for every Work Items list (Contractor and
 * Subcontractor): Inactive (deactivated), Completed, Stuck (only where
 * the caller has that signal — see lib/dashboard.ts), Pending (no
 * approved progress yet), otherwise In Progress. Display only. */
export function workItemStatus(item: {
  isCompleted: boolean;
  isStuck?: boolean;
  progressPercentage: number | null;
  inactive?: boolean;
}): WorkItemStatus {
  if (item.inactive) return { label: "Inactive", variant: "neutral" };
  if (item.isCompleted) return { label: "Completed", variant: "success" };
  if (item.isStuck) return { label: "Stuck", variant: "error" };
  if (item.progressPercentage === null) return { label: "Pending", variant: "neutral" };
  return { label: "In Progress", variant: "warning" };
}

export type WorkItemListRow = {
  workItemId: string;
  code: string;
  description: string;
  /** Shown under the name when present (multi-department scopes). */
  departmentName?: string | null;
  progressPercentage: number | null;
  /** Earned value at that progress — omitted/null shows no amount. */
  earnedAmount?: number | null;
  status: WorkItemStatus;
  /** Workers column text (only rendered with showWorkers). */
  workersLabel?: string;
  workersTitle?: string;
  /** Muted row (e.g. a deactivated work item). */
  dimmed?: boolean;
  /** Small label next to the code (e.g. the Worker's "Current" item). */
  tag?: string;
  /** One muted line under the name (e.g. the work item's tasks). */
  detail?: string;
};

/** A row's progress bar + percentage, counting up 0 → value on load
 * (display only, see useCountUp). One count-up drives the number, the
 * bar width and its shared progress-band color, so all three stay in
 * step and stop on the real value. */
function WorkItemProgress({ percent }: { percent: number | null }) {
  const shown = useCountUp(percent);
  return (
    <div className="flex items-center gap-2">
      <div className="w-20">
        <ProgressBar percent={shown} countingUp />
      </div>
      <span className="text-xs text-foreground-secondary whitespace-nowrap tabular-nums">
        {formatPercent(shown)}
      </span>
    </div>
  );
}

/** Every track has a FIXED width (Work Item takes the rest). The header
 * and each row are separate grids, so an `auto` Actions track would be
 * sized per row by its own buttons — fixed tracks keep Work Item /
 * Progress / Status / (Workers) / Actions lined up under their headings
 * on every row. Actions is wide enough for the widest set any caller
 * renders: View Updates alone, or Manage/Activate + View Updates (with
 * the Workers column — the Subcontractor's Work Item Management). */
const COLS = "sm:grid-cols-[minmax(0,1fr)_9.5rem_7rem_9rem]";
const COLS_WITH_WORKERS = "sm:grid-cols-[minmax(0,1fr)_9.5rem_7rem_6.5rem_13.5rem]";

/**
 * Shared Work Items list — one layout for the Contractor's Work Items
 * tab (DashboardPanel), the Subcontractor's Work Item Management
 * (AssignmentManager) and the Worker's My Assigned Work (WorkerTabs): Work Item · Progress · Status · (Workers) ·
 * Actions, with a "View Updates" button in the same place on every
 * row that expands the existing image-only LiveUpdateFeed for that work
 * item inline. Role differences come in as capabilities from the caller
 * — `renderActions` (e.g. the Subcontractor's Manage/Activate) and
 * `renderDetail` (the expanded management panel) — never decided here.
 * Purely presentational: every action a caller renders is still
 * authorized server-side by its own API.
 */
export default function WorkItemList({
  rows,
  showWorkers = false,
  showLiveUpdates = true,
  renderActions,
  renderDetail,
  focusedWorkItemId = null,
}: {
  rows: WorkItemListRow[];
  /** Row a notification points at — highlighted and marked data-focused
   * for the page's scroll-into-view (Worker's ?item= link). */
  focusedWorkItemId?: string | null;
  showWorkers?: boolean;
  showLiveUpdates?: boolean;
  renderActions?: (row: WorkItemListRow) => React.ReactNode;
  /** Expanded content under a row, or null when closed. */
  renderDetail?: (row: WorkItemListRow) => React.ReactNode | null;
}) {
  // Which work item's Live Updates panel is open (one at a time).
  const [liveUpdatesFor, setLiveUpdatesFor] = useState<string | null>(null);
  const cols = showWorkers ? COLS_WITH_WORKERS : COLS;

  return (
    <div className="text-sm">
      <div
        className={`hidden sm:grid ${cols} gap-3 bg-surface-soft px-4 py-2.5 text-[11px] uppercase tracking-wide text-foreground-muted font-medium`}
      >
        <span>Work Item</span>
        <span>Progress</span>
        <span>Status</span>
        {showWorkers && <span>Workers</span>}
        <span>Actions</span>
      </div>
      <div className="divide-y divide-line">
        {rows.map((row) => {
          const detail = renderDetail?.(row) ?? null;
          const liveOpen = liveUpdatesFor === row.workItemId;
          return (
            <Fragment key={row.workItemId}>
              <div
                data-focused={row.workItemId === focusedWorkItemId ? "true" : undefined}
                className={`scroll-mt-4 grid grid-cols-1 ${cols} items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors duration-150 hover:bg-surface-hover ${
                  row.dimmed ? "bg-surface-soft/60 text-foreground-muted" : ""
                } ${row.workItemId === focusedWorkItemId ? "bg-warning-soft/40 ring-2 ring-inset ring-warning-border" : ""}`}
              >
                <div className="min-w-0">
                  <span className="font-medium">{row.code}</span>{" "}
                  {row.tag && (
                    <span className="mr-1 inline-flex rounded-full bg-brand-soft px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-brand">
                      {row.tag}
                    </span>
                  )}
                  <span className={row.dimmed ? "" : "text-foreground-secondary"}>— {row.description}</span>
                  {row.departmentName && (
                    <span className="block text-xs text-foreground-muted">{row.departmentName}</span>
                  )}
                  {row.detail && <span className="block text-xs text-foreground-muted">{row.detail}</span>}
                </div>
                <div>
                  <WorkItemProgress percent={row.progressPercentage} />
                  {row.earnedAmount !== null && row.earnedAmount !== undefined && (
                    <p className="mt-0.5 text-[11px] text-foreground-muted tabular-nums">
                      {formatMoney(row.earnedAmount)} earned
                    </p>
                  )}
                </div>
                <div>
                  <Badge variant={row.status.variant}>{row.status.label}</Badge>
                </div>
                {showWorkers && (
                  <div className="truncate text-foreground-secondary" title={row.workersTitle}>
                    {row.workersLabel}
                  </div>
                )}
                {/* Left-aligned like its heading, so the buttons start
                    directly under "Actions" on every row. */}
                <div className="flex flex-wrap items-center gap-2">
                  {renderActions?.(row)}
                  {showLiveUpdates && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setLiveUpdatesFor((prev) => (prev === row.workItemId ? null : row.workItemId))}
                      aria-expanded={liveOpen}
                    >
                      <Camera className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      {liveOpen ? "Hide Updates" : "View Updates"}
                    </Button>
                  )}
                </div>
              </div>
              {detail}
              {/* Directly under the row it belongs to — image-only, scoped to
                  exactly this work item (initialFilterCode); the feed itself
                  is fetched server-scoped to this reviewer's own project/
                  department (see /api/workflow/live-updates). */}
              {showLiveUpdates && liveOpen && (
                <div className="border-t border-line-soft bg-surface-soft px-4 py-4">
                  <LiveUpdateFeed mode="imageOnly" initialFilterCode={row.code} />
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
