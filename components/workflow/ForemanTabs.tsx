"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  ListChecks,
  ClipboardCheck,
  History as HistoryIcon,
  MessageSquare,
  UserRound,
} from "lucide-react";
import DashboardShell from "@/components/workflow/DashboardShell";
import TabNav from "@/components/workflow/TabNav";
import ProjectSelect, { type ProjectOption } from "@/components/workflow/ProjectSelect";
import { useChatUnreadCount } from "@/components/workflow/useChatUnreadCount";
import AssignmentManager, {
  type AssignmentWorkerOption,
  type AssignmentWorkItemOption,
  type AssignmentRow,
  type AssignmentInactiveWorkItem,
} from "@/components/workflow/AssignmentManager";
import ForemanQueue, { type ForemanQueueItem } from "@/components/workflow/ForemanQueue";
import ChatPanel from "@/components/workflow/ChatPanel";
import NotificationFocusBanner from "@/components/workflow/NotificationFocusBanner";
import SubmissionHistoryTable, { type SubmissionHistoryRow } from "@/components/workflow/SubmissionHistoryTable";
import type { ReviewFocusState } from "@/lib/workflow";
import ProfilePanel from "@/components/workflow/ProfilePanel";
import { ExecutiveSummaryCard } from "@/components/workflow/SupervisorPanel";
import { DashboardKpiCards, KpiSummaryText, type KpiCardActions } from "@/components/workflow/KpiCards";
import { formatPercent } from "@/lib/format";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import ErrorNotice from "@/components/ui/ErrorNotice";

type Kpis = {
  totalWorkItems: number;
  completedCount: number;
  workLeftPercent: number;
  overallProgressPercent: number;
  pendingReviews: number;
  totalEstimatedValue: number;
};

type AwaitingContractorItem = {
  submissionId: string;
  workItemCode: string;
  workItemDescription: string;
  workerName: string;
  correctedProgress: number | null;
  submittedProgress: number;
};

type Props = {
  foremanUserId: string;
  /** The signed-in Subcontractor's email — for the header's profile chip. */
  userEmail?: string;
  /** The signed-in Subcontractor's own name/email (Profile tab). */
  profile: { displayName: string; email: string };
  projectName: string;
  departmentName: string;
  kpis: Kpis | null;
  board: {
    departmentName: string;
    workers: AssignmentWorkerOption[];
    workItems: AssignmentWorkItemOption[];
    assignments: AssignmentRow[];
    inactiveWorkItems: AssignmentInactiveWorkItem[];
  } | null;
  queue: ForemanQueueItem[];
  awaitingContractorReview: AwaitingContractorItem[];
  /** Older submissions (getSubmissionHistory, department-scoped). */
  history: SubmissionHistoryRow[];
  /** The project every section is scoped to (resolved server-side). */
  projectId: string;
  /** The department within that project every section is scoped to. */
  departmentId: string;
  /** Server-checked state of a notification's focused submission
   * (?focus=) — see lib/workflow.ts getReviewFocusState; null without one. */
  reviewFocus?: ReviewFocusState | null;
  /** The user's own project/department roles for this page's role —
   * rendered as the shared header Project dropdown (ProjectSelect), which
   * shows nothing with a single option. */
  projectOptions?: ProjectOption[];
  /** Current Project location — display only; null when not set. */
  projectLocation?: string | null;
};

// Same tab set as the Contractor (see ContractorTabs), role data differs.
// Updates (photos) are not their own destination: they live only on Work
// Items, one "View Updates" per work item (see WorkItemList) — not on
// Reviews. Profile is opened from the Profile control above Sign out.
const TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "reviews", label: "Reviews", icon: ClipboardCheck },
  { key: "workItems", label: "Work Item Management", icon: ListChecks },
  { key: "history", label: "History", icon: HistoryIcon },
  { key: "communication", label: "Communication", icon: MessageSquare },
  { key: "profile", label: "Profile", icon: UserRound },
];

const HEADINGS: Record<string, string> = {
  dashboard: "Subcontractor Dashboard",
  reviews: "Reviews",
  workItems: "Work Item Management",
  history: "Submission History",
  communication: "Communication",
  profile: "My Profile",
};

