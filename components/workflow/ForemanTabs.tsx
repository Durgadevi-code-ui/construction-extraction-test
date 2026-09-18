"use client";

import { useState } from "react";
import { LayoutDashboard, ListChecks, ClipboardCheck, Radio, MessageSquare } from "lucide-react";
import DashboardShell from "@/components/workflow/DashboardShell";
import AssignmentManager, {
  type AssignmentWorkerOption,
  type AssignmentWorkItemOption,
  type AssignmentRow,
} from "@/components/workflow/AssignmentManager";
import ForemanQueue, { type ForemanQueueItem } from "@/components/workflow/ForemanQueue";
import LiveUpdateFeed from "@/components/workflow/LiveUpdateFeed";
import ChatPanel from "@/components/workflow/ChatPanel";
import { formatPercent } from "@/lib/format";
import Card from "@/components/ui/Card";

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
};

const TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "assignments", label: "Work Item Assignments", icon: ListChecks },
  { key: "reviews", label: "Reviews", icon: ClipboardCheck },
  { key: "liveUpdates", label: "Live Updates", icon: Radio },
  { key: "communication", label: "Communication", icon: MessageSquare },
];

const HEADINGS: Record<string, string> = {
  dashboard: "Subcontractor Dashboard",
  assignments: "Work Item Assignments",
  reviews: "Reviews",
  liveUpdates: "Live Updates",
  communication: "Communication",
};

function KpiCard({
  label,
  value,
  highlight,
  hint,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        highlight ? "bg-warning-soft border-warning-border" : "bg-white border-line"
      }`}
      title={hint}
    >
      <p className={`text-lg font-bold tabular-nums ${highlight ? "text-warning" : "text-foreground"}`}>
        {value}
      </p>
      <p className="text-xs text-foreground-secondary">{label}</p>
    </div>
  );
}

/**
 * Subcontractor's persistent top-level navigation — same visual shell
 * as the Worker Dashboard (see components/workflow/DashboardShell.tsx),
 * same tab set as before (Dashboard / Work Item Assignments / Reviews /
 * Live Updates), plus a new Communication tab. Every section is the
 * exact same data/component app/workflow/foreman/page.tsx already
 * fetched — only the chrome around them changed.
 */
export default function ForemanTabs({
  foremanUserId,
  departmentName,
  kpis,
  board,
  queue,
  awaitingContractorReview,
}: Props) {
  const [tab, setTab] = useState("dashboard");

  return (
    <DashboardShell
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      heading={HEADINGS[tab]}
      subheading={`My Department: ${departmentName}`}
      userId={foremanUserId}
    >
      {tab === "dashboard" && kpis && (
        <section className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <KpiCard label="Assigned Work" value={`${kpis.totalWorkItems}`} />
          <KpiCard label="Completed" value={`${kpis.completedCount}`} />
          <KpiCard
            label="Pending Review"
            value={`${kpis.pendingReviews}`}
            highlight={kpis.pendingReviews > 0}
          />
          <KpiCard label="Overall Progress" value={formatPercent(kpis.overallProgressPercent)} />
          <KpiCard label="Work Left" value={formatPercent(kpis.workLeftPercent)} />
          <KpiCard
            label="Estimated Revenue"
            value={`$${kpis.totalEstimatedValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
            hint="Estimated value of this department's work at its current approved progress"
          />
        </section>
      )}

      {tab === "assignments" && board && (
        <AssignmentManager
          subcontractorUserId={foremanUserId}
          departmentName={board.departmentName}
          workers={board.workers}
          workItems={board.workItems}
          assignments={board.assignments}
        />
      )}

      {tab === "reviews" && (
        <div className="space-y-6">
          <ForemanQueue foremanUserId={foremanUserId} items={queue} />

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
        </div>
      )}

      {/* The general/normal Live Updates tab — every media type (image
          AND voice), unfiltered. Distinct from the Department-scoped
          image-only panel embedded inline in the Work Item Assignments
          tab (AssignmentManager), which never routes here. */}
      {tab === "liveUpdates" && <LiveUpdateFeed mode="normal" />}

      {tab === "communication" && <ChatPanel />}
    </DashboardShell>
  );
}
