"use client";

import { useState } from "react";
import {
  LayoutDashboard,
  ClipboardList,
  FileText,
  History as HistoryIcon,
  CheckCircle2,
  FileClock,
  LogOut,
  MessageSquare,
} from "lucide-react";
import ChatPanel from "@/components/workflow/ChatPanel";
import WorkerHeroCard from "@/components/workflow/WorkerHeroCard";
import WorkItemSelector, {
  type WorkItemOptionView,
} from "@/components/workflow/WorkItemSelector";
import DailyWorkUpdate from "@/components/workflow/DailyWorkUpdate";
import LiveUpdateBar from "@/components/workflow/LiveUpdateBar";
import StatusFlow from "@/components/workflow/StatusFlow";
import ProgressRing from "@/components/workflow/charts/ProgressRing";
import NotificationBell from "@/components/workflow/NotificationBell";
import { formatDateUS, formatPercent, formatQuantity, humanizeApprovalStatus } from "@/lib/format";
import type { WorkerSubmissionStatusCode } from "@/lib/format";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import { logout } from "@/app/login/actions";

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
  /** Rendered in the header row, left of the date chip — a "switch
   * project" control (see app/workflow/worker/page.tsx), only ever
   * non-null when this worker actually holds more than one active
   * project assignment. Omitted entirely for the (still-common)
   * single-project worker, same principle as DashboardShell's `actions`
   * prop. */
  projectSwitcher?: React.ReactNode;
};

const TABS = [
  { key: "update", label: "Work Update", icon: ClipboardList },
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "details", label: "Work Details", icon: FileText },
  { key: "history", label: "History", icon: HistoryIcon },
  { key: "approved", label: "Approved Work", icon: CheckCircle2 },
  { key: "communication", label: "Communication", icon: MessageSquare },
] as const;

