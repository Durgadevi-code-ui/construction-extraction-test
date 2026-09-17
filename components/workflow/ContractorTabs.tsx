"use client";

import { useState } from "react";
import { ClipboardList, BarChart3, LayoutDashboard, ListChecks, Building2, Radio, MessageSquare } from "lucide-react";
import DashboardShell from "@/components/workflow/DashboardShell";
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
import ChatPanel from "@/components/workflow/ChatPanel";
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
  { key: "today", label: "Today's Progress", icon: ClipboardList },
  { key: "mtd", label: "MTD Summary", icon: BarChart3 },
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "workItems", label: "Work Items", icon: ListChecks },
  { key: "departments", label: "Department Progress", icon: Building2 },
  { key: "liveUpdates", label: "Live Updates", icon: Radio },
  { key: "communication", label: "Communication", icon: MessageSquare },
];

const HEADINGS: Record<string, string> = {
  today: "Contractor Dashboard",
  mtd: "MTD Summary",
  dashboard: "Dashboard",
  workItems: "Work Items",
  departments: "Department Progress",
  liveUpdates: "Live Updates",
  communication: "Communication",
};

const SUBHEADINGS: Record<string, string> = {
  today: "Review today's submissions and approve or return progress.",
  mtd: "Month-to-date progress across your project.",
  dashboard: "Overall progress, project value, and department breakdown.",
  workItems: "Every work item in scope, with current status.",
  departments: "Progress by department across the project.",
  liveUpdates: "Recent field photos and voice notes from workers.",
  communication: "Project-wide messages for your team.",
};

const DASHBOARD_PANEL_SECTIONS: Record<string, DashboardSection[]> = {
  dashboard: ["overview"],
  departments: ["departments"],
  workItems: ["workItems"],
};

/**
 * Contractor's persistent top-level navigation — same visual shell as
 * the Worker Dashboard (see components/workflow/DashboardShell.tsx),
 * same tab set as before (Today's Progress / MTD Summary / Dashboard /
 * Work Items / Department Progress / Live Updates), plus a new
 * Communication tab. No data or calculation here changed: "Today's
 * Progress" and "MTD Summary" are SupervisorPanel's own two existing
 * views, DashboardPanel is mounted once and shared by Dashboard/Work
 * Items/Department Progress exactly as before — only the chrome around
 * them changed.
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
  const [liveUpdatesFilter, setLiveUpdatesFilter] = useState<string | null>(null);

  const showDashboardPanel = tab === "dashboard" || tab === "workItems" || tab === "departments";

  return (
    <DashboardShell
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      heading={HEADINGS[tab]}
      subheading={SUBHEADINGS[tab]}
      userId={userId}
    >
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
          onViewLiveUpdates={
            tab === "workItems"
              ? (code) => {
                  setLiveUpdatesFilter(code);
                  setTab("liveUpdates");
                }
              : undefined
          }
        />
      )}

      {tab === "dashboard" && (
        <DelegatedAdminPanel contractorUserId={userId} scopes={delegatedScopes} />
      )}

      {tab === "liveUpdates" && <LiveUpdateFeed initialFilterCode={liveUpdatesFilter} />}

      {tab === "communication" && <ChatPanel />}
    </DashboardShell>
  );
}
