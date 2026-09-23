"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { TrendingUp, ClipboardList, ListChecks, CheckCircle2, Clock, AlertTriangle } from "lucide-react";
import { formatPercent, formatQuantity, humanizeApprovalStatus } from "@/lib/format";
import StatusFlow from "@/components/workflow/StatusFlow";
import PlannedQuantityEditor from "@/components/workflow/PlannedQuantityEditor";
import WorkItemTaskManager from "@/components/workflow/WorkItemTaskManager";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import Input from "@/components/ui/Input";

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
  /** This work item's own task list (Active and Inactive) — see
   * lib/workflow.ts WorkItemTask. */
  tasks?: { id: string; label: string; conditional: boolean; status: "Active" | "Inactive" }[];
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
    <Card className="space-y-2 text-sm">
      <h2 className="font-semibold text-foreground">{title}</h2>
      {items.length === 0 ? (
        <p className="text-foreground-muted">No work items.</p>
      ) : (
        <div className="divide-y divide-line">
          {items.map((item) => (
            <p key={item.workItemId} className="py-2 first:pt-0 last:pb-0">
              <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
              <span>{item.workItemDescription}:</span>{" "}
              {item.approvedQuantity !== null && (
                <span className="font-medium tabular-nums">
                  {formatQuantity(item.approvedQuantity)} of {formatQuantity(item.plannedQuantity)}{" "}
                  {item.unitOfMeasure ?? ""} ·{" "}
                </span>
              )}
              <span className="font-medium tabular-nums">{formatPercent(item.progress)}</span>
            </p>
          ))}
        </div>
      )}
    </Card>
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
    <Card className="space-y-2 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-foreground-muted tabular-nums">
          {items.length} submission{items.length === 1 ? "" : "s"}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="text-foreground-muted">No submissions.</p>
      ) : !expanded ? (
        <button
          onClick={() => setExpanded(true)}
          className="text-sm text-brand transition-colors duration-150 hover:underline"
        >
          {detailsLabel}
        </button>
      ) : (
        <>
          <button
            onClick={() => setExpanded(false)}
            className="text-sm text-brand transition-colors duration-150 hover:underline"
          >
            Hide Details
          </button>
          <div className="divide-y divide-line">
            {items.map((item) => (
              <div key={item.submissionId} className="py-2.5 first:pt-0 last:pb-0 space-y-0.5">
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
                  <span className="font-medium tabular-nums">
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
    </Card>
  );
}

type ExecutiveSummaryPeriod = "daily" | "weekly" | "monthly";

type ExecutiveSummaryData = {
  projectName: string;
  departmentName: string;
  periodLabel: string;
  overallProgress: number | null;
  updatesSubmitted: number;
  workItemsUpdated: number;
  approvedCount: number;
  pendingCount: number;
  rolledBackCount: number;
  attentionRequired: string | null;
  topWorkItems: {
    workItemCode: string;
    workItemDescription: string;
    progress: number | null;
    statusLabel: "Completed" | "In Progress" | "Not Started";
  }[];
};

const PERIOD_TABS: { key: ExecutiveSummaryPeriod; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

/** One at-a-glance KPI tile — the building block of the executive-
 * friendly layout (see lib/workflow.ts getExecutiveSummary's doc): a
 * label + a number, never a paragraph. */
type KpiTone = "brand" | "success" | "warning";

const KPI_ICON_CHIP: Record<KpiTone, string> = {
  brand: "bg-brand text-white",
  success: "bg-success text-white",
  warning: "bg-warning text-white",
};

const KPI_CARD_TINT: Record<KpiTone, string> = {
  brand: "border-line bg-white",
  success: "border-line bg-white",
  warning: "border-warning-border bg-warning-soft",
};

function KpiTile({
  label,
  value,
  icon: Icon,
  tone = "brand",
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone?: KpiTone;
}) {
  return (
    <div className={`flex flex-col gap-2 rounded-lg border p-3 ${KPI_CARD_TINT[tone]}`}>
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${KPI_ICON_CHIP[tone]}`}>
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div>
        <p className="text-lg font-bold tabular-nums text-foreground leading-tight">{value}</p>
        <p className="text-xs text-foreground-secondary">{label}</p>
      </div>
    </div>
  );
}

/**
 * Executive Summary — structured KPIs computed from real application
 * data (see lib/workflow.ts getExecutiveSummary via
 * app/api/workflow/daily-summary/route.ts), NOT an AI-written
 * paragraph: a CEO/PM should understand project status within a few
 * seconds. Daily/Weekly/Monthly share one fetch/render path, only the
 * `period` sent to the API changes.
 */
function ExecutiveSummaryCard() {
  const [period, setPeriod] = useState<ExecutiveSummaryPeriod>("daily");
  const [summary, setSummary] = useState<ExecutiveSummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // `loading`/`error` reset on a period switch happens in the button's
  // own click handler below (a user event), not here — the effect only
  // ever fetches and reports the result. This avoids a synchronous
  // setState call inside the effect body itself (see
  // react-hooks/set-state-in-effect) while still showing "Loading…"
  // immediately on both the initial mount (loading starts true) and
  // every subsequent tab switch.
  useEffect(() => {
    let ignore = false;
    fetch("/api/workflow/daily-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not load the summary.");
        if (!ignore) setSummary(data.summary);
      })
      .catch((err) => {
        if (!ignore) setError(err instanceof Error ? err.message : "Could not load the summary.");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [period]);

  function selectPeriod(next: ExecutiveSummaryPeriod) {
    setPeriod(next);
    setLoading(true);
    setError(null);
  }

  return (
    <Card className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-semibold text-foreground">Executive Summary</h2>
        <div className="flex gap-1">
          {PERIOD_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectPeriod(t.key)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors duration-150 ${
                period === t.key
                  ? "bg-brand text-white"
                  : "bg-surface-soft text-foreground-secondary hover:bg-surface-hover"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="text-foreground-muted">Loading…</p>}
      {error && <p className="text-error">{error}</p>}

      {summary && !loading && (
        <div className="space-y-3">
          <div>
            <p className="font-semibold text-foreground">{summary.projectName}</p>
            <p className="text-xs text-foreground-secondary">
              {summary.departmentName} · {summary.periodLabel}
            </p>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            <KpiTile
              icon={TrendingUp}
              label="Progress"
              value={summary.overallProgress !== null ? `${summary.overallProgress}%` : "—"}
            />
            <KpiTile icon={ClipboardList} label="Updates Submitted" value={String(summary.updatesSubmitted)} />
            <KpiTile icon={ListChecks} label="Work Items Updated" value={String(summary.workItemsUpdated)} />
            <KpiTile icon={CheckCircle2} label="Approved" value={String(summary.approvedCount)} tone="success" />
            <KpiTile
              icon={Clock}
              label="Pending"
              value={String(summary.pendingCount)}
              tone={summary.pendingCount > 0 ? "warning" : "brand"}
            />
            <KpiTile
              icon={AlertTriangle}
              label="Attention Required"
              value={summary.attentionRequired ? String(summary.pendingCount + summary.rolledBackCount) : "0"}
              tone={summary.attentionRequired ? "warning" : "brand"}
            />
          </div>

          {summary.attentionRequired && (
            <p className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning">
              ⚠ {summary.attentionRequired}
            </p>
          )}

          {summary.topWorkItems.length > 0 && (
            <div className="divide-y divide-line rounded-lg border border-line overflow-hidden">
              {summary.topWorkItems.map((w) => (
                <div key={w.workItemCode} className="flex items-center justify-between gap-2 px-3 py-2 bg-white">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate">{w.workItemDescription}</p>
                    <p className="text-xs text-foreground-secondary">{w.workItemCode}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-semibold tabular-nums text-foreground">
                      {w.progress !== null ? `${w.progress}%` : "—"}
                    </p>
                    <p
                      className={`text-xs ${
                        w.statusLabel === "Completed"
                          ? "text-success"
                          : w.statusLabel === "In Progress"
                            ? "text-info"
                            : "text-foreground-secondary"
                      }`}
                    >
                      {w.statusLabel}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

type MtdStatTone = "brand" | "success" | "warning" | "error";

const MTD_STAT_ICON_CHIP: Record<MtdStatTone, string> = {
  brand: "bg-brand text-white",
  success: "bg-success text-white",
  warning: "bg-warning text-white",
  error: "bg-error text-white",
};

function StatCard({
  label,
  value,
  icon: Icon,
  tone = "brand",
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone?: MtdStatTone;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-white p-3">
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${MTD_STAT_ICON_CHIP[tone]}`}>
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div>
        <p className="text-lg font-bold text-foreground tabular-nums leading-tight">{value}</p>
        <p className="text-xs text-foreground-secondary">{label}</p>
      </div>
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
  // Universal Approve: which queue items are ticked, plus a ref-based lock
  // (state alone can lag a rapid double-click) so repeated clicks can
  // never fire a second batch while one is in flight.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkLock = useRef(false);

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

  // Only items this panel can actually approve right now — has a
  // validation row and isn't already APPROVED.
  const eligibleIds = currentItems
    .filter((item) => item.validationId && item.approvalStatus !== "APPROVED")
    .map((item) => item.validationId as string);
  const selectedEligible = eligibleIds.filter((id) => selectedIds.has(id));

  function toggleSelected(validationId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(validationId)) next.delete(validationId);
      else next.add(validationId);
      return next;
    });
  }

  function selectAllEligible() {
    setSelectedIds(new Set(eligibleIds));
  }

  // One button, one existing endpoint: each selected item goes through
  // the same per-item "approve" action (and its server-side permission/
  // validation checks) an individual Approve click uses.
  async function approveSelected() {
    if (bulkLock.current || selectedEligible.length === 0) return;
    bulkLock.current = true;
    setBulkBusy(true);
    setError(null);
    const failed: string[] = [];
    for (const id of selectedEligible) {
      try {
        await post(id, { action: "approve" });
      } catch (err) {
        failed.push(err instanceof Error ? err.message : "Action failed.");
      }
    }
    setSelectedIds(new Set());
    if (failed.length > 0) {
      setError(
        `${selectedEligible.length - failed.length} approved, ${failed.length} failed: ${failed[0]}`
      );
    }
    router.refresh();
    setBulkBusy(false);
    bulkLock.current = false;
  }

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
      <Card key={validationId} className="space-y-2 text-sm">
        {eligibleIds.includes(validationId) && (
          <label className="flex items-center gap-2 text-xs text-foreground-secondary">
            <input
              type="checkbox"
              checked={selectedIds.has(validationId)}
              onChange={() => toggleSelected(validationId)}
              onDoubleClick={selectAllEligible}
              disabled={bulkBusy}
              title="Double-click to select all eligible items"
            />
            Select for approval
          </label>
        )}
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
        ) : item.correctedProgress !== null ? (
          <>
            <p>
              <span className="text-foreground-secondary">Corrected Progress:</span>{" "}
              <span className="font-medium tabular-nums">{formatPercent(displayedProgress)}</span>
            </p>
            <p>
              <span className="text-foreground-secondary">Originally Submitted:</span>{" "}
              <span className="tabular-nums">{formatPercent(item.submittedProgress)}</span>
            </p>
          </>
        ) : (
          <p>
            <span className="text-foreground-secondary">Submitted Progress:</span>{" "}
            <span className="font-medium tabular-nums">{formatPercent(displayedProgress)}</span>
          </p>
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
          <span className="font-medium">{humanizeApprovalStatus(item.approvalStatus)}</span>
          <Badge variant={item.isCompleted ? "success" : "neutral"}>
            {item.isCompleted ? "Completed" : "Not Completed"}
          </Badge>
        </p>
        <StatusFlow statusCode={approvalStatusFlowCode(item.approvalStatus)} />

        {isCommenting && (
          <textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            rows={2}
            placeholder="Add a comment…"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
        )}

        <div className="flex gap-2 pt-1 flex-wrap">
          <Button size="sm" onClick={() => run(validationId, "approve")} disabled={busyId === validationId || bulkBusy}>
            Approve
          </Button>
          {!isEditing ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditingId(validationId);
                setProgressDraft(currentProgress);
              }}
            >
              Edit
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => run(validationId, "edit", { progressPercentage: progressDraft })}
                disabled={busyId === validationId}
              >
                Save
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditingId(null)}
                disabled={busyId === validationId}
              >
                Cancel
              </Button>
            </>
          )}
          {!isCommenting ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCommentingId(validationId);
                setCommentDraft("");
              }}
            >
              Add Comment
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => run(validationId, "comment", { comment: commentDraft })}
                disabled={busyId === validationId}
              >
                Save Comment
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCommentingId(null)}
                disabled={busyId === validationId}
              >
                Cancel
              </Button>
            </>
          )}
          {item.approvalStatus === "APPROVED" && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => run(validationId, "rollback")}
              disabled={busyId === validationId}
            >
              Rollback
            </Button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {!forcedTab && (
        <div className="flex gap-2">
          <Button variant={tab === "today" ? "primary" : "secondary"} size="sm" onClick={() => setTab("today")}>
            Today&apos;s Progress
          </Button>
          <Button variant={tab === "mtd" ? "primary" : "secondary"} size="sm" onClick={() => setTab("mtd")}>
            MTD / Work Summary
          </Button>
        </div>
      )}

      {activeTab === "today" ? (
        <div className="space-y-6">
          <ExecutiveSummaryCard />
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
            className="inline-block text-sm text-brand transition-colors duration-150 hover:underline"
          >
            View Submission History
          </Link>

          <div>
            <h2 className="font-semibold text-foreground mb-3">Today&apos;s Work Summary</h2>
            {error && (
              <p className="mb-2 rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">
                {error}
              </p>
            )}
            {queue.length === 0 ? (
              <p className="text-sm text-foreground-muted">No submissions to review.</p>
            ) : currentItems.length === 0 ? (
              <p className="text-sm text-foreground-muted">No current work items.</p>
            ) : (
              <div className="space-y-4">
                {eligibleIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-soft px-3 py-2 text-sm">
                    <label
                      className="flex items-center gap-2 text-foreground-secondary"
                      title="Double-click to select all eligible items"
                    >
                      <input
                        type="checkbox"
                        checked={selectedEligible.length === eligibleIds.length}
                        onChange={() =>
                          selectedEligible.length === eligibleIds.length
                            ? setSelectedIds(new Set())
                            : selectAllEligible()
                        }
                        onDoubleClick={selectAllEligible}
                        disabled={bulkBusy}
                      />
                      Select
                    </label>
                    <Button
                      size="sm"
                      onClick={approveSelected}
                      disabled={bulkBusy || selectedEligible.length === 0}
                    >
                      {bulkBusy ? "Approving…" : `Approve${selectedEligible.length ? ` (${selectedEligible.length})` : ""}`}
                    </Button>
                    <span className="text-xs text-foreground-muted">
                      Tick items to approve them together. Double-click the checkbox to select all.
                    </span>
                  </div>
                )}
                {currentItems.map(renderQueueItem)}
              </div>
            )}

            {historyItems.length > 0 && (
              <div className="mt-4">
                <button
                  onClick={() => setShowHistory((v) => !v)}
                  className="text-sm text-brand transition-colors duration-150 hover:underline"
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

          <Card className="space-y-3 text-sm">
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

            <div className="pt-2 divide-y divide-line">
              {workSummary.workItems.map((item) => (
                <div key={item.workItemId} className="py-3 first:pt-0 last:pb-0 space-y-1">
                  <p>
                    <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
                    <span className="font-medium">{item.workItemDescription}</span>
                  </p>
                  <p>
                    <span className="text-foreground-secondary">Estimated Amount (Scheduled Value):</span>{" "}
                    <span className="tabular-nums">
                      {item.scheduledValue !== null
                        ? `$${item.scheduledValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                        : "Not set for this work item"}
                    </span>
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
                  <WorkItemTaskManager workItemId={item.workItemId} tasks={item.tasks ?? []} />
                  {(item.progress !== null || item.approvedQuantity !== null) && (
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="text-foreground-secondary">MTD Progress:</span>{" "}
                      {item.approvedQuantity !== null && (
                        <span className="font-medium tabular-nums">
                          {formatQuantity(item.approvedQuantity)} of {formatQuantity(item.plannedQuantity)}{" "}
                          {item.unitOfMeasure ?? ""} ·{" "}
                        </span>
                      )}
                      <span className="font-medium tabular-nums">{formatPercent(item.progress)}</span>
                      {item.scheduledValue !== null && (
                        <>
                          <span className="text-foreground-secondary">· Estimated Amount:</span>{" "}
                          <span className="font-medium tabular-nums">
                            {item.estimatedAmount !== null
                              ? `$${item.estimatedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                              : "—"}
                          </span>
                        </>
                      )}
                      <Badge variant={item.isCompleted ? "success" : "neutral"}>
                        {item.isCompleted ? "Completed" : "Not Completed"}
                      </Badge>
                    </p>
                  )}
                </div>
              ))}
            </div>

            <div className="pt-2">
              <p className="text-xs text-foreground-secondary mb-1">
                Distinct pieces of planned construction work — not a count of submissions.
              </p>
              <StatCard icon={ListChecks} label="Total Work Items" value={workSummary.totalWorkItems} />
            </div>

            <div className="pt-2">
              <h3 className="text-xs font-semibold text-foreground-secondary uppercase tracking-wide mb-2">
                Workflow Summary
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <StatCard icon={CheckCircle2} label="Approved" value={workSummary.approvedCount} tone="success" />
                <StatCard icon={Clock} label="Pending" value={workSummary.pendingCount} tone="warning" />
                <StatCard icon={AlertTriangle} label="Rolled Back" value={workSummary.rolledBackCount} tone="error" />
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