/**
 * Worker's persistent navigation, presented as a left sidebar (visual
 * direction requested for the Worker Dashboard) with "Work Update" as
 * the default/first tab — updating assigned work is the Worker's
 * primary job here. Dashboard/Work Details/History/Approved Work stay
 * reachable without leaving the page. Every section below is the exact
 * same data/logic app/workflow/worker/page.tsx already fetched — this
 * component only changes how that data is arranged/styled, no
 * calculation changed. Sign out (top-level `logout` server action) and
 * the notification bell moved in here from the page header so the
 * sidebar carries the same identity/utility row shown in the visual
 * reference, without duplicating them above this component too.
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
  projectSwitcher,
}: Props) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("update");
  const [logoAvailable, setLogoAvailable] = useState(true);

  const activeTab = TABS.find((t) => t.key === tab)!;
  const heading = tab === "update" ? "Worker Dashboard" : activeTab.label;

  return (
    // No rounded corners/border/shadow/page padding around this shell —
    // it IS the single application surface, not a card floating over a
    // differently-colored page background. TopNav no longer renders
    // above the Worker screen, so this claims the full viewport height
    // (not calc(100vh-64px), a stale TopNav-height offset that would
    // otherwise leave a dead gap at the bottom).
    <div className="flex flex-col lg:flex-row bg-surface min-h-screen">
      {/* Sidebar nav — same 5 tabs as before, now vertical */}
      <aside className="lg:w-60 shrink-0 bg-gradient-to-b from-brand via-[#173c52] to-info text-white flex flex-col">
        <div className="px-5 py-5 border-b border-white/10 flex items-center gap-2.5">
          {logoAvailable && (
            // eslint-disable-next-line @next/next/no-img-element -- small static brand mark, matches TopNav's own use of the same asset
            <img
              src="/agentic-atoms-logo.png"
              alt="Agentic Atoms"
              className="h-8 w-8 shrink-0 rounded-full object-contain bg-white/10"
              onError={() => setLogoAvailable(false)}
            />
          )}
          <div className="min-w-0">
            <p className="text-sm font-bold tracking-tight truncate">Agentic Atoms</p>
            <p className="text-[11px] text-white/60 truncate">Construction Automation</p>
          </div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-x-auto lg:overflow-visible">
          <div className="flex lg:flex-col gap-1">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-current={tab === key ? "page" : undefined}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors duration-150 ${
                  tab === key
                    ? "bg-info text-white shadow-sm"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div className="px-3 py-4 border-t border-white/10">
          <form action={logout}>
            <button
              type="submit"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/70 transition-colors duration-150 hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.8} />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xl sm:text-2xl font-extrabold text-foreground tracking-tight">{heading}</h2>
            <p className="text-sm text-foreground-secondary">
              {tab === "update"
                ? "Stay updated with your work progress and submit your updates."
                : `${projectName} · ${departmentName}`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {projectSwitcher}
            <span
              suppressHydrationWarning
              className="hidden sm:inline text-xs text-foreground-secondary bg-surface-soft border border-line rounded-full px-3 py-1.5"
            >
              {new Date().toLocaleDateString("en-US", {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </span>
            <NotificationBell userId={workerId} />
          </div>
        </div>

        {tab === "update" && (
          <div className="grid lg:grid-cols-[1.5fr_1fr] gap-5 items-start">
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
                workItemCode={activeWorkItem.code}
                workItemDescription={activeWorkItem.description}
                departmentName={departmentName}
                plannedQuantity={activeWorkItem.plannedQuantity}
                unitOfMeasure={activeWorkItem.unitOfMeasure}
              />
            </div>

            {/* Right rail — same figures as the Dashboard tab's
                WorkerHeroCard (same props, no recomputation), presented
                as a compact ring + status summary alongside Today's
                Update, plus the existing Live Update capture below it. */}
            <div className="space-y-4">
              <Card>
                <p className="text-xs uppercase tracking-wide text-foreground-muted font-medium mb-3">
                  Today&apos;s Progress
                </p>
                <div className="flex flex-col items-center">
                  <ProgressRing
                    percent={progressPercentage}
                    label="Overall Progress"
                    size={110}
                    strokeWidth={10}
                    colorClass={isCompleted ? "text-success" : "text-info"}
                  />
                </div>
                <div className="mt-4 space-y-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground-secondary">Current Work</span>
                    <span className="font-medium text-foreground text-right truncate max-w-[55%]">
                      {activeWorkItem.code}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground-secondary">Approved</span>
                    <span className="font-medium text-success tabular-nums">
                      {approvedQuantity !== null
                        ? `${formatQuantity(approvedQuantity)} ${activeWorkItem.unitOfMeasure ?? ""}`
                        : formatPercent(progressPercentage)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground-secondary">Submitted (pending)</span>
                    <span className="font-medium text-info tabular-nums">
                      {submittedQuantity !== null
                        ? `${formatQuantity(submittedQuantity)} ${activeWorkItem.unitOfMeasure ?? ""}`
                        : "—"}
                    </span>
                  </div>
                  {latestSubmissionStatusLabel && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground-secondary">Latest Status</span>
                      <span
                        className={`font-medium text-right ${
                          latestSubmissionStatusCode === "ROLLED_BACK" ? "text-error" : "text-foreground"
                        }`}
                      >
                        {latestSubmissionStatusLabel}
                      </span>
                    </div>
                  )}
                </div>
              </Card>
              <LiveUpdateBar workItemId={activeWorkItem.id} />
            </div>
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
          <Card className="text-sm space-y-2 text-foreground">
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
              <span className="font-medium tabular-nums">{formatPercent(todaysProgress)}</span>
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
          </Card>
        )}

        {tab === "history" && (
          <Card className="!p-0 overflow-hidden text-sm text-foreground">
            {history.length === 0 ? (
              <EmptyState icon={FileClock} title="No submissions yet" />
            ) : (
              <div className="divide-y divide-line">
                {history.map((item) => (
                  <div key={item.submissionId} className="px-4 py-3 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground-secondary">
                        {item.workItemCode} — {item.workItemDescription}
                      </span>
                      <span className="text-xs text-foreground-secondary shrink-0 tabular-nums">
                        {formatDateUS(item.submittedAt)}
                      </span>
                    </div>
                    <p>
                      <span className="text-foreground-secondary">Submitted:</span>{" "}
                      <span className="font-medium tabular-nums">
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
          </Card>
        )}

        {tab === "approved" && (
          <Card className="!p-0 overflow-hidden text-sm text-foreground">
            {approvedWork.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Nothing approved yet" />
            ) : (
              <div className="divide-y divide-line">
                {approvedWork.map((item) => (
                  <div key={item.unifiedRecordId} className="px-4 py-3 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground-secondary">
                        {item.workItemCode} — {item.workItemDescription}
                      </span>
                      <span className="text-xs text-foreground-secondary shrink-0 tabular-nums">
                        {formatDateUS(item.approvedAt)}
                      </span>
                    </div>
                    <p>
                      <span className="text-foreground-secondary">Approved:</span>{" "}
                      <span className="font-medium tabular-nums">
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
          </Card>
        )}

        {tab === "communication" && <ChatPanel />}
      </div>
    </div>
  );
}
