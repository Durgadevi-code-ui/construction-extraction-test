"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  ClipboardCheck,
  ListChecks,
  History as HistoryIcon,
  MessageSquare,
  UserRound,
} from "lucide-react";
import DashboardShell from "@/components/workflow/DashboardShell";
import TabNav from "@/components/workflow/TabNav";
import { KpiSummaryText, type DashboardKpiValues, type KpiCardActions } from "@/components/workflow/KpiCards";
import ProjectSelect, { type ProjectOption } from "@/components/workflow/ProjectSelect";
import { useChatUnreadCount } from "@/components/workflow/useChatUnreadCount";
import DashboardPanel from "@/components/workflow/DashboardPanel";
import SupervisorPanel, {
  ExecutiveSummaryCard,
  OverallHealthSummary,
  type SupervisorQueueItem,
  type WorkItemProgressView,
  type WorkSummaryView,
} from "@/components/workflow/SupervisorPanel";
import DelegatedAdminPanel, {
  type DelegatedDepartmentScope,
} from "@/components/workflow/DelegatedAdminPanel";
import ChatPanel from "@/components/workflow/ChatPanel";
import NotificationFocusBanner from "@/components/workflow/NotificationFocusBanner";
import SubmissionHistoryTable, { type SubmissionHistoryRow } from "@/components/workflow/SubmissionHistoryTable";
import type { ReviewFocusState } from "@/lib/workflow";
import ProfilePanel from "@/components/workflow/ProfilePanel";
import type { DashboardData } from "@/lib/dashboard";

type Props = {
  userId: string;
  /** The signed-in Contractor's email — for the header's profile chip. */
  userEmail?: string;
  /** The signed-in Contractor's own name/email (Profile tab). */
  profile: { displayName: string; email: string };
  projectName: string;
  departmentName: string;
  dashboardData: DashboardData;
  queue: SupervisorQueueItem[];
  todaysProgress: SupervisorQueueItem[];
  yesterdaysProgress: SupervisorQueueItem[];
  mtdProgress: WorkItemProgressView[];
  workSummary: WorkSummaryView;
  delegatedScopes: DelegatedDepartmentScope[];
  /** Older submissions (getSubmissionHistory, department-scoped). */
  history: SubmissionHistoryRow[];
  /** The project every section below is scoped to (resolved server-side
   * among the Contractor's own roles). */
  projectId: string;
  /** The department within that project every department-level section
   * (brief, reviews, activity, history) is scoped to — resolved
   * server-side among the Contractor's own roles. */
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

// Same tab set as the Subcontractor (see ForemanTabs), role data differs.
// Updates (photos) are not their own destination: they live only on Work
// Items, one "View Updates" per work item (see WorkItemList) — not on
// Reviews. The underlying LiveUpdateFeed is unchanged. Profile is opened
// from the Profile control above Sign out (DashboardShell profileTabKey).
const TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "reviews", label: "Reviews", icon: ClipboardCheck },
  { key: "workItems", label: "Work Items", icon: ListChecks },
  { key: "history", label: "History", icon: HistoryIcon },
  { key: "communication", label: "Communication", icon: MessageSquare },
  { key: "profile", label: "Profile", icon: UserRound },
];

const HEADINGS: Record<string, string> = {
  dashboard: "Contractor Dashboard",
  reviews: "Reviews",
  workItems: "Work Items",
  history: "Submission History",
  communication: "Communication",
  profile: "My Profile",
};

/** Old ?tab= values (bookmarks, older notification links) → new tabs. */
const LEGACY_TABS: Record<string, string> = { today: "reviews", liveUpdates: "reviews" };

/** The Dashboard's views, as tabs side by side at the top:
 * Dashboard (filters, KPI row, Delegated Admin) | Summary (the
 * Overall Health summary) | Progress Tracking. */
type DashboardView = "dashboard" | "summary" | "progress";
const DASHBOARD_VIEWS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "summary", label: "Summary" },
  { key: "progress", label: "Progress Tracking" },
];

/**
 * Contractor's top-level navigation — same DashboardShell as every
 * other role. Dashboard = the Subcontractor Dashboard's structure:
 * Filters, KPI row, project brief (Today/This Week/MTD, executive
 * bullets), Delegated Admin; Reviews = Today Reviews (approve/edit/comment/rollback,
 * unchanged) and today's activity; Work Items = searchable list with
 * per-item Live Updates;
 * History = the existing Submission History. Every section reuses the
 * existing component/data — only the arrangement changed.
 */
