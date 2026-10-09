"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ListChecks, CheckCircle2, Clock, AlertTriangle } from "lucide-react";
import { formatMoney, formatPercent, formatQuantity, humanizeApprovalStatus } from "@/lib/format";
import StatusFlow from "@/components/workflow/StatusFlow";
import PlannedQuantityEditor from "@/components/workflow/PlannedQuantityEditor";
import WorkItemTaskManager, { type ManagedTask } from "@/components/workflow/WorkItemTaskManager";
import DashboardPanel from "@/components/workflow/DashboardPanel";
import ReviewCardLayout from "@/components/workflow/ReviewCardLayout";
import SortControl, { type SortDir, type SortState } from "@/components/workflow/SortControl";
import { useCountUp } from "@/components/workflow/useCountUp";
import { progressColorClass, progressSoftClass } from "@/lib/progressColor";
import ProgressValue from "@/components/workflow/charts/ProgressValue";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge, { type BadgeVariant } from "@/components/ui/Badge";
import Input from "@/components/ui/Input";
import ErrorNotice from "@/components/ui/ErrorNotice";
import { errorMessage, readApiJson } from "@/lib/apiClient";
import type { DashboardData } from "@/lib/dashboard";
import { calculateOverallProgress } from "@/lib/calculations";

export type SupervisorQueueItem = {
  submissionId: string;
  /** When it was submitted (extraction_submissions.created_at) — used
   * only to sort the review queue. */
  submittedAt?: string;
  /** Work item has no planned quantity: the submitted % is that day's
   * additional progress, added to the approved total on approval. */
  percentageMode?: boolean;
  /** The work item's current approved total % (null = none yet). */
  approvedProgress?: number | null;
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
  tasks?: ManagedTask[];
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

/** Today Reviews sorting — same keys/behavior as the Subcontractor's
 * review queue (ForemanQueue), plus Status (Contractor cards span
 * pending, approved and rolled-back records). */
type ReviewSortKey = "date" | "workItem" | "worker" | "progress" | "status";
const REVIEW_SORT_OPTIONS: { key: ReviewSortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "workItem", label: "Work Item" },
  { key: "worker", label: "Worker" },
  { key: "progress", label: "Progress" },
  { key: "status", label: "Status" },
];
const REVIEW_DEFAULT_DIR: Record<ReviewSortKey, SortDir> = {
  date: "desc",
  workItem: "asc",
  worker: "asc",
  progress: "desc",
  status: "asc",
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
    estimatedAmount: number | null;
    statusLabel: "Completed" | "In Progress" | "Not Started";
    touchedInPeriod: boolean;
  }[];
};

/** Period-change label / "updated" list heading per period — display
 * only. The card itself is titled Progress Tracking (or Summary), with the
 * period chosen by its Today / This Week / MTD pills. */
const PERIOD_WORDING: Record<ExecutiveSummaryPeriod, { change: string; updated: string }> = {
  daily: { change: "Today's updates", updated: "Updated today" },
  weekly: { change: "This week's updates", updated: "Updated this week" },
  monthly: { change: "MTD updates", updated: "Updated this month" },
};

/** Card title per ExecutiveSummaryCard view. */
const SUMMARY_VIEW_TITLE = { full: "Progress Tracking", progress: "Progress Tracking", summary: "Summary" } as const;

/** How many touched work items the card lists before "+N more". */
const UPDATED_LIST_LIMIT = 5;

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Overall Progress panel, counting up 0 → value on load (display only —
 * see useCountUp). One count-up drives the number, the bar AND the
 * panel tint, so the color follows the CURRENT animated percentage
 * (red → orange → yellow → green) and stops on the final band. Dark text
 * for contrast; the panel and bar carry the progress-band color. */