/** Old ?tab= values (bookmarks, older links) → new tabs. */
const LEGACY_TABS: Record<string, string> = { assignments: "workItems", liveUpdates: "reviews" };

/** The Dashboard's views, as tabs side by side at the top — the same
 * set as the Contractor: Dashboard (the KPI row) | Summary (the plain,
 * data-derived Executive Summary — not AI-written) | Progress Tracking
 * (the work items updated in the period). */
type DashboardView = "dashboard" | "summary" | "progress";
const DASHBOARD_VIEWS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "summary", label: "Summary" },
  { key: "progress", label: "Progress Tracking" },
];

const BASE_PATH = "/workflow/foreman";

/** The Reviews tab's two sections, as tabs side by side at the top (same
 * TabNav as the Dashboard views). */
type ReviewsView = "today" | "awaiting";
const REVIEWS_VIEWS = [
  { key: "today", label: "Today Reviews" },
  { key: "awaiting", label: "Awaiting Contractor Review" },
];


/** Shown where the assignment board (KPIs, Work Item Management) is
 * missing because it failed to load — reloading the page retries it. */
const BOARD_UNAVAILABLE = "Work item data couldn't be loaded right now.";

/**
 * Subcontractor's top-level navigation — same DashboardShell and tab set
 * as the Contractor. Dashboard = KPIs + the shared project brief;
 * Reviews = the Subcontractor review queue (forward/edit/comment,
 * unchanged) and what's awaiting the Contractor; Work Items = Work Item
 * Management (per-item Live Updates, assign /
 * remove / planned quantity / tasks, searchable); History = the existing
 * Submission History (department-scoped). Every section is the same
 * data app/workflow/foreman/page.tsx already fetched.
 */
