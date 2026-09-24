"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ListChecks, CheckCircle2, Clock, AlertTriangle } from "lucide-react";
import { formatPercent, formatQuantity, humanizeApprovalStatus } from "@/lib/format";
import StatusFlow from "@/components/workflow/StatusFlow";
import PlannedQuantityEditor from "@/components/workflow/PlannedQuantityEditor";
import WorkItemTaskManager from "@/components/workflow/WorkItemTaskManager";
import DashboardPanel from "@/components/workflow/DashboardPanel";
import LiveUpdateFeed from "@/components/workflow/LiveUpdateFeed";
import { useCountUp } from "@/components/workflow/useCountUp";
import { progressColorClass } from "@/lib/progressColor";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import Input from "@/components/ui/Input";
import type { DashboardData } from "@/lib/dashboard";

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
 * status — read-only (review/approve stays in Today Reviews below,
 * unchanged).
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
  totalWorkItems: number;
  completedWorkItems: number;
  earnedAmount: number | null;
  scheduledAmount: number | null;
  topWorkItems: {
    workItemCode: string;
    workItemDescription: string;
    progress: number | null;
    statusLabel: "Completed" | "In Progress" | "Not Started";
    touchedInPeriod: boolean;
  }[];
};

/** Brief title / "What happened …" wording per period — display only. */
const PERIOD_WORDING: Record<ExecutiveSummaryPeriod, { title: string; happened: string }> = {
  daily: { title: "Today's Project Brief", happened: "What happened today" },
  weekly: { title: "This Week's Project Brief", happened: "What happened this week" },
  monthly: { title: "Month-to-Date Project Brief", happened: "What happened this month" },
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const CHANGE_LABEL: Record<ExecutiveSummaryPeriod, string> = {
  daily: "Today's Change",
  weekly: "This Week's Change",
  monthly: "This Month's Change",
};

function formatMoney(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** Overall Progress figure + bar, counting up 0 → value on load (display
 * only — see useCountUp), colored by the shared progress-health bands. */
function AnimatedOverallProgress({ percent }: { percent: number | null }) {
  const shown = useCountUp(percent);
  return (
    <>
      <p className={`text-2xl font-bold tabular-nums leading-none ${progressColorClass(percent)}`}>
        {shown !== null ? `${shown}%` : "—"}
      </p>
      <p className="text-xs text-foreground-secondary">Overall Progress</p>
    </>
  );
}

function AnimatedBar({ percent }: { percent: number }) {
  const shown = useCountUp(percent) ?? 0;
  return (
    <div className="h-1.5 rounded-full bg-surface-soft overflow-hidden" aria-hidden>
      <div
        className={`h-full rounded-full ${progressColorClass(percent, "bg")}`}
        style={{ width: `${Math.min(100, Math.max(0, shown))}%` }}
      />
    </div>
  );
}

const PERIOD_TABS: { key: ExecutiveSummaryPeriod; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

/**
 * Executive Summary — structured KPIs computed from real application
 * data (see lib/workflow.ts getExecutiveSummary via
 * app/api/workflow/daily-summary/route.ts), NOT an AI-written
 * paragraph: a CEO/PM should understand project status within a few
 * seconds. Daily/Weekly/Monthly share one fetch/render path, only the
 * `period` sent to the API changes.
 *
 * Rendered as a short operational brief (not KPI tiles): how the project
 * is doing, what changed in the period, and what needs attention, with a
 * jump to Today Reviews. Purely a presentation choice — every value is
 * still the same `summary` fetched below, nothing hardcoded and nothing
 * recalculated here. "What happened" lists only work items with
 * touchedInPeriod (a submission within the selected period), never items
 * that merely carry older progress.
 */
export function ExecutiveSummaryCard({
  onReviewSubmissions,
  showTotals = true,
  projectId,
}: {
  onReviewSubmissions: () => void;
  /** Project context for a Contractor with roles on several projects —
   * sent to the summary API, which resolves it among the caller's own
   * roles. Omitted = the first role (single-project behavior). */
  projectId?: string;
  /** Show the project totals (Overall Progress figure/bar, earned vs
   * scheduled, Completed/Remaining Work). The Subcontractor Dashboard
   * turns this off — its KPI cards already show exactly those numbers —
   * leaving the period change, what happened and what needs attention. */
  showTotals?: boolean;
}) {
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
      body: JSON.stringify({ period, projectId }),
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
  }, [period, projectId]);

  function selectPeriod(next: ExecutiveSummaryPeriod) {
    setPeriod(next);
    setLoading(true);
    setError(null);
  }

  return (
    <Card className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-semibold text-foreground">{PERIOD_WORDING[period].title}</h2>
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

      {summary && !loading && (() => {
        const changed = summary.topWorkItems.filter((w) => w.touchedInPeriod);
        // topWorkItems is capped server-side; workItemsUpdated is the true
        // count of distinct work items touched in the period.
        const notListed = Math.max(0, summary.workItemsUpdated - changed.length);
        const needsAttention = summary.pendingCount > 0 || summary.rolledBackCount > 0;

        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-foreground truncate">{summary.projectName}</p>
                <p className="text-xs text-foreground-secondary">
                  {/department$/i.test(summary.departmentName)
                    ? summary.departmentName
                    : `${summary.departmentName} Department`}{" "}
                  ·{" "}
                  {period === "daily"
                    ? new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" })
                    : summary.periodLabel}
                </p>
              </div>
              {showTotals && (
              <div className="text-right">
                <AnimatedOverallProgress percent={summary.overallProgress} />
                {summary.earnedAmount !== null && summary.scheduledAmount !== null && (
                  <p className="text-xs text-foreground-secondary tabular-nums mt-0.5">
                    {formatMoney(summary.earnedAmount)} earned / {formatMoney(summary.scheduledAmount)} scheduled
                  </p>
                )}
              </div>
              )}
            </div>
            {showTotals && summary.overallProgress !== null && <AnimatedBar percent={summary.overallProgress} />}

            {/* Executive Summary — short lines (the Overall Progress figure
                is the large number above), every value straight
                from the same summary response (no paragraph, no new math
                beyond subtraction of two returned totals). */}
            <ul className={`grid gap-x-6 gap-y-1.5 text-sm ${showTotals ? "sm:grid-cols-2" : ""}`}>
              {showTotals && (
              <>
              <li className="flex justify-between gap-3 border-b border-line-soft pb-1">
                <span className="text-foreground-secondary">Completed Work</span>
                <span className="font-medium tabular-nums">
                  {summary.completedWorkItems} of {plural(summary.totalWorkItems, "work item")}
                </span>
              </li>
              <li className="flex justify-between gap-3 border-b border-line-soft pb-1">
                <span className="text-foreground-secondary">Remaining Work</span>
                <span className="font-medium tabular-nums text-right">
                  {plural(summary.totalWorkItems - summary.completedWorkItems, "work item")}
                  {summary.earnedAmount !== null && summary.scheduledAmount !== null
                    ? ` · ${formatMoney(Math.max(0, summary.scheduledAmount - summary.earnedAmount))}`
                    : ""}
                </span>
              </li>
              </>
              )}
              <li className="flex justify-between gap-3 border-b border-line-soft pb-1">
                <span className="text-foreground-secondary">{CHANGE_LABEL[period]}</span>
                <span className="font-medium tabular-nums text-right">
                  {summary.updatesSubmitted === 0
                    ? "No updates"
                    : `${plural(summary.updatesSubmitted, "update")} · ${summary.approvedCount} approved`}
                </span>
              </li>
            </ul>

            <div>
              <h3 className="text-xs font-semibold text-foreground-secondary uppercase tracking-wide mb-1.5">
                {PERIOD_WORDING[period].happened}
              </h3>
              {changed.length === 0 ? (
                <p className="text-foreground-muted">No work items updated during this period.</p>
              ) : (
                <ul className="space-y-1">
                  {changed.map((w) => (
                    <li key={w.workItemCode} className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate">
                        <span className="text-foreground-secondary">{w.workItemCode}</span>{" "}
                        <span className="text-foreground">— {w.workItemDescription}</span>
                      </span>
                      <span
                        className={`shrink-0 font-medium tabular-nums ${
                          w.statusLabel === "Completed"
                            ? "text-success"
                            : w.statusLabel === "In Progress"
                              ? "text-info"
                              : "text-foreground-secondary"
                        }`}
                      >
                        {w.progress !== null ? `${w.progress}%` : "—"} {w.statusLabel}
                      </span>
                    </li>
                  ))}
                  {notListed > 0 && (
                    <li className="text-xs text-foreground-muted">+{notListed} more updated</li>
                  )}
                </ul>
              )}
            </div>

            <div
              className={`rounded-lg border px-3 py-2.5 ${
                needsAttention ? "border-warning-border bg-warning-soft" : "border-line bg-surface-soft"
              }`}
            >
              <h3 className="text-xs font-semibold text-foreground-secondary uppercase tracking-wide mb-1">
                What needs your attention
              </h3>
              {needsAttention ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <ul className="text-warning font-medium">
                    {summary.pendingCount > 0 && (
                      <li>{plural(summary.pendingCount, "submission")} waiting for review</li>
                    )}
                    {summary.rolledBackCount > 0 && (
                      <li>{plural(summary.rolledBackCount, "submission")} returned for correction</li>
                    )}
                  </ul>
                  <Button size="sm" onClick={onReviewSubmissions}>
                    Review Submissions
                  </Button>
                </div>
              ) : (
                <p className="text-foreground-secondary">Nothing needs your attention right now.</p>
              )}
            </div>
          </div>
        );
      })()}
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
  dashboardData,
  todaySection,
  onReviewSubmissions,
  focusSubmissionId = null,
  focusWorkItemCode = null,
  projectId,
}: Props & {
  /** When set, this panel shows only that one view and hides its own
   * Today's Progress/MTD Summary tab switcher — used by
   * ContractorTabs.tsx, which now owns those two as separate top-level
   * Contractor tabs. Omitted (default), this component keeps its
   * original standalone behavior: its own switcher, starting on
   * "today". Nothing about the underlying data/actions changes either
   * way. */
  forcedTab?: "today" | "mtd";
  /** Same data ContractorTabs already fetched for its Department
   * Progress tab (lib/dashboard.ts, via /api/workflow/dashboard) —
   * passed through so the "today" view can render that existing
   * DashboardPanel(sections=["departments"]) inline as part of Today
   * Progress, with no second fetch and no duplicated logic. Omitted by
   * any caller with nothing to show here (e.g. the "mtd" forcedTab
   * instance) — Department Progress then simply doesn't render. */
  dashboardData?: DashboardData;
  /** Which part of the "today" view to render: "summary" (the brief only
   * — the Contractor Dashboard tab) or "reviews" (Today Reviews + today's
   * submission activity — the Reviews tab). Omitted, the full original
   * "today" view renders unchanged. */
  todaySection?: "summary" | "reviews";
  /** Overrides the brief's "Review Submissions" action (e.g. switch to
   * the Reviews tab); default scrolls to Today Reviews on this page. */
  onReviewSubmissions?: () => void;
  /** Submission to scroll to and lightly highlight (from a notification's
   * "View Queue" link) — display only. */
  focusSubmissionId?: string | null;
  /** Fallback focus when the notification carries no submission (or it's
   * no longer queued): highlight this work item's card(s) instead. */
  focusWorkItemCode?: string | null;
  /** Project context for the brief (see ExecutiveSummaryCard). */
  projectId?: string;
}) {
  const focusBySubmission = !!focusSubmissionId && queue.some((q) => q.submissionId === focusSubmissionId);
  const router = useRouter();
  const [tab, setTab] = useState<"today" | "mtd">(forcedTab ?? "today");
  const activeTab = forcedTab ?? tab;
  // Target of the brief's "Review Submissions" action — scrolls to the
  // existing Today Reviews section below, no navigation/route change.
  const todayReviewsRef = useRef<HTMLDivElement>(null);
  // Which review card has its Live Updates expanded (one at a time).
  const [liveUpdatesFor, setLiveUpdatesFor] = useState<string | null>(null);
  // Bring a notification's target record into view once rendered.
  useEffect(() => {
    if (!focusSubmissionId && !focusWorkItemCode) return;
    const timer = setTimeout(() => {
      document.querySelector("[data-focused=true]")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 300);
    return () => clearTimeout(timer);
  }, [focusSubmissionId, focusWorkItemCode]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [commentingId, setCommentingId] = useState<string | null>(null);
  const [progressDraft, setProgressDraft] = useState<number>(0);
  const [commentDraft, setCommentDraft] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Open "Previously Completed Work" up front when the focused record is in it.
  const [showHistory, setShowHistory] = useState(
    () =>
      queue.some(
        (q) =>
          q.approvalStatus === "APPROVED" &&
          ((!!focusSubmissionId && q.submissionId === focusSubmissionId) ||
            (!!focusWorkItemCode && q.workItemCode === focusWorkItemCode))
      )
  );
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

    const isFocused = focusBySubmission
      ? item.submissionId === focusSubmissionId
      : !!focusWorkItemCode && item.workItemCode === focusWorkItemCode;
    return (
      <div
        key={validationId}
        id={`review-${item.submissionId}`}
        data-focused={isFocused ? "true" : undefined}
        className={`scroll-mt-4 rounded-lg ${isFocused ? "ring-2 ring-warning-border ring-offset-2 ring-offset-background" : ""}`}
      >
      <Card className="space-y-2 text-sm">
        {isFocused && <Badge variant="warning">From your notification</Badge>}
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
                ? `$${item.estimatedAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLiveUpdatesFor((v) => (v === validationId ? null : validationId))}
          >
            {liveUpdatesFor === validationId ? "Hide live updates" : "Live updates"}
          </Button>
        </div>
        {/* Worker photos/voice notes for THIS work item — the existing
            reviewer feed, filtered to the item (read-only evidence). */}
        {liveUpdatesFor === validationId && (
          <div className="border-t border-line pt-3">
            <LiveUpdateFeed initialFilterCode={item.workItemCode} />
          </div>
        )}
      </Card>
      </div>
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
          {todaySection !== "reviews" && (
          <ExecutiveSummaryCard
            onReviewSubmissions={
              onReviewSubmissions ??
              (() => todayReviewsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
            }
            projectId={projectId}
          />
          )}

          {/* Department Progress, consolidated into Today Progress —
              same DashboardPanel component/fetch/filters the standalone
              "Department Progress" tab uses (see ContractorTabs.tsx),
              just mounted here too so it reads as part of one Today
              Progress section instead of a separate destination. */}
          {!todaySection && dashboardData && (
            <DashboardPanel userId={supervisorUserId} initialData={dashboardData} sections={["departments"]} />
          )}

          {todaySection !== "summary" && (
          <>
          <div id="today-reviews" ref={todayReviewsRef} className="scroll-mt-4">
            <h2 className="font-semibold text-foreground mb-3">Today Reviews</h2>
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

          {/* Read-only Today/Yesterday submission activity (collapsed by
              default) — kept, just placed after Today Reviews so the
              brief leads straight into Department Progress. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <SubmissionActivityCard
              title="Today's Submissions"
              items={todaysProgress}
              detailsLabel="View Today's Details"
            />
            <SubmissionActivityCard
              title="Yesterday"
              items={yesterdaysProgress}
              detailsLabel="View Yesterday's Details"
            />
          </div>

          {/* Submission History — a clear access point (not a separate
              top-level nav item), reusing the existing
              /workflow/supervisor/history page/route and its own
              existing data-fetching (getSubmissionHistory) as-is; no
              new history system, no duplicated query. */}
          </>
          )}
          {!todaySection && (
          <Card className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold text-foreground">Submission History</h2>
              <p className="text-sm text-foreground-secondary">
                View all previous submissions and review history.
              </p>
            </div>
            <Link
              href="/workflow/supervisor/history"
              className="shrink-0 rounded-lg border border-brand px-4 py-2 text-sm font-medium text-brand transition-colors duration-150 hover:bg-brand-soft"
            >
              View Submission History
            </Link>
          </Card>
          )}
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
                        ? `$${item.scheduledValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
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
                              ? `$${item.estimatedAmount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
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