function OverallProgressPanel({ percent, aside }: { percent: number | null; aside?: React.ReactNode }) {
  const shown = useCountUp(percent);
  return (
    <div className={`rounded-lg border px-4 py-3 space-y-2 ${progressSoftClass(shown)}`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-foreground-secondary">Overall Progress</p>
          <p className="text-2xl font-bold text-foreground tabular-nums leading-tight">
            {shown !== null ? `${shown}%` : "—"}
          </p>
        </div>
        {aside}
      </div>
      {shown !== null && (
        <div className="h-1.5 rounded-full bg-white/70 overflow-hidden" aria-hidden>
          <div
            className={`h-full rounded-full ${progressColorClass(shown, "bg")}`}
            style={{ width: `${Math.min(100, Math.max(0, shown))}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** One label/value line of the Executive Summary. */
function SummaryLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-line-soft pb-1.5 last:border-0 last:pb-0">
      <span className="text-foreground-secondary">{label}</span>
      <span className="font-medium text-foreground tabular-nums text-right">{children}</span>
    </li>
  );
}

const PERIOD_TABS: { key: ExecutiveSummaryPeriod; label: string }[] = [
  { key: "daily", label: "Today" },
  { key: "weekly", label: "This Week" },
  { key: "monthly", label: "MTD" },
];

/**
 * Today's / This Week's / MTD Progress with a short Executive Summary —
 * structured values computed from real application data (see
 * lib/workflow.ts getExecutiveSummary via
 * app/api/workflow/daily-summary/route.ts), NOT an AI-written
 * paragraph: status should be readable at a glance. All three periods
 * share one fetch/render path, only the `period` sent to the API
 * changes.
 *
 * Layout, top to bottom: overall progress with its earned value (tinted
 * by the shared progress bands), a few Executive Summary lines
 * (completed / pending / the period's updates / what needs attention),
 * then the work items actually updated in the period, each as
 * "progress · value". Every value is the same `summary` fetched below —
 * nothing hardcoded, nothing recalculated here beyond subtracting two
 * returned totals. The list shows only work items with touchedInPeriod
 * (a submission within the selected period), never items that merely
 * carry older progress.
 */
export function ExecutiveSummaryCard({
  onReviewSubmissions,
  showTotals = true,
  projectId,
  departmentId,
  view = "full",
  description,
}: {
  onReviewSubmissions: () => void;
  /** Optional plain-language description shown at the top of the
   * summary part (e.g. the Subcontractor Summary's sentences built from
   * the page's own KPI numbers). Omitted = unchanged card. */
  description?: React.ReactNode;
  /** Which part to show: "full" (everything, titled Progress Tracking),
   * "summary" (totals + the Executive Summary lines, titled Summary) or
   * "progress" (the work items updated in the period, titled Progress
   * Tracking) — lets a dashboard put the two behind separate tabs
   * instead of one long card. Same fetch and data in every view. */
  view?: "full" | "summary" | "progress";
  /** Project context for a Contractor with roles on several projects —
   * sent to the summary API, which resolves it among the caller's own
   * roles. Omitted = the first role (single-project behavior). */
  projectId?: string;
  /** Department within that project, for a role holder with several
   * departments there — resolved the same own-roles-only way. */
  departmentId?: string;
  /** Show the project totals (Overall Progress + earned value, Completed/
   * Pending work). The Subcontractor Dashboard turns this off — its KPI
   * cards already show exactly those numbers — leaving the period's
   * updates, what needs attention and the updated work items. */
  showTotals?: boolean;
}) {
  const [period, setPeriod] = useState<ExecutiveSummaryPeriod>("daily");
  const [summary, setSummary] = useState<ExecutiveSummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry to re-run the fetch below after a failure.
  const [attempt, setAttempt] = useState(0);

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
      body: JSON.stringify({ period, projectId, departmentId }),
    })
      .then(async (res) => {
        const data = await readApiJson<{ summary: ExecutiveSummaryData }>(res, "Couldn't load progress tracking.");
        if (!ignore) setSummary(data.summary);
      })
      .catch((err) => {
        if (!ignore) setError(errorMessage(err, "Couldn't load progress tracking."));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [period, projectId, departmentId, attempt]);

  function selectPeriod(next: ExecutiveSummaryPeriod) {
    setPeriod(next);
    setLoading(true);
    setError(null);
  }

  function retry() {
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }

  const showSummaryPart = view !== "progress";
  const showProgressPart = view !== "summary";

  return (
    <Card className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="font-semibold text-foreground">{SUMMARY_VIEW_TITLE[view]}</h2>
          {summary && !loading && (
            <p className="text-xs text-foreground-secondary truncate">
              {summary.projectName} ·{" "}
              {/department$/i.test(summary.departmentName)
                ? summary.departmentName
                : `${summary.departmentName} Department`}{" "}
              ·{" "}
              {period === "daily"
                ? new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" })
                : summary.periodLabel}
            </p>
          )}
        </div>
        <div className="flex gap-1">
          {PERIOD_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectPeriod(t.key)}
              className={`px-2.5 py-1 max-lg:px-3 max-lg:py-2 rounded-full border text-xs font-medium transition-colors duration-150 ${
                period === t.key
                  ? "bg-brand-soft text-brand border-brand-border"
                  : "bg-surface-soft text-foreground-secondary border-transparent hover:bg-surface-hover"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {view !== "progress" && description}

      {loading && <p className="text-foreground-muted">Loading…</p>}
      {error && !loading && <ErrorNotice message={error} onRetry={retry} />}

      {summary && !loading && (() => {
        const changed = summary.topWorkItems.filter((w) => w.touchedInPeriod);
        const listed = changed.slice(0, UPDATED_LIST_LIMIT);
        // topWorkItems is capped server-side; workItemsUpdated is the true
        // count of distinct work items touched in the period.
        const notListed = Math.max(0, summary.workItemsUpdated - listed.length);
        const needsAttention = summary.pendingCount > 0 || summary.rolledBackCount > 0;
        const hasValue = summary.earnedAmount !== null && summary.scheduledAmount !== null;
        const pendingWork = summary.totalWorkItems - summary.completedWorkItems;

        return (
          <div className="space-y-4">
            {showSummaryPart && showTotals && (
              <OverallProgressPanel
                percent={summary.overallProgress}
                aside={
                  hasValue && (
                    <div className="text-right">
                      <p className="text-xs text-foreground-secondary">Value earned</p>
                      <p className="font-semibold text-foreground tabular-nums">
                        {formatMoney(summary.earnedAmount)}{" "}
                        <span className="font-normal text-foreground-secondary">
                          of {formatMoney(summary.scheduledAmount)}
                        </span>
                      </p>
                    </div>
                  )
                }
              />
            )}

            {showSummaryPart && (
            <div>
              <h3 className="text-xs font-semibold text-foreground-secondary uppercase tracking-wide mb-1.5">
                Executive Summary
              </h3>
              <ul className="space-y-1.5">
                {showTotals && (
                  <>
                    <SummaryLine label="Completed work">
                      {summary.completedWorkItems} of {plural(summary.totalWorkItems, "work item")}
                    </SummaryLine>
                    <SummaryLine label="Pending work">
                      {plural(pendingWork, "work item")}
                      {hasValue && (
                        <span className="font-normal text-foreground-secondary">
                          {" "}· {formatMoney(Math.max(0, summary.scheduledAmount! - summary.earnedAmount!))} left
                        </span>
                      )}
                    </SummaryLine>
                  </>
                )}
                <SummaryLine label={PERIOD_WORDING[period].change}>
                  {summary.updatesSubmitted === 0
                    ? "No updates"
                    : `${plural(summary.updatesSubmitted, "update")} · ${summary.approvedCount} approved`}
                </SummaryLine>
                <SummaryLine label="Needs attention">
                  {needsAttention ? (
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-border bg-warning-soft px-2 py-0.5 text-xs">
                        <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
                        {[
                          summary.pendingCount > 0 ? `${summary.pendingCount} to review` : null,
                          summary.rolledBackCount > 0 ? `${summary.rolledBackCount} returned` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <button
                        type="button"
                        onClick={onReviewSubmissions}
                        className="text-xs font-medium text-brand transition-colors duration-150 hover:underline"
                      >
                        Review
                      </button>
                    </span>
                  ) : (
                    <span className="font-normal text-foreground-secondary">Nothing right now</span>
                  )}
                </SummaryLine>
              </ul>
            </div>
            )}

            {showProgressPart && (
            <div>
              <h3 className="text-xs font-semibold text-foreground-secondary uppercase tracking-wide mb-1.5">
                {PERIOD_WORDING[period].updated}
              </h3>
              {listed.length === 0 ? (
                <p className="text-foreground-muted">No work items updated during this period.</p>
              ) : (
                <ul className="space-y-1.5">
                  {listed.map((w) => (
                    <li key={w.workItemCode} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        <span className="text-foreground-secondary">{w.workItemCode}</span>{" "}
                        <span className="text-foreground">— {w.workItemDescription}</span>
                      </span>
                      <ProgressValue
                        percent={w.progress}
                        amount={w.estimatedAmount}
                        title={`${w.statusLabel}${w.estimatedAmount !== null ? " · earned value at current progress" : ""}`}
                      />
                    </li>
                  ))}
                  {notListed > 0 && (
                    <li className="text-xs text-foreground-muted">+{notListed} more updated</li>
                  )}
                </ul>
              )}
            </div>
            )}
          </div>
        );
      })()}
    </Card>
  );
}

type HealthStatus = "empty" | "complete" | "attention" | "review" | "active";

// No "On track / Behind schedule": this data has no planned dates or
// target progress to judge a schedule against, so the headline states
// only what the data supports.
const HEALTH_BADGE: Record<HealthStatus, { variant: BadgeVariant; label: string }> = {
  empty: { variant: "neutral", label: "No active work yet" },
  complete: { variant: "success", label: "Complete" },
  attention: { variant: "error", label: "Attention required" },
  review: { variant: "warning", label: "Awaiting your review" },
  active: { variant: "brand", label: "Active — no issues flagged" },
};

/** Days before today in the "recent" view (today + these). */
const RECENT_DAYS = 4;

function plainList(items: string[], limit = 3): string {
  return items.length <= limit ? items.join(", ") : `${items.slice(0, limit).join(", ")} and ${items.length - limit} more`;
}

function counted(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

const noopSubscribe = () => () => {};

/**
 * Executive Summary — "Overall Health at a Glance" for the Contractor,
 * in the mentor's executive-summary format, compact enough to scan in
 * 5–10 seconds: headline status (1–2 lines) → Key accomplishments →
 * Progress against plan → Blockers & risks → Decisions needed → Client &
 * revenue-relevant updates → Plan for today. Each fact appears once, in
 * its most fitting section; a section with no supporting data is left
 * out (Decisions needed says "None."). Metrics aren't repeated here —
 * the KPI row above already shows them.
 *
 * Nothing is fetched or invented; every line is traceable to data the
 * Contractor page already loaded:
 *   - workItems: the selected scope's Active work items (getDashboardData):
 *     progress, completed, lastApprovedAt, planned quantity, and the
 *     existing "stuck" rule (not complete, no approved progress 14+ days).
 *   - history: Submission History for the page's current department —
 *     submittedAt / approvedAt / status / worker (today and the previous
 *     4 days, returned work and who it's with).
 *   - pendingItems: the Contractor's own review queue right now.
 *   - earned / scheduled / month values: the scope's existing earned-value
 *     totals — the only plan and revenue measure in this data.
 * History/queue facts appear only when the selected scope includes that
 * department (labelled with it when the scope is wider). There are no
 * planned dates or planned progress, so nothing here claims on/behind
 * schedule.
 */
export function OverallHealthSummary({
  workItems,
  history,
  pendingItems,
  activityScope,
  activityDepartmentName,
  earnedAmount,
  scheduledAmount,
  monthApprovedValue,
  previousMonthApprovedValue,
  onReviewSubmissions,
  description,
}: {
  /** Plain-language description shown in place of the headline line
   * (e.g. the Dashboard KPI values in words — see KpiSummaryText), so
   * the card never states a second, differently computed progress
   * figure. Omitted = the headline, unchanged. */
  description?: React.ReactNode;
  workItems: {
    code: string;
    progressPercentage: number | null;
    isCompleted: boolean;
    isStuck: boolean;
    plannedQuantity: number | null;
    lastApprovedAt: string | null;
  }[];
  history: {
    workItemCode: string;
    workerName: string;
    submittedAt: string;
    submittedProgress: number;
    correctedProgress?: number | null;
    reviewStatusCode?: string;
    approvedAt?: string | null;
  }[];
  pendingItems: { workItemCode: string }[];
  /** "same": the scope is exactly the department history/queue cover;
   * "partial": the scope is wider (facts are labelled with that
   * department); "none": another department — those facts are omitted. */
  activityScope: "same" | "partial" | "none";
  activityDepartmentName: string;
  earnedAmount: number | null;
  scheduledAmount: number | null;
  monthApprovedValue: number | null;
  previousMonthApprovedValue: number | null;
  onReviewSubmissions: () => void;
}) {
  // Day boundaries are the viewer's local calendar days, so the dated
  // facts are only computed in the browser (server render omits them).
  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false);

  const total = workItems.length;
  const completed = workItems.filter((w) => w.isCompleted).length;
  const open = workItems.filter((w) => !w.isCompleted);
  const inProgressItems = open.filter((w) => (w.progressPercentage ?? 0) > 0);
  const stalled = open.filter((w) => w.isStuck);
  const overall = calculateOverallProgress(workItems.map((w) => w.progressPercentage));
  const byCode = new Map(workItems.map((w) => [w.code, w]));
  const pct = (code: string) => formatPercent(byCode.get(code)?.progressPercentage ?? 0);

  const showActivity = activityScope !== "none";
  const scopeSuffix = activityScope === "partial" ? ` (${activityDepartmentName})` : "";
  const scopedHistory = showActivity ? history : [];
  const at = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

  // Returned = a work item whose LATEST submission was returned; the
  // worker on it is who it's with (known from History, not assumed).
  const latest = new Map<string, (typeof history)[number]>();
  for (const h of scopedHistory) {
    const seen = latest.get(h.workItemCode);
    if (!seen || h.submittedAt > seen.submittedAt) latest.set(h.workItemCode, h);
  }
  const returned = [...latest.values()].filter(
    (h) => h.reviewStatusCode === "ROLLED_BACK" && byCode.has(h.workItemCode) && !byCode.get(h.workItemCode)!.isCompleted
  );
  const pending = showActivity ? pendingItems : [];
  const pendingCodes = [...new Set(pending.map((q) => q.workItemCode))];

  const status: HealthStatus =
    total === 0
      ? "empty"
      : completed === total
        ? "complete"
        : stalled.length > 0 || returned.length > 0
          ? "attention"
          : pending.length > 0
            ? "review"
            : "active";

  /** "from → to" approved progress for a percentage-mode item, where each
   * approval is the cumulative % (the rule getWorkItemCurrentStatus
   * uses): "from" = its latest approval before `cutoff` (none yet = 0%,
   * the app's existing rule), "to" = its current approved %. Items with a
   * planned quantity show "now X%" (their approvals are increments). */
  const moveText = (code: string, cutoff: number) => {
    const item = byCode.get(code)!;
    if (item.plannedQuantity !== null && item.plannedQuantity > 0) return `${code} now at ${pct(code)}`;
    const before = scopedHistory
      .filter((h) => h.workItemCode === code && h.reviewStatusCode === "APPROVED" && at(h.approvedAt) < cutoff)
      .sort((a, b) => at(b.approvedAt) - at(a.approvedAt))[0];
    return `${code} moved from ${formatPercent(before ? (before.correctedProgress ?? before.submittedProgress) : 0)} to ${pct(code)} approved`;
  };

  // ---- Headline (1–2 lines): current state + today's key change.
  const headline =
    total === 0
      ? "No active work items in this scope yet."
      : `Overall progress is ${formatPercent(overall)}, with ${completed} completed, ${inProgressItems.length} in progress${
          showActivity ? ` and ${pending.length} awaiting your review` : ""
        }${scopeSuffix} (of ${counted(total, "work item")}).`;
  let keyChange: string | null = null;

  // ---- Key accomplishments (today + previous 4 days).
  const accomplishments: string[] = [];
  if (showActivity && isClient) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const t0 = todayStart.getTime();
    const windowStartDate = new Date(todayStart);
    windowStartDate.setDate(windowStartDate.getDate() - RECENT_DAYS); // calendar days (DST-safe)
    const windowStart = windowStartDate.getTime();
    const fmtDay = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const approvedToday = scopedHistory.filter((h) => at(h.approvedAt) >= t0);
    const approvedEarlier = scopedHistory.filter((h) => at(h.approvedAt) >= windowStart && at(h.approvedAt) < t0);

    // Today's key change: something completed today, else the biggest
    // approved move today.
    const completedToday = workItems.filter((w) => w.isCompleted && at(w.lastApprovedAt) >= t0);
    const movedTodayCodes = [...new Set(approvedToday.map((h) => h.workItemCode))].filter(
      (code) => byCode.has(code) && !byCode.get(code)!.isCompleted
    );
    let keyCode: string | null = null;
    if (completedToday.length > 0) {
      keyCode = completedToday[0].code;
      keyChange = `Today's key change: ${plainList(completedToday.map((w) => w.code), 2)} ${completedToday.length === 1 ? "was" : "were"} completed.`;
    } else if (movedTodayCodes.length > 0) {
      keyCode = [...movedTodayCodes].sort(
        (a, b) => (byCode.get(b)!.progressPercentage ?? 0) - (byCode.get(a)!.progressPercentage ?? 0)
      )[0];
      keyChange = `Today's key change: ${moveText(keyCode, t0)}.`;
    }

    // Other meaningful outcomes in the window (not repeating the key change).
    const completedRecently = workItems.filter(
      (w) => w.isCompleted && at(w.lastApprovedAt) >= windowStart && at(w.lastApprovedAt) < t0
    );
    for (const w of completedRecently.slice(0, 2)) {
      accomplishments.push(`${w.code} was completed (${fmtDay(at(w.lastApprovedAt))}).`);
    }
    const movedCodes = [
      ...new Set(scopedHistory.filter((h) => at(h.approvedAt) >= windowStart).map((h) => h.workItemCode)),
    ].filter((code) => code !== keyCode && byCode.has(code) && !byCode.get(code)!.isCompleted);
    for (const code of movedCodes.slice(0, Math.max(0, 2 - accomplishments.length))) {
      accomplishments.push(`${moveText(code, windowStart)}.`);
    }
    if (approvedToday.length > 0 || approvedEarlier.length > 0) {
      accomplishments.push(
        `${counted(approvedToday.length, "submission")} approved today, ${approvedEarlier.length} in the previous ${RECENT_DAYS} days${scopeSuffix}.`
      );
    }
  }

  // ---- Progress against plan: the only plan measure in this data is
  // scheduled value vs earned value (no planned dates/quantities/progress).
  const planLines: string[] = [];
  if (earnedAmount !== null && scheduledAmount !== null && scheduledAmount > 0) {
    planLines.push(
      `Earned value is ${formatMoney(earnedAmount)} of ${formatMoney(scheduledAmount)} scheduled (${formatPercent(
        Math.round((earnedAmount / scheduledAmount) * 1000) / 10
      )}).`
    );
  }

  // ---- Blockers & risks: only concrete, rule-based issues.
  const risks: string[] = [];
  if (stalled.length > 0) {
    risks.push(
      `${plainList(stalled.map((w) => `${w.code} (${formatPercent(w.progressPercentage ?? 0)})`))} — no approved progress for 14+ days.`
    );
  }
  if (returned.length > 0) {
    risks.push(
      `${plainList(returned.map((h) => `${h.workItemCode} (${h.workerName})`))} — returned for correction, awaiting resubmission${scopeSuffix}.`
    );
  }

  // ---- Decisions needed: what the Contractor must decide.
  const decisions =
    pending.length > 0
      ? [`Approve or return ${counted(pending.length, "pending submission")}: ${plainList(pendingCodes)}${scopeSuffix}.`]
      : [];

  // ---- Client & revenue-relevant updates (no client data exists).
  const revenue: string[] = [];
  if (monthApprovedValue !== null && previousMonthApprovedValue !== null) {
    revenue.push(
      `Approved value this month: ${formatMoney(monthApprovedValue)} (last month ${formatMoney(previousMonthApprovedValue)}).`
    );
  }

  // ---- Plan for today: at most 3 priorities from the actual state.
  const plan = [
    pending.length > 0 ? `Review the ${counted(pending.length, "pending submission")}.` : null,
    stalled.length > 0
      ? `Follow up on ${[...stalled].sort((a, b) => (a.lastApprovedAt ?? "").localeCompare(b.lastApprovedAt ?? ""))[0].code}, stalled longest.`
      : null,
    returned.length > 0 ? `Confirm ${returned[0].workItemCode} is resubmitted by ${returned[0].workerName}.` : null,
  ].filter((a): a is string => !!a);
  if (plan.length === 0 && inProgressItems.length > 0) {
    const closest = [...inProgressItems]
      .sort((a, b) => (b.progressPercentage ?? 0) - (a.progressPercentage ?? 0))
      .slice(0, 2)
      .map((w) => `${w.code} (${formatPercent(w.progressPercentage ?? 0)})`);
    plan.push(`Monitor the items closest to completion: ${closest.join(", ")}.`);
  }

  const sections: { title: string; items: string[]; numbered?: boolean; action?: React.ReactNode }[] = [
    { title: "Key accomplishments", items: accomplishments },
    { title: "Progress against plan", items: planLines },
    { title: "Blockers & risks", items: risks },
    {
      title: "Decisions needed",
      items: decisions.length > 0 ? decisions : total > 0 ? ["None."] : [],
      action:
        pending.length > 0 ? (
          <button
            type="button"
            onClick={onReviewSubmissions}
            className="text-xs font-medium text-brand transition-colors duration-150 hover:underline"
          >
            Review submissions
          </button>
        ) : null,
    },
    { title: "Client & revenue-relevant updates", items: revenue },
    { title: "Plan for today", items: plan.slice(0, 3), numbered: true },
  ].filter((section) => section.items.length > 0);

  return (
    <Card className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-foreground">Overall Health at a Glance</h2>
        <Badge variant={HEALTH_BADGE[status].variant}>{HEALTH_BADGE[status].label}</Badge>
      </div>
      <div className="space-y-0.5">
        {description ?? <p className="font-medium text-foreground">{headline}</p>}
        {keyChange && <p className="text-foreground">{keyChange}</p>}
      </div>
      <div className="grid gap-x-6 gap-y-2.5 md:grid-cols-2">
        {sections.map((section) => (
          <div key={section.title}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{section.title}</h3>
              {section.action}
            </div>
            {section.numbered ? (
              <ol className="mt-0.5 list-decimal space-y-0.5 pl-5 text-foreground">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            ) : (
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-foreground">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-foreground-muted">
        Follows the Department filter. Stalled = not complete, no approved progress for 14+ days. No planned dates or
        planned progress exist in this data, so on/behind schedule isn&apos;t assessed.
      </p>
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
  mtdProgress,
  workSummary,
  forcedTab,
  dashboardData,
  todaySection,
  onReviewSubmissions,
  focusSubmissionId = null,
  focusWorkItemCode = null,
  projectId,
  departmentId,
  query = "",
}: Props & {
  /** The page's search text (header toolbar) — narrows Today Reviews by
   * work item code/name, worker or update text. */
  query?: string;
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
  /** Department within that project for the brief (see ExecutiveSummaryCard). */
  departmentId?: string;
}) {
  const focusBySubmission = !!focusSubmissionId && queue.some((q) => q.submissionId === focusSubmissionId);
  const router = useRouter();
  const [tab, setTab] = useState<"today" | "mtd">(forcedTab ?? "today");
  const activeTab = forcedTab ?? tab;
  // Target of the brief's "Review Submissions" action — scrolls to the
  // existing Today Reviews section below, no navigation/route change.
  const todayReviewsRef = useRef<HTMLDivElement>(null);
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
  // Universal Approve: which queue items are ticked, plus a ref-based lock
  // (state alone can lag a rapid double-click) so repeated clicks can
  // never fire a second batch while one is in flight.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkLock = useRef(false);

  // Completed + Approved work items are finished — not shown in Today
  // Reviews (they're in the History page). Same queue data, same fields
  // (isCompleted, approvalStatus) already returned by lib/workflow.ts.
  const currentItems = queue.filter(
    (item) => !(item.isCompleted && item.approvalStatus === "APPROVED")
  );

  // Search narrows, sort orders (ties: newest first) — the same rules as
  // History and the Subcontractor queue. Bulk approve only ever acts on
  // the cards actually shown.
  const [sort, setSort] = useState<SortState<ReviewSortKey>>({ key: "date", dir: "desc" });
  const visibleItems = (() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? currentItems.filter((i) =>
          [i.workItemCode, i.workItemDescription, i.workerName, i.description, i.departmentName].some((t) =>
            (t ?? "").toLowerCase().includes(needle)
          )
        )
      : currentItems;
    const byDate = (a: SupervisorQueueItem, b: SupervisorQueueItem) =>
      (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "");
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...matched].sort((a, b) => {
      let primary: number;
      switch (sort.key) {
        case "workItem":
          primary = a.workItemCode.localeCompare(b.workItemCode, undefined, { numeric: true });
          break;
        case "worker":
          primary = a.workerName.localeCompare(b.workerName);
          break;
        case "progress":
          primary = (a.correctedProgress ?? a.submittedProgress) - (b.correctedProgress ?? b.submittedProgress);
          break;
        case "status":
          primary = humanizeApprovalStatus(a.approvalStatus).localeCompare(humanizeApprovalStatus(b.approvalStatus));
          break;
        default:
          return sign * byDate(a, b);
      }
      return sign * primary || byDate(b, a);
    });
  })();

  // Only items this panel can actually approve right now — has a
  // validation row and isn't already APPROVED.
  const eligibleIds = visibleItems
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
        failed.push(errorMessage(err, "Action failed."));
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
    await readApiJson(res, "The action couldn't be completed. Please try again.");
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
      setError(errorMessage(err, "Action failed."));
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
    // Percentage mode, not yet approved: show what approving will do —
    // the same rule the server applies (lib/workflow.ts
    // toApprovedTotalData): new total = previous approved + today's %,
    // capped at 100. No approved progress yet counts as 0%.
    const showApprovalPreview = !!item.percentageMode && item.approvalStatus !== "APPROVED";
    const previousApproved = item.approvedProgress ?? 0;
    const newApprovedPreview = Math.min(100, Math.round((previousApproved + (displayedProgress ?? 0)) * 100) / 100);
    const todayLabel = item.percentageMode ? "Submitted today" : "Submitted Progress";

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
        <ReviewCardLayout
          workItemCode={item.workItemCode}
          workItemDescription={item.workItemDescription}
          description={item.description}
          projectName={item.projectName}
          workerName={item.workerName}
          departmentName={item.departmentName}
        >
        {isEditing ? (
          <div>
            <label className="block text-foreground-secondary mb-1">
              {item.percentageMode
                ? "Progress today (%):"
                : item.correctedProgress !== null
                  ? "Corrected Progress:"
                  : "Submitted Progress:"}
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
            <span className="text-foreground-secondary">{todayLabel}:</span>{" "}
            <span className="font-medium tabular-nums">{formatPercent(displayedProgress)}</span>
          </p>
        )}
        {showApprovalPreview && (
          <div className="rounded-md border border-line bg-surface-soft px-3 py-2 space-y-0.5">
            <p>
              <span className="text-foreground-secondary">Previously approved:</span>{" "}
              <span className="font-medium tabular-nums">{formatPercent(previousApproved)}</span>
            </p>
            <p>
              <span className="text-foreground-secondary">Submitted today:</span>{" "}
              <span className="font-medium tabular-nums">{formatPercent(displayedProgress)}</span>
            </p>
            <p>
              <span className="text-foreground-secondary">New approved progress:</span>{" "}
              <span className="font-semibold tabular-nums">{formatPercent(newApprovedPreview)}</span>
              {previousApproved + (displayedProgress ?? 0) > 100 && (
                <span className="text-xs text-foreground-muted"> (capped at 100%)</span>
              )}
            </p>
          </div>
        )}

        {item.scheduledValue !== null && (
          <p>
            <span className="text-foreground-secondary">
              {item.percentageMode ? "Estimated Amount (today's progress):" : "Estimated Amount:"}
            </span>{" "}
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
        </ReviewCardLayout>

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
        {/* Live Updates for this work item live on Work Items (one entry
            point per work item) — not repeated on the review card. */}
      </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!forcedTab && (
        <div className="flex gap-2">
          <Button variant={tab === "today" ? "primary" : "secondary"} size="sm" onClick={() => setTab("today")}>
            Progress Tracking
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
            departmentId={departmentId}
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
                <SortControl
                  options={REVIEW_SORT_OPTIONS}
                  sort={sort}
                  onChange={setSort}
                  defaultDir={REVIEW_DEFAULT_DIR}
                />
                {visibleItems.length === 0 && (
                  <p className="text-sm text-foreground-muted">No submissions match “{query.trim()}”.</p>
                )}
                {visibleItems.map(renderQueueItem)}
              </div>
            )}

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
                  <WorkItemTaskManager
                    workItemId={item.workItemId}
                    tasks={item.tasks ?? []}
                    workItemLabel={`${item.workItemCode} — ${item.workItemDescription}`}
                  />
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
