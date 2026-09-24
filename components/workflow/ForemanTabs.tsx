"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  ListChecks,
  ClipboardCheck,
  History as HistoryIcon,
  MessageSquare,
  UserRound,
  CheckCircle2,
  Clock,
  TrendingUp,
  Percent,
  DollarSign,
} from "lucide-react";
import DashboardShell from "@/components/workflow/DashboardShell";
import AssignmentManager, {
  type AssignmentWorkerOption,
  type AssignmentWorkItemOption,
  type AssignmentRow,
} from "@/components/workflow/AssignmentManager";
import ForemanQueue, { type ForemanQueueItem } from "@/components/workflow/ForemanQueue";
import LiveUpdateFeed from "@/components/workflow/LiveUpdateFeed";
import ChatPanel from "@/components/workflow/ChatPanel";
import NotificationFocusBanner from "@/components/workflow/NotificationFocusBanner";
import SubmissionHistoryTable, { type SubmissionHistoryRow } from "@/components/workflow/SubmissionHistoryTable";
import ProfilePanel from "@/components/workflow/ProfilePanel";
import { ExecutiveSummaryCard } from "@/components/workflow/SupervisorPanel";
import { useCountUp } from "@/components/workflow/useCountUp";
import { formatPercent } from "@/lib/format";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";

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
  } | null;
  queue: ForemanQueueItem[];
  awaitingContractorReview: AwaitingContractorItem[];
  /** Older submissions (getSubmissionHistory, department-scoped). */
  history: SubmissionHistoryRow[];
  /** The project every section is scoped to (resolved server-side). */
  projectId: string;
  /** Shown only when the Subcontractor holds more than one project. */
  projectSwitcher?: React.ReactNode;
  /** Current Project location — display only; null when not set. */
  projectLocation?: string | null;
};

// Same tab set as the Contractor (see ContractorTabs), role data differs.
// Live Updates is no longer its own destination: each review card shows
// its own (filtered to the work item), Work Item Management keeps its
// department photo view, and the full feed sits at the bottom of Reviews.
const TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "reviews", label: "Reviews", icon: ClipboardCheck },
  { key: "workItems", label: "Work Items", icon: ListChecks },
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

// One semantic color per metric so the six KPIs are distinguishable at a
// glance (previously brand teal and success green read as the same
// color). Theme tokens where one fits (success/brand), Tailwind's
// default palette for the hues the theme has no token for — icon chips
// only, card body stays white, same as before.
type KpiTone = "assigned" | "completed" | "pending" | "progress" | "remaining" | "revenue";

const KPI_ICON_CHIP: Record<KpiTone, string> = {
  assigned: "bg-blue-600 text-white",
  completed: "bg-success text-white",
  pending: "bg-orange-500 text-white",
  progress: "bg-brand text-white",
  remaining: "bg-amber-400 text-amber-950",
  revenue: "bg-indigo-600 text-white",
};

function KpiCard({
  label,
  value,
  icon: Icon,
  highlight,
  tone,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  highlight?: boolean;
  tone: KpiTone;
  hint?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border p-3 ${
        highlight ? "bg-warning-soft border-warning-border" : "bg-white border-line"
      }`}
      title={hint}
    >
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${KPI_ICON_CHIP[tone]}`}>
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div>
        <p className={`text-lg font-bold tabular-nums leading-tight ${highlight ? "text-warning" : "text-foreground"}`}>
          {value}
        </p>
        <p className="text-xs text-foreground-secondary">{label}</p>
      </div>
    </div>
  );
}

/** A percentage that counts up 0 → value on load (display only). */
function CountUpPercent({ value }: { value: number }) {
  return <>{formatPercent(useCountUp(value))}</>;
}

/**
 * Subcontractor's top-level navigation — same DashboardShell and tab set
 * as the Contractor. Dashboard = KPIs + the shared project brief;
 * Reviews = the Subcontractor review queue (forward/edit/comment,
 * unchanged) with per-card Live Updates, what's awaiting the Contractor,
 * and the full live feed; Work Items = Work Item Management (assign /
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

  return (
    <DashboardShell
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      heading={HEADINGS[tab]}
      subheading={`Current Project: ${projectName} · ${departmentName}${projectLocation ? ` · ${projectLocation}` : ""}`}
      userId={foremanUserId}
      userEmail={userEmail}
      roleLabel="Subcontractor"
      showNotificationToasts
      actions={projectSwitcher}
    >
      {tab === "dashboard" && (
        <div className="space-y-6">
          {kpis && (
            <section className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <KpiCard icon={ListChecks} label="Assigned Work" value={`${kpis.totalWorkItems}`} tone="assigned" />
              <KpiCard icon={CheckCircle2} label="Completed" value={`${kpis.completedCount}`} tone="completed" />
              <KpiCard
                icon={Clock}
                label="Pending Review"
                value={`${kpis.pendingReviews}`}
                tone="pending"
                highlight={kpis.pendingReviews > 0}
              />
              <KpiCard
                icon={TrendingUp}
                label="Overall Progress"
                value={<CountUpPercent value={kpis.overallProgressPercent} />}
                tone="progress"
              />
              <KpiCard
                icon={Percent}
                label="Work Left"
                value={<CountUpPercent value={kpis.workLeftPercent} />}
                tone="remaining"
              />
              <KpiCard
                icon={DollarSign}
                tone="revenue"
                label="Estimated Revenue"
                value={`$${kpis.totalEstimatedValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                hint="Estimated value of this department's work at its current approved progress"
              />
            </section>
          )}
          {/* Totals are already the KPI cards above — the brief adds the
              period change, what happened and what needs attention. */}
          <ExecutiveSummaryCard onReviewSubmissions={() => setTab("reviews")} showTotals={false} projectId={projectId} />
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
          <div>
            <h2 className="font-semibold text-foreground mb-3">Today Reviews</h2>
            <ForemanQueue foremanUserId={foremanUserId} items={queue}
              focusSubmissionId={focusSubmissionId}
              focusWorkItemCode={focusWorkItemCode}
            />
          </div>

          {/* Visibility only — a Subcontractor cannot act on these, they
              already forwarded them; shown so they know what's still
              waiting on the Contractor rather than assuming it was lost. */}
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
                    <span className="text-xs font-medium text-foreground-secondary shrink-0 tabular-nums">
                      {formatPercent(item.correctedProgress ?? item.submittedProgress)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="font-semibold text-foreground">Live Updates from the Field</h2>
                <p className="text-sm text-foreground-secondary">
                  Every worker photo and voice note in your department. Each review card above also shows its own.
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

      {tab === "workItems" && board && (
        <AssignmentManager
          subcontractorUserId={foremanUserId}
          departmentName={board.departmentName}
          workers={board.workers}
          workItems={board.workItems}
          assignments={board.assignments}
        />
      )}

      {tab === "history" && <SubmissionHistoryTable items={history} />}

      {tab === "communication" && <ChatPanel />}

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