export default function ForemanTabs({
  foremanUserId,
  userEmail,
  profile,
  projectName,
  departmentName,
  kpis,
  board,
  queue,
  awaitingContractorReview,
  history,
  projectId,
  departmentId,
  reviewFocus = null,
  projectOptions = [],
  projectLocation = null,
}: Props) {
  // Initial tab + focus come from the URL (a notification's "View Queue"
  // link: ?tab=reviews&focus=<submissionId>&n=<notificationId>).
  // NotificationBell navigates with a full page load, so this component
  // mounts fresh for every such click and these initializers always run.
  const searchParams = useSearchParams();
  const [tab, setTab] = useState(() => {
    const raw = searchParams.get("tab") ?? "";
    const requested = LEGACY_TABS[raw] ?? raw;
    return TABS.some((t) => t.key === requested) ? requested : "reviews";
  });
  const focusSubmissionId = searchParams.get("focus");
  // Unread message badge on the Communication tab (current project only;
  // cleared while that tab is open) — see useChatUnreadCount.
  const unreadMessages = useChatUnreadCount({ userId: foremanUserId, projectId, active: tab === "communication" });
  const tabs = TABS.map((t) => (t.key === "communication" ? { ...t, badge: unreadMessages } : t));
  const focusWorkItemCode = searchParams.get("item");
  const notificationId = searchParams.get("n");
  const [dashboardView, setDashboardView] = useState<DashboardView>("dashboard");
  const [reviewsView, setReviewsView] = useState<ReviewsView>("today");
  // Dashboard Department filter: this Subcontractor's own departments in
  // the current project (their role rows — the same options the header
  // Project dropdown is built from). The page loads one department's
  // data server-side, so choosing one reloads the page in that
  // department with the existing ?projectId=&departmentId= switch
  // (resolved by getUserContext among the user's own roles only).
  const router = useRouter();
  const [departmentPending, startDepartmentTransition] = useTransition();
  const departmentOptions = projectOptions.filter(
    (o) => (o.path ?? BASE_PATH) === BASE_PATH && o.projectId === projectId
  );
  if (!departmentOptions.some((o) => o.departmentId === departmentId)) {
    departmentOptions.unshift({ projectId, projectName, departmentId, departmentName });
  }
  function changeDepartment(nextDepartmentId: string) {
    if (nextDepartmentId === departmentId) return;
    const qs = new URLSearchParams({ projectId, departmentId: nextDepartmentId, tab: "dashboard" });
    startDepartmentTransition(() => router.push(`${BASE_PATH}?${qs.toString()}`));
  }
  // A submission opened from Awaiting Contractor Review — History opens
  // filtered to its work item with that row highlighted. Cleared when
  // the user navigates tabs themselves.
  const [historyFocus, setHistoryFocus] = useState<{ submissionId: string; workItemCode: string } | null>(null);
  function changeTab(next: string) {
    setHistoryFocus(null);
    setTab(next);
  }
  function openInHistory(item: AwaitingContractorItem) {
    setHistoryFocus({ submissionId: item.submissionId, workItemCode: item.workItemCode });
    setTab("history");
  }
  useEffect(() => {
    if (tab !== "history" || !historyFocus) return;
    const timer = setTimeout(() => {
      document.querySelector("[data-focused=true]")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 300);
    return () => clearTimeout(timer);
  }, [tab, historyFocus]);
  // KPI cards that lead somewhere real on this page.
  const kpiActions: KpiCardActions = {
    assigned: { onClick: () => setTab("workItems"), label: "Open Work Item Management" },
    completed: { onClick: () => setTab("workItems"), label: "Open Work Item Management" },
    pending: { onClick: () => setTab("reviews"), label: "Open Reviews" },
    progress: { onClick: () => setDashboardView("progress"), label: "Open Progress Tracking" },
    remaining: { onClick: () => setTab("workItems"), label: "Open Work Item Management" },
  };

  return (
    <DashboardShell
      tabs={tabs}
      activeTab={tab}
      onTabChange={changeTab}
      heading={HEADINGS[tab]}
      subheading={`Current Project: ${projectName} · ${departmentName}${projectLocation ? ` · ${projectLocation}` : ""}`}
      userId={foremanUserId}
      userEmail={userEmail}
      roleLabel="Subcontractor"
      profileTabKey="profile"
      showNotificationToasts
      actions={
        <ProjectSelect
          basePath="/workflow/foreman"
          options={projectOptions}
          projectId={projectId}
          departmentId={departmentId}
          tab={tab}
        />
      }
    >
      {tab === "dashboard" && (
        <div className="space-y-5">
          <TabNav
            tabs={DASHBOARD_VIEWS}
            active={dashboardView}
            onChange={(key) => setDashboardView(key as DashboardView)}
          />
          {/* Department filter — the same Filters card as the Contractor
              Dashboard (DashboardPanel), Department only; shown on the
              Dashboard view, which Summary/Progress Tracking follow. */}
          {dashboardView === "dashboard" && (
            <div className="rounded-lg border border-line bg-surface p-4 text-sm shadow-sm">
              <p className="text-foreground-secondary font-medium mb-2">Filters</p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs font-medium text-foreground-secondary mb-1">Department</label>
                  <Select
                    value={departmentId}
                    onChange={(e) => changeDepartment(e.target.value)}
                    disabled={departmentPending}
                    aria-label="Department"
                  >
                    {departmentOptions.map((o) => (
                      <option key={o.departmentId} value={o.departmentId}>
                        {o.departmentName}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            </div>
          )}
          {dashboardView === "dashboard" && !kpis && (
            <ErrorNotice message={BOARD_UNAVAILABLE} onRetry={() => window.location.reload()} />
          )}
          {dashboardView === "dashboard" && kpis && (
            <DashboardKpiCards
              actions={kpiActions}
              totalWorkItems={kpis.totalWorkItems}
              completedCount={kpis.completedCount}
              pendingReviews={kpis.pendingReviews}
              overallProgressPercent={kpis.overallProgressPercent}
              estimatedRevenue={kpis.totalEstimatedValue}
              revenueHint="Estimated value of this department's work at its current approved progress"
              workLeftPercent={kpis.workLeftPercent}
            />
          )}
          {dashboardView === "summary" && (
            // Totals off: the description states them from the same KPI
            // numbers as the Dashboard cards, so the two never disagree.
            <ExecutiveSummaryCard
              view="summary"
              onReviewSubmissions={() => setTab("reviews")}
              showTotals={false}
              projectId={projectId}
              departmentId={departmentId}
              description={
                kpis ? (
                  <KpiSummaryText
                    scopeLabel={departmentName}
                    totalWorkItems={kpis.totalWorkItems}
                    completedCount={kpis.completedCount}
                    pendingReviews={kpis.pendingReviews}
                    overallProgressPercent={kpis.overallProgressPercent}
                    estimatedRevenue={kpis.totalEstimatedValue}
                    workLeftPercent={kpis.workLeftPercent}
                  />
                ) : null
              }
            />
          )}
          {dashboardView === "progress" && (
            <ExecutiveSummaryCard
              view="progress"
              onReviewSubmissions={() => setTab("reviews")}
              showTotals={false}
              projectId={projectId}
              departmentId={departmentId}
            />
          )}
        </div>
      )}

      {tab === "reviews" && (
        <div className="space-y-6">
          {notificationId && (
            <NotificationFocusBanner
              notificationId={notificationId}
              focusState={reviewFocus}
              onOpenHistory={() => setTab("history")}
              recordInQueue={queue.some(
                (q) =>
                  (!!focusSubmissionId && q.submissionId === focusSubmissionId) ||
                  (!!focusWorkItemCode && q.workItemCode === focusWorkItemCode)
              )}
            />
          )}
          <TabNav
            tabs={REVIEWS_VIEWS}
            active={reviewsView}
            onChange={(key) => setReviewsView(key as ReviewsView)}
          />
          {reviewsView === "today" && (
            <ForemanQueue foremanUserId={foremanUserId} items={queue}
              focusSubmissionId={focusSubmissionId}
              focusWorkItemCode={focusWorkItemCode}
            />
          )}

          {/* Visibility only — a Subcontractor cannot act on these, they
              already forwarded them; shown so they know what's still
              waiting on the Contractor rather than assuming it was lost. */}
          {reviewsView === "awaiting" && (
          <Card className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-foreground">Awaiting Contractor Review</h2>
              <span className="text-xs text-foreground-muted tabular-nums">
                {awaitingContractorReview.length} item{awaitingContractorReview.length === 1 ? "" : "s"}
              </span>
            </div>
            {awaitingContractorReview.length === 0 ? (
              <p className="text-foreground-muted">Nothing currently waiting on the Contractor.</p>
            ) : (
              <ul className="divide-y divide-line">
                {awaitingContractorReview.map((item) => (
                  <li key={item.submissionId} className="py-2 flex items-center justify-between gap-2">
                    <span>
                      <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
                      {item.workItemDescription}
                      <span className="text-foreground-muted"> — {item.workerName}</span>
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      <span className="text-xs font-medium text-foreground-secondary tabular-nums">
                        {formatPercent(item.correctedProgress ?? item.submittedProgress)}
                      </span>
                      {/* View only — opens the submission in History; the
                          Contractor still owns the approval. */}
                      <Button variant="secondary" size="sm" onClick={() => openInHistory(item)}>
                        View
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          )}
        </div>
      )}

      {tab === "workItems" && !board && (
        <ErrorNotice message={BOARD_UNAVAILABLE} onRetry={() => window.location.reload()} />
      )}

      {tab === "workItems" && board && (
        <AssignmentManager
          subcontractorUserId={foremanUserId}
          departmentName={board.departmentName}
          workers={board.workers}
          workItems={board.workItems}
          assignments={board.assignments}
          inactiveWorkItems={board.inactiveWorkItems}
          canChangeWorkItemStatus
        />
      )}

      {tab === "history" && (
        <SubmissionHistoryTable
          items={history}
          initialWorkItem={
            historyFocus && history.some((h) => h.workItemCode === historyFocus.workItemCode)
              ? historyFocus.workItemCode
              : ""
          }
          focusSubmissionId={historyFocus?.submissionId ?? null}
        />
      )}

      {tab === "communication" && <ChatPanel contextProjectId={projectId} />}

      {tab === "profile" && (
        <ProfilePanel
          displayName={profile.displayName}
          email={profile.email}
          roleLabel="Subcontractor"
          projectName={projectName}
          departmentName={departmentName}
        />
      )}
    </DashboardShell>
  );
}
