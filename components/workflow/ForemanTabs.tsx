"use client";

import { useState } from "react";
import TabNav from "@/components/workflow/TabNav";
import AssignmentManager, {
  type AssignmentWorkerOption,
  type AssignmentWorkItemOption,
  type AssignmentRow,
} from "@/components/workflow/AssignmentManager";
import ForemanQueue, { type ForemanQueueItem } from "@/components/workflow/ForemanQueue";
import LiveUpdateFeed from "@/components/workflow/LiveUpdateFeed";
import { formatPercent } from "@/lib/format";

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
  { key: "dashboard", label: "Dashboard" },
  { key: "assignments", label: "Work Item Assignments" },
  { key: "reviews", label: "Reviews" },
  { key: "liveUpdates", label: "Live Updates" },
];

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
        highlight ? "bg-amber-50 border-amber-200" : "bg-white border-line"
      }`}
      title={hint}
    >
      <p className={`text-lg font-bold ${highlight ? "text-amber-700" : "text-foreground"}`}>
        {value}
      </p>
      <p className="text-xs text-foreground-secondary">{label}</p>
    </div>
  );
}

/**
 * Subcontractor's persistent top-level navigation — locked to Dashboard /
 * Work Item Assignments / Reviews (operational department/workforce
 * management, distinct from the Contractor's project-level tabs; see
 * app/workflow/foreman/page.tsx). Every section here is the exact same
 * data/component app/workflow/foreman/page.tsx already fetched and
 * previously rendered inline on one long scrolling page — only tabbed
 * visibility is added, no calculation or assignment/review logic changed.
 */
export default function ForemanTabs({ foremanUserId, kpis, board, queue, awaitingContractorReview }: Props) {
  const [tab, setTab] = useState("dashboard");

  return (
    <div className="space-y-4">
      <TabNav tabs={TABS} active={tab} onChange={setTab} />

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
          <section className="bg-white rounded-lg border border-line p-4 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-foreground">Awaiting Contractor Review</h2>
              <span className="text-xs text-foreground-muted">
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
                    <span className="text-xs font-medium text-foreground-secondary shrink-0">
                      {formatPercent(item.correctedProgress ?? item.submittedProgress)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {tab === "liveUpdates" && <LiveUpdateFeed />}
    </div>
  );
}
