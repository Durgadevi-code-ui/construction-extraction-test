"use client";

import { useState } from "react";
import TabNav from "@/components/workflow/TabNav";
import WorkerHeroCard from "@/components/workflow/WorkerHeroCard";
import WorkItemSelector, {
  type WorkItemOptionView,
} from "@/components/workflow/WorkItemSelector";
import DailyWorkUpdate from "@/components/workflow/DailyWorkUpdate";
import LiveUpdateBar from "@/components/workflow/LiveUpdateBar";
import StatusFlow from "@/components/workflow/StatusFlow";
import { formatDateUS, formatPercent, humanizeApprovalStatus } from "@/lib/format";
import type { WorkerSubmissionStatusCode } from "@/lib/format";

export type WorkerHistoryItem = {
  submissionId: string;
  submittedAt: string;
  workItemCode: string;
  workItemDescription: string;
  submittedProgress: number;
  submittedQuantity: number | null;
  unit: string | null;
  correctedProgress: number | null;
  approvalStatus: string | null;
  reviewStatusLabel: string;
};

export type WorkerApprovedWorkItem = {
  unifiedRecordId: string;
  workItemCode: string;
  workItemDescription: string;
  approvedQuantity: number | null;
  unit: string | null;
  progressPercentage: number | null;
  approvedAt: string;
};

type Props = {
  workerId: string;
  projectName: string;
  departmentName: string;
  activeWorkItem: {
    id: string;
    code: string;
    description: string;
    plannedQuantity: number | null;
    unitOfMeasure: string | null;
  };
  /** Sum of as-submitted quantity across every submission of THIS work
   * item (approved or still pending review) — see WorkerHeroCard's own
   * prop doc. Derived in app/workflow/worker/page.tsx from `history`
   * below, no separate query. */
  submittedQuantity: number | null;
  approvedQuantity: number | null;
  progressPercentage: number | null;
  isCompleted: boolean;
  todaysProgress: number | null;
  latestSubmissionStatusLabel: string | null;
  latestSubmissionStatusCode: WorkerSubmissionStatusCode | null;
  noEligibleWorkNote: string | null;
  workItems: WorkItemOptionView[];
  activeWorkItemId: string;
  isAutoSuggested: boolean;
  suggestionNote: string | null;
  history: WorkerHistoryItem[];
  approvedWork: WorkerApprovedWorkItem[];
};

const TABS = [
  { key: "update", label: "Work Update" },
  { key: "dashboard", label: "Dashboard" },
  { key: "details", label: "Work Details" },
  { key: "history", label: "History" },
  { key: "approved", label: "Approved Work" },
];

/**
 * Worker's persistent top-level navigation — "Work Update" is the
 * default/first tab (updating assigned work is the Worker's primary
 * job here), with Dashboard/Work Details/History reachable without
 * leaving the page. Every section below is the exact same data/logic
 * app/workflow/worker/page.tsx already fetched and previously rendered
 * inline on one long scrolling page — this component only adds tabbed
 * visibility on top, no calculation changed.
 */
