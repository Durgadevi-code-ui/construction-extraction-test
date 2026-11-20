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
  X,
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
import ExcelDownloadButton from "@/components/workflow/ExcelDownloadButton";
import DepartmentMultiSelect from "@/components/workflow/DepartmentMultiSelect";
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
// Updates (photos) are not their own destination: each Work Items row,
// History row and Reviews card has its own "View Updates" for that work
// item. The underlying LiveUpdateFeed is unchanged. Profile is opened
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
  // The page's one search box (header toolbar, next to Project) — what it
  // searches follows the open tab; cleared when the tab changes.
  const [query, setQuery] = useState("");
  const search =
    tab === "reviews"
      ? { value: query, onChange: setQuery, placeholder: "Search work item or worker", label: "Search reviews" }
      : tab === "workItems"
        ? { value: query, onChange: setQuery, placeholder: "Search item or department", label: "Search work items" }
        : tab === "history"
          ? { value: query, onChange: setQuery, placeholder: "Search worker, item or status", label: "Search history" }
          : tab === "communication"
            ? { value: query, onChange: setQuery, placeholder: "Search people or roles", label: "Search conversations" }
            : undefined;
  function changeTab(next: string) {
    setQuery("");
    setTab(next);
  }
  // Dashboard Department filter — the header multi-select next to
  // Project (DepartmentMultiSelect). Options are the departments the
  // server put in this Contractor's scope for this project: every
  // department of a project where they hold their own Contractor role,
  // plus delegated ones (lib/dashboard.ts resolveDashboardScope). Empty
  // selection = All Departments; a single department is pre-selected.
  const dashboardDepartmentOptions = dashboardData.scopeDepartments.filter((d) => d.projectId === projectId);
  const [dashboardDepartmentIds, setDashboardDepartmentIds] = useState<string[]>(
    dashboardDepartmentOptions.length === 1 ? [dashboardDepartmentOptions[0].departmentId] : []
  );
  const dashboardDepartmentSet = new Set(dashboardDepartmentIds);
  // Departments where this Contractor may configure tasks — the server's
  // own rule (lib/workflow.ts assertCanManageWorkItemTasks): their own
  // Contractor department(s) in this project, or a delegation with Work
  // Item Management. The server re-checks every change regardless.
  const taskManagementDepartmentIds = [
    ...new Set([
      departmentId,
      ...projectOptions
        .filter((o) => (o.path ?? "/workflow/supervisor") === "/workflow/supervisor" && o.projectId === projectId)
        .map((o) => o.departmentId),
      ...delegatedScopes.filter((s) => s.canManageWorkItems).map((s) => s.departmentId),
    ]),
  ];
  // Progress Tracking follows the Department filter. Its API resolves a
  // department only among the caller's OWN Contractor role rows (lib/
  // workflow.ts getExecutiveSummary → getUserContext), so it covers the
  // filter's role departments in this project — one card per department
  // for "All Departments" (each department's submissions are distinct,
  // so nothing is counted twice). A delegated-only department has no
  // Progress Tracking here (its reviews are in Delegated Admin).
  const roleDepartmentIds = [
    ...new Set([
      departmentId,
      ...projectOptions
        .filter((o) => (o.path ?? "/workflow/supervisor") === "/workflow/supervisor" && o.projectId === projectId)
        .map((o) => o.departmentId),
    ]),
  ];
  const progressDepartmentIds =
    dashboardDepartmentIds.length > 0
      ? roleDepartmentIds.filter((id) => dashboardDepartmentSet.has(id))
      : roleDepartmentIds;
  // Selected departments without the Contractor's own role (visible to
  // them, but Progress Tracking's API only serves their own departments).
  const progressExcludedIds = dashboardDepartmentIds.filter((id) => !roleDepartmentIds.includes(id));
  const departmentNameOf = (id: string) =>
    dashboardData.scopeDepartments.find((d) => d.departmentId === id)?.departmentName ??
    (id === departmentId ? departmentName : "Department");
  // KPI cards that lead somewhere real on this page.
  const kpiActions: KpiCardActions = {
    assigned: { onClick: () => changeTab("workItems"), label: "Open Work Items" },
    completed: { onClick: () => changeTab("workItems"), label: "Open Work Items" },
    pending: { onClick: () => changeTab("reviews"), label: "Open Reviews" },
    progress: { onClick: () => setDashboardView("progress"), label: "Open Progress Tracking" },
    remaining: { onClick: () => changeTab("workItems"), label: "Open Work Items" },
  };

  // Overall Health follows the dashboard's Department filter (none
  // selected = every department in this project's scope).
  const healthAll = dashboardDepartmentIds.length === 0;
  const inHealthScope = (id: string) => healthAll || dashboardDepartmentSet.has(id);
  // The Dashboard KPI row's current values (reported by DashboardPanel,
  // so they follow its Department filter) — described in words on the
  // Summary tab. null until the panel first reports.
  const [dashboardKpis, setDashboardKpis] = useState<DashboardKpiValues | null>(null);
  const summaryScopeLabel = healthAll
    ? `${projectName} (all departments)`
    : dashboardDepartmentIds.map(departmentNameOf).join(", ");
  const healthRows = dashboardData.workItems.filter(
    (w) => w.projectId === projectId && inHealthScope(w.departmentId)
  );
  const healthDepartments = dashboardData.departments.filter(
    (d) => d.projectId === projectId && inHealthScope(d.departmentId)
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
      onTabChange={changeTab}
      heading={HEADINGS[tab]}
      subheading={`Current Project: ${projectName} · ${departmentName}${projectLocation ? ` · ${projectLocation}` : ""}`}
      projectName={projectName}
      userId={userId}
      userEmail={userEmail}
      roleLabel="Contractor"
      profileTabKey="profile"
      showNotificationToasts
      actions={
        <>
          <ProjectSelect
            basePath="/workflow/supervisor"
            options={projectOptions}
            projectId={projectId}
            departmentId={departmentId}
            tab={tab}
          />
          {tab === "dashboard" && (
            <DepartmentMultiSelect
              value={dashboardDepartmentIds}
              options={dashboardDepartmentOptions}
              onChange={setDashboardDepartmentIds}
              allLabel="All Departments"
            />
          )}
        </>
      }
      search={search}
    >
      {tab === "dashboard" && (
        <div className="space-y-5">
          <TabNav
            tabs={DASHBOARD_VIEWS}
            active={dashboardView}
            onChange={(key) => setDashboardView(key as DashboardView)}
          />
          {/* Every selected department, each removable on its own. */}
          {dashboardDepartmentIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Selected departments">
              <span className="text-foreground-secondary">Departments:</span>
              {dashboardDepartmentIds.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full border border-brand-border bg-brand-soft px-2 py-0.5 font-medium text-brand"
                >
                  {departmentNameOf(id)}
                  <button
                    type="button"
                    aria-label={`Remove ${departmentNameOf(id)}`}
                    onClick={() => setDashboardDepartmentIds((prev) => prev.filter((v) => v !== id))}
                    className="rounded-full hover:bg-brand/10"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ))}
              <button type="button" onClick={() => setDashboardDepartmentIds([])} className="text-brand hover:underline">
                Clear all
              </button>
            </div>
          )}
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
            onKpisChange={setDashboardKpis}
            kpiActions={kpiActions}
            departmentFilterOnly
            departmentIds={dashboardDepartmentIds}
            showFilters={false}
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
            activityScope={
              dashboardDepartmentIds.length === 1 && dashboardDepartmentIds[0] === departmentId
                ? "same"
                : healthAll || dashboardDepartmentSet.has(departmentId)
                  ? "partial"
                  : "none"
            }
            activityDepartmentName={departmentName}
            earnedAmount={healthEarned}
            scheduledAmount={healthScheduled}
            monthApprovedValue={sumOrNull(healthDepartments.map((d) => d.currentMonthApprovedValue))}
            previousMonthApprovedValue={sumOrNull(healthDepartments.map((d) => d.previousMonthApprovedValue))}
            onReviewSubmissions={() => changeTab("reviews")}
            description={dashboardKpis ? <KpiSummaryText scopeLabel={summaryScopeLabel} {...dashboardKpis} /> : undefined}
          />
          )}
          {dashboardView === "progress" && progressExcludedIds.length > 0 && (
            <p className="text-sm text-foreground-secondary bg-surface-soft border border-line rounded-lg p-3">
              Progress Tracking covers the departments where you hold your own Contractor role.{" "}
              {progressExcludedIds.map(departmentNameOf).join(", ")}{" "}
              {progressExcludedIds.length === 1 ? "is" : "are"} included in the Dashboard and Summary views.
            </p>
          )}
          {dashboardView === "progress" &&
            progressDepartmentIds.length > 0 && (
              <div className="space-y-5">
                {progressDepartmentIds.map((id) => (
                  <section key={id} className="space-y-2">
                    {progressDepartmentIds.length > 1 && (
                      <h3 className="text-sm font-semibold text-foreground">{departmentNameOf(id)}</h3>
                    )}
                    <ExecutiveSummaryCard
                      onReviewSubmissions={() => changeTab("reviews")}
                      showTotals={false}
                      projectId={projectId}
                      departmentId={id}
                    />
                  </section>
                ))}
              </div>
            )}
        </div>
      )}

      {tab === "reviews" && (
        <div className="space-y-6">
          {notificationId && (
            <NotificationFocusBanner
              notificationId={notificationId}
              focusState={reviewFocus}
              onOpenHistory={() => changeTab("history")}
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
            query={query}
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
          query={query}
          lockProjectId={projectId}
          taskManagementDepartmentIds={taskManagementDepartmentIds}
          showFilters={false}
          headerAction={<ExcelDownloadButton projectId={projectId} className="sm:mr-auto" />}
        />
      )}

      {tab === "history" && <SubmissionHistoryTable items={history} query={query} />}

      {tab === "communication" && <ChatPanel contextProjectId={projectId} query={query} />}

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
