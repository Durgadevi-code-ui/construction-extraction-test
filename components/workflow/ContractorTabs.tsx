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
import DashboardPanel from "@/components/workflow/DashboardPanel";
import SupervisorPanel, {
  type SupervisorQueueItem,
  type WorkItemProgressView,
  type WorkSummaryView,
} from "@/components/workflow/SupervisorPanel";
import DelegatedAdminPanel, {
  type DelegatedDepartmentScope,
} from "@/components/workflow/DelegatedAdminPanel";
import LiveUpdateFeed from "@/components/workflow/LiveUpdateFeed";
import ChatPanel from "@/components/workflow/ChatPanel";
import NotificationFocusBanner from "@/components/workflow/NotificationFocusBanner";
import SubmissionHistoryTable, { type SubmissionHistoryRow } from "@/components/workflow/SubmissionHistoryTable";
import ProfilePanel from "@/components/workflow/ProfilePanel";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
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
  /** Rendered in the header only when the Contractor holds more than one
   * project — links that reload this page in another project context. */
  projectSwitcher?: React.ReactNode;
  /** Current Project location — display only; null when not set. */
  projectLocation?: string | null;
};

// Same tab set as the Subcontractor (see ForemanTabs), role data differs.
// Live Updates is no longer its own destination: it lives on each review
// card and work item (filtered to that item), plus the full feed at the
// bottom of Reviews — the underlying LiveUpdateFeed is unchanged.
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

/**
 * Contractor's top-level navigation — same DashboardShell as every
 * other role. Dashboard = project brief (Daily/Weekly/Monthly, executive
 * bullets, earned value) + overall progress/project value + Department
 * Progress; Reviews = Today Reviews (approve/edit/comment/rollback,
 * unchanged) with per-card Live Updates, today's activity and the full
 * live feed; Work Items = searchable list with per-item Live Updates;
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
  projectSwitcher,
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
    return TABS.some((t) => t.key === requested) ? requested : "dashboard";
  });
  const focusSubmissionId = searchParams.get("focus");
  const focusWorkItemCode = searchParams.get("item");
  const notificationId = searchParams.get("n");
  const [showAllLiveUpdates, setShowAllLiveUpdates] = useState(false);

  const panelProps = {
    supervisorUserId: userId,
    queue,
    todaysProgress,
    yesterdaysProgress,
    mtdProgress,
    workSummary,
    forcedTab: "today" as const,
    projectId,
  };

  return (
    <DashboardShell
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      heading={HEADINGS[tab]}
      subheading={`Current Project: ${projectName} · ${departmentName}${projectLocation ? ` · ${projectLocation}` : ""}`}
      userId={userId}
      userEmail={userEmail}
      roleLabel="Contractor"
      showNotificationToasts
      actions={projectSwitcher}
    >
      {tab === "dashboard" && (
        <div className="space-y-6">
          <SupervisorPanel {...panelProps} todaySection="summary" onReviewSubmissions={() => setTab("reviews")} />
          <DashboardPanel
            userId={userId}
            initialData={dashboardData}
            // The brief above already shows this department's progress,
            // earned value and completed/remaining work; the ring + Project
            // Value only add information when the scope spans several
            // departments (e.g. via delegation), so show them only then.
            sections={dashboardData.scopeDepartments.length > 1 ? ["overview", "departments"] : ["departments"]}
            animateProgress
            lockProjectId={projectId}
          />
          <DelegatedAdminPanel contractorUserId={userId} scopes={delegatedScopes} />
        </div>
      )}

      {tab === "reviews" && (
        <div className="space-y-6">
          {notificationId && (
            <NotificationFocusBanner
              notificationId={notificationId}
              recordInQueue={queue.some(
                (q) =>
                  (!!focusSubmissionId && q.submissionId === focusSubmissionId) ||
                  (!!focusWorkItemCode && q.workItemCode === focusWorkItemCode)
              )}
            />
          )}
          <SupervisorPanel {...panelProps} todaySection="reviews"
            focusSubmissionId={focusSubmissionId}
            focusWorkItemCode={focusWorkItemCode}
          />
          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="font-semibold text-foreground">Live Updates from the Field</h2>
                <p className="text-sm text-foreground-secondary">
                  Every worker photo and voice note in your scope. Each review card above also shows its own.
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setShowAllLiveUpdates((v) => !v)}>
                {showAllLiveUpdates ? "Hide" : "Show all live updates"}
              </Button>
            </div>
            {showAllLiveUpdates && <LiveUpdateFeed mode="normal" />}
          </Card>
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

      {tab === "communication" && <ChatPanel />}

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
