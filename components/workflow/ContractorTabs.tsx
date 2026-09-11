"use client";

import { useState } from "react";
import TabNav from "@/components/workflow/TabNav";
import DashboardPanel, { type DashboardSection } from "@/components/workflow/DashboardPanel";
import SupervisorPanel, {
  type SupervisorQueueItem,
  type WorkItemProgressView,
  type WorkSummaryView,
} from "@/components/workflow/SupervisorPanel";
import DelegatedAdminPanel, {
  type DelegatedDepartmentScope,
} from "@/components/workflow/DelegatedAdminPanel";
import LiveUpdateFeed from "@/components/workflow/LiveUpdateFeed";
import type { DashboardData } from "@/lib/dashboard";

type Props = {
  userId: string;
  dashboardData: DashboardData;
  queue: SupervisorQueueItem[];
  todaysProgress: SupervisorQueueItem[];
  yesterdaysProgress: SupervisorQueueItem[];
  mtdProgress: WorkItemProgressView[];
  workSummary: WorkSummaryView;
  delegatedScopes: DelegatedDepartmentScope[];
};

const TABS = [
  { key: "today", label: "Today's Progress" },
  { key: "mtd", label: "MTD Summary" },
  { key: "dashboard", label: "Dashboard" },
  { key: "workItems", label: "Work Items" },
  { key: "departments", label: "Department Progress" },
  { key: "liveUpdates", label: "Live Updates" },
];

const DASHBOARD_PANEL_SECTIONS: Record<string, DashboardSection[]> = {
  dashboard: ["overview"],
  departments: ["departments"],
  workItems: ["workItems"],
};

/**
 * Contractor's persistent top-level navigation — locked to Today's
 * Progress / MTD Summary / Dashboard / Work Items / Department Progress
 * (project-level oversight, distinct from the Subcontractor's
 * operational tabs; see app/workflow/supervisor/page.tsx). No new data
 * or calculation here: "Today's Progress" and "MTD Summary" are
 * SupervisorPanel's own two existing views (previously nested behind
 * its own internal tab switcher — see forcedTab on SupervisorPanel),
 * now promoted to top-level tabs since the Contractor's approve/reject
 * queue lives inside "Today's Progress" (its "Today's Work Summary"
 * section) exactly like before — no separate "Reviews" tab is added.
 * DashboardPanel is mounted once, shared by Dashboard/Work Items/
 * Department Progress, so switching between those three never
 * re-fetches — only which of its already-loaded sections is visible
 * changes; its own Filters stay available across all three.
 */
export default function ContractorTabs({
  userId,
  dashboardData,
  queue,
  todaysProgress,
  yesterdaysProgress,
  mtdProgress,
  workSummary,
  delegatedScopes,
}: Props) {
  const [tab, setTab] = useState("today");

  const showDashboardPanel = tab === "dashboard" || tab === "workItems" || tab === "departments";

  return (
    <div className="space-y-4">
      <TabNav tabs={TABS} active={tab} onChange={setTab} />

      {tab === "today" && (
        <SupervisorPanel
          supervisorUserId={userId}
          queue={queue}
          todaysProgress={todaysProgress}
          yesterdaysProgress={yesterdaysProgress}
          mtdProgress={mtdProgress}
          workSummary={workSummary}
          forcedTab="today"
        />
      )}

      {tab === "mtd" && (
        <SupervisorPanel
          supervisorUserId={userId}
          queue={queue}
          todaysProgress={todaysProgress}
          yesterdaysProgress={yesterdaysProgress}
          mtdProgress={mtdProgress}
          workSummary={workSummary}
          forcedTab="mtd"
        />
      )}

      {showDashboardPanel && (
        <DashboardPanel
          userId={userId}
          initialData={dashboardData}
          sections={DASHBOARD_PANEL_SECTIONS[tab]}
        />
      )}

      {tab === "dashboard" && (
        <DelegatedAdminPanel contractorUserId={userId} scopes={delegatedScopes} />
      )}

      {tab === "liveUpdates" && <LiveUpdateFeed />}
    </div>
  );
}