export default function WorkerTabs({
  workerId,
  projectName,
  departmentName,
  activeWorkItem,
  submittedQuantity,
  approvedQuantity,
  progressPercentage,
  isCompleted,
  todaysProgress,
  latestSubmissionStatusLabel,
  latestSubmissionStatusCode,
  noEligibleWorkNote,
  workItems,
  activeWorkItemId,
  isAutoSuggested,
  suggestionNote,
  history,
  approvedWork,
}: Props) {
  const [tab, setTab] = useState("update");

  return (
    <div className="space-y-4">
      <TabNav tabs={TABS} active={tab} onChange={setTab} />

      {tab === "update" && (
        <div className="space-y-4">
          {workItems.length > 1 && (
            <WorkItemSelector
              workItems={workItems}
              activeWorkItemId={activeWorkItemId}
              isAutoSuggested={isAutoSuggested}
              suggestionNote={suggestionNote}
            />
          )}
          {noEligibleWorkNote && (
            <p className="text-sm text-foreground-secondary bg-surface-soft border border-line rounded-lg p-3">
              {noEligibleWorkNote}
            </p>
          )}
          <DailyWorkUpdate
            workerId={workerId}
            workItemId={activeWorkItem.id}
            plannedQuantity={activeWorkItem.plannedQuantity}
            unitOfMeasure={activeWorkItem.unitOfMeasure}
          />
          <LiveUpdateBar workItemId={activeWorkItem.id} />
        </div>
      )}

      {tab === "dashboard" && (
        <WorkerHeroCard
          workItemCode={activeWorkItem.code}
          workItemDescription={activeWorkItem.description}
          plannedQuantity={activeWorkItem.plannedQuantity}
          unitOfMeasure={activeWorkItem.unitOfMeasure}
          submittedQuantity={submittedQuantity}
          approvedQuantity={approvedQuantity}
          progressPercentage={progressPercentage}
          isCompleted={isCompleted}
        />
      )}

      {tab === "details" && (
        <section className="bg-surface rounded-lg border border-line shadow-sm p-4 text-sm space-y-2 text-foreground">
          <p>
            <span className="text-foreground-secondary">Project:</span>{" "}
            <span className="font-medium">{projectName}</span>
          </p>
          <p>
            <span className="text-foreground-secondary">Department:</span>{" "}
            <span className="font-medium">{departmentName}</span>
          </p>
          <p>
            <span className="text-foreground-secondary">Work Item:</span>{" "}
            <span className="font-medium">
              {activeWorkItem.code} — {activeWorkItem.description}
            </span>
          </p>
          <p>
            <span className="text-foreground-secondary">Today&apos;s Progress:</span>{" "}
            <span className="font-medium">{formatPercent(todaysProgress)}</span>
          </p>
          {latestSubmissionStatusLabel && (
            <p>
              <span className="text-foreground-secondary">Latest Submission:</span>{" "}
              <span className="font-medium">{latestSubmissionStatusLabel}</span>
            </p>
          )}
          {latestSubmissionStatusCode && (
            <div className="pt-1">
              <StatusFlow statusCode={latestSubmissionStatusCode} />
            </div>
          )}
        </section>
      )}

      {tab === "history" && (
        <section className="bg-surface rounded-lg border border-line shadow-sm p-4 text-sm space-y-3 text-foreground">
          {history.length === 0 ? (
            <p className="text-foreground-secondary">No submissions yet.</p>
          ) : (
            <div className="space-y-3">
              {history.map((item) => (
                <div
                  key={item.submissionId}
                  className="border border-line rounded p-2 space-y-0.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground-secondary">
                      {item.workItemCode} — {item.workItemDescription}
                    </span>
                    <span className="text-xs text-foreground-secondary shrink-0">
                      {formatDateUS(item.submittedAt)}
                    </span>
                  </div>
                  <p>
                    <span className="text-foreground-secondary">Submitted:</span>{" "}
                    <span className="font-medium">
                      {item.submittedQuantity !== null
                        ? `${item.submittedQuantity} ${item.unit ?? ""}`.trim()
                        : `${item.submittedProgress}%`}
                    </span>
                  </p>
                  <p>
                    <span className="text-foreground-secondary">Status:</span>{" "}
                    <span className="font-medium">
                      {item.approvalStatus
                        ? humanizeApprovalStatus(item.approvalStatus)
                        : item.reviewStatusLabel}
                    </span>
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "approved" && (
        <section className="bg-surface rounded-lg border border-line shadow-sm p-4 text-sm space-y-3 text-foreground">
          {approvedWork.length === 0 ? (
            <p className="text-foreground-secondary">Nothing approved yet.</p>
          ) : (
            <div className="space-y-3">
              {approvedWork.map((item) => (
                <div
                  key={item.unifiedRecordId}
                  className="border border-line rounded p-2 space-y-0.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground-secondary">
                      {item.workItemCode} — {item.workItemDescription}
                    </span>
                    <span className="text-xs text-foreground-secondary shrink-0">
                      {formatDateUS(item.approvedAt)}
                    </span>
                  </div>
                  <p>
                    <span className="text-foreground-secondary">Approved:</span>{" "}
                    <span className="font-medium">
                      {item.approvedQuantity !== null
                        ? `${item.approvedQuantity} ${item.unit ?? ""}`.trim()
                        : formatPercent(item.progressPercentage)}
                    </span>
                  </p>
                  <p className="text-xs text-foreground-secondary">Approved by Contractor</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