export default function ContractorTabs({
  userId,
  userEmail,
  profile,
  projectName,
  departmentName,
  dashboardData,
  queue,
  todaysProgress,
  yesterdaysProgress,
  mtdProgress,
  workSummary,
  delegatedScopes,
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
  const unreadMessages = useChatUnreadCount({ userId: userId, projectId, active: tab === "communication" });
  // Contractor's message count reads red (sidebar badge and the count in
  // Communication).
  const tabs = TABS.map((t) =>
    t.key === "communication" ? { ...t, badge: unreadMessages, badgeClassName: "bg-error" } : t
  );
  const focusWorkItemCode = searchParams.get("item");
  const notificationId = searchParams.get("n");
  const [dashboardView, setDashboardView] = useState<DashboardView>("dashboard");
  // KPI cards that lead somewhere real on this page.
  const kpiActions: KpiCardActions = {
    assigned: { onClick: () => setTab("workItems"), label: "Open Work Items" },
    completed: { onClick: () => setTab("workItems"), label: "Open Work Items" },
    pending: { onClick: () => setTab("reviews"), label: "Open Reviews" },
    progress: { onClick: () => setDashboardView("progress"), label: "Open Progress Tracking" },
    remaining: { onClick: () => setTab("workItems"), label: "Open Work Items" },
  };

  // Overall Health follows the dashboard's Department filter ("" = every
  // department in this project's scope) — null until the panel reports
  // it, meaning the page's current department.
  const [healthDepartmentId, setHealthDepartmentId] = useState<string | null>(null);
  const healthScope = healthDepartmentId ?? departmentId;
  // The Dashboard KPI row's current values (reported by DashboardPanel,
  // so they follow its Department filter) — described in words on the
  // Summary tab. null until the panel first reports.
  const [dashboardKpis, setDashboardKpis] = useState<DashboardKpiValues | null>(null);
  const summaryScopeLabel =
    healthScope === ""
      ? `${projectName} (all departments)`
      : (dashboardData.scopeDepartments.find((d) => d.departmentId === healthScope)?.departmentName ?? departmentName);
  const healthRows = dashboardData.workItems.filter(
    (w) => w.projectId === projectId && (!healthScope || w.departmentId === healthScope)
  );
  const healthDepartments = dashboardData.departments.filter(
    (d) => d.projectId === projectId && (!healthScope || d.departmentId === healthScope)
  );
  // Earned vs scheduled over the same scope (existing department totals);
  // null when financials aren't available for any department in it.
  const sumOrNull = (values: (number | null | undefined)[]) =>
    dashboardData.includeFinancials && values.length > 0 && values.every((v) => typeof v === "number")
      ? Math.round((values as number[]).reduce((a, b) => a + b, 0) * 100) / 100
      : null;
  const healthEarned = sumOrNull(healthDepartments.map((d) => d.totalApprovedValue));
  const healthScheduled = sumOrNull(healthDepartments.map((d) => d.totalEstimatedAmount));

  const panelProps = {
    supervisorUserId: userId,
    queue,
    todaysProgress,
    yesterdaysProgress,
    mtdProgress,
    workSummary,
    forcedTab: "today" as const,
    projectId,
    departmentId,
  };

  return (
    <DashboardShell
      tabs={tabs}
      activeTab={tab}
      onTabChange={setTab}
      heading={HEADINGS[tab]}
      subheading={`Current Project: ${projectName} · ${departmentName}${projectLocation ? ` · ${projectLocation}` : ""}`}
      userId={userId}
      userEmail={userEmail}
      roleLabel="Contractor"
      profileTabKey="profile"
      showNotificationToasts
      actions={
        <ProjectSelect
          basePath="/workflow/supervisor"
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
          {/* Dashboard view: Filters (the existing DashboardPanel filters,
              which drive the KPI row) → the shared KPI row (each card opens
              its detail) → Delegated Admin. Kept mounted while another view
              is open so the Department filter (which Summary follows)
              keeps its value. Department Progress and the scope line are
              not shown here (the header names the project). */}
          <div className={dashboardView === "dashboard" ? "space-y-5" : "hidden"}>
          <DashboardPanel
            userId={userId}
            initialData={dashboardData}
            sections={["kpis"]}
            showScope={false}
            pendingReviews={queue.length}
            lockProjectId={projectId}
            onDepartmentChange={setHealthDepartmentId}
            onKpisChange={setDashboardKpis}
            kpiActions={kpiActions}
            departmentFilterOnly
          />
          <DelegatedAdminPanel contractorUserId={userId} scopes={delegatedScopes} />
          </div>
          {/* Executive Summary — the end-to-end written interpretation
              (current state, today + previous days, attention items,
              required action), kept separate from the KPI row above and
              from the period (Today / This Week / MTD) card below. It
              follows the Department filter, like the dashboard's own
              roll-ups; data already on this page. */}
          {dashboardView === "summary" && (
          <OverallHealthSummary
            workItems={healthRows}
            history={history}
            pendingItems={queue}
            activityScope={healthScope === departmentId ? "same" : healthScope === "" ? "partial" : "none"}
            activityDepartmentName={departmentName}
            earnedAmount={healthEarned}
            scheduledAmount={healthScheduled}
            monthApprovedValue={sumOrNull(healthDepartments.map((d) => d.currentMonthApprovedValue))}
            previousMonthApprovedValue={sumOrNull(healthDepartments.map((d) => d.previousMonthApprovedValue))}
            onReviewSubmissions={() => setTab("reviews")}
            description={dashboardKpis ? <KpiSummaryText scopeLabel={summaryScopeLabel} {...dashboardKpis} /> : undefined}
          />
          )}
          {dashboardView === "progress" && (
          <ExecutiveSummaryCard
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
                  !(q.isCompleted && q.approvalStatus === "APPROVED") &&
                  ((!!focusSubmissionId && q.submissionId === focusSubmissionId) ||
                    (!!focusWorkItemCode && q.workItemCode === focusWorkItemCode))
              )}
            />
          )}
          <SupervisorPanel {...panelProps} todaySection="reviews"
            focusSubmissionId={focusSubmissionId}
            focusWorkItemCode={focusWorkItemCode}
          />
        </div>
      )}

      {tab === "workItems" && (
        <DashboardPanel
          userId={userId}
          initialData={dashboardData}
          sections={["workItems"]}
          showLiveUpdatesColumn
          showSearch
          lockProjectId={projectId}
        />
      )}

      {tab === "history" && <SubmissionHistoryTable items={history} />}

      {tab === "communication" && <ChatPanel contextProjectId={projectId} />}

      {tab === "profile" && (
        <ProfilePanel
          displayName={profile.displayName}
          email={profile.email}
          roleLabel="Contractor"
          projectName={projectName}
          departmentName={departmentName}
        />
      )}
    </DashboardShell>
  );
}
