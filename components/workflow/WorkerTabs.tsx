"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  ListChecks,
  History as HistoryIcon,
  MessageSquare,
  UserRound,
  Search,
  PencilLine,
} from "lucide-react";
import ChatPanel from "@/components/workflow/ChatPanel";
import TabNav from "@/components/workflow/TabNav";
import DashboardShell from "@/components/workflow/DashboardShell";
import WorkerHeroCard from "@/components/workflow/WorkerHeroCard";
import WorkItemSelector, {
  type WorkItemOptionView,
} from "@/components/workflow/WorkItemSelector";
import DailyWorkUpdate from "@/components/workflow/DailyWorkUpdate";
import WorkItemList from "@/components/workflow/WorkItemList";
import SubmissionHistoryTable from "@/components/workflow/SubmissionHistoryTable";
import NotificationFocusBanner from "@/components/workflow/NotificationFocusBanner";
import type { WorkerSubmissionStatusCode } from "@/lib/format";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge, { type BadgeVariant } from "@/components/ui/Badge";
import Input from "@/components/ui/Input";
import EmptyState from "@/components/ui/EmptyState";

export type WorkerHistoryItem = {
  submissionId: string;
  submittedAt: string;
  projectName: string;
  departmentName: string;
  workItemCode: string;
  workItemDescription: string;
  submittedProgress: number;
  submittedQuantity: number | null;
  unit: string | null;
  correctedProgress: number | null;
  approvalComments: string | null;
  approvalStatus: string | null;
  reviewStatusCode: WorkerSubmissionStatusCode;
  reviewStatusLabel: string;
  /** Task recorded on the submission at submit time (optional). */
  taskLabel?: string | null;
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

/** One assigned work item as listed on the Work Items tab — the same
 * WorkItemOptionView the selector uses, plus its cumulative approved
 * progress (WorkItemOption.progressPercentage, already loaded). */
export type WorkerWorkItemView = WorkItemOptionView & {
  progressPercentage: number | null;
};

/** Everything about the work item the page is currently focused on (the
 * auto-suggested one, or the worker's explicit ?workItemId= pick) — null
 * only when the worker has no Active assignment at all. */
export type WorkerCurrentWork = {
  activeWorkItem: {
    id: string;
    code: string;
    description: string;
    plannedQuantity: number | null;
    unitOfMeasure: string | null;
  };
  activeWorkItemId: string;
  isAutoSuggested: boolean;
  suggestionNote: string | null;
  noEligibleWorkNote: string | null;
  /** Sum of as-submitted quantity across every submission of THIS work
   * item (approved or still pending review) — see WorkerHeroCard's own
   * prop doc. Derived in app/workflow/worker/page.tsx from `history`,
   * no separate query. */
  submittedQuantity: number | null;
  /** The Worker-side submission shown on "Submitted / Estimated" for the
   * active work item — the latest one still awaiting review, else the
   * latest of any state — with its review state (from `history`). Never
   * approved progress; null when this work item has no submission yet. */
  latestSubmission: {
    submittedProgress: number;
    correctedProgress: number | null;
    reviewStatusCode: WorkerSubmissionStatusCode;
  } | null;
  approvedQuantity: number | null;
  progressPercentage: number | null;
  isCompleted: boolean;
  todaysProgress: number | null;
  latestSubmissionStatusLabel: string | null;
  latestSubmissionStatusCode: WorkerSubmissionStatusCode | null;
};

type Props = {
  workerId: string;
  /** The signed-in Worker's email (already resolved server-side) —
   * purely for the sidebar Profile control (see ProfileChip). */
  userEmail?: string;
  /** The worker's own users row, display-only (Profile tab). */
  profile: { displayName: string; email: string };
  projectName: string;
  departmentName: string;
  /** Current Project's location (projects.project_location) — display
   * only; null when not set. */
  projectLocation?: string | null;
  current: WorkerCurrentWork | null;
  workItems: WorkerWorkItemView[];
  history: WorkerHistoryItem[];
  approvedWork: WorkerApprovedWorkItem[];
  /** Rendered in the header row — a "switch project" control (see
   * app/workflow/worker/page.tsx), only non-null when this worker
   * actually holds more than one active project assignment. */
  projectSwitcher?: React.ReactNode;
  /** The worker's own assigned projects + the one currently shown —
   * feed the Project filter inside WorkItemSelector. */
  projects?: { projectId: string; projectName: string }[];
  activeProjectId?: string;
  /** Admin on/off switch (per-project) for the Project/Work Item/Task
   * selection UI — see lib/admin.ts Project.taskContextEnabled's doc.
   * When false, WorkItemSelector is not rendered and the Work Items list
   * is view-only except for the current (auto-suggested) work item, so
   * the switch keeps meaning exactly what it did before: the worker
   * updates the assigned/suggested item, no manual work item/task pick. */
  taskContextEnabled: boolean;
};

// Update Progress is its own sidebar entry (always one click away on
// desktop and mobile); My Assigned Work lives inside Dashboard (see
// SECTIONS). Profile is opened from the Profile control above Sign out
// (DashboardShell profileTabKey), not listed in the nav.
const TABS = [
  { key: "update", label: "Update Progress", icon: PencilLine },
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "history", label: "History", icon: HistoryIcon },
  { key: "communication", label: "Communication", icon: MessageSquare },
  { key: "profile", label: "Profile", icon: UserRound },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const HEADINGS: Record<TabKey, string> = {
  update: "Update Progress",
  dashboard: "Worker Dashboard",
  history: "History",
  communication: "Communication",
  profile: "My Profile",
};

/** The Worker Dashboard's two top tabs. */
const SECTIONS = [
  { key: "dashboard", label: "DASHBOARD" },
  { key: "assigned", label: "MY ASSIGNED WORK" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

function workItemStatus(w: WorkItemOptionView): { variant: BadgeVariant; label: string } {
  if (w.isCompleted) return { variant: "success", label: "Completed" };
  if (w.isEligible) return { variant: "brand", label: "Ready" };
  return { variant: "neutral", label: "Waiting on prerequisites" };
}

/**
 * Worker's navigation — the same DashboardShell as every other role
 * (Notifications next to the brand, Profile above Sign out):
 *   - Update Progress (default) — the existing update form
 *     (WorkItemSelector + DailyWorkUpdate, which ends with the optional
 *     photo step).
 *   - Dashboard, with two top tabs (SECTIONS):
 *       DASHBOARD — the current work item's progress (WorkerHeroCard);
 *       MY ASSIGNED WORK — every Active assignment (searchable) in the
 *         shared WorkItemList, each with its View Updates (no amounts
 *         for a Worker).
 *   - History is the shared Submission History — the same screen as
 *     Contractor/Subcontractor History (filters, sortable columns,
 *     status & review, each row's View Updates).
 * Every figure is the exact data app/workflow/worker/page.tsx already
 * fetched — this component only arranges it, no calculation here.
 */
export default function WorkerTabs({
  workerId,
  userEmail,
  profile,
  projectName,
  departmentName,
  projectLocation = null,
  current,
  workItems,
  history,
  projectSwitcher,
  projects,
  activeProjectId,
  taskContextEnabled,
}: Props) {
  const searchParams = useSearchParams();
  // Initial tab from ?tab= when present (e.g. a deep link), otherwise the
  // Dashboard landing view. Kept in client state afterwards, so a work
  // item switch (router.push to a new ?workItemId=) keeps the worker on
  // the tab they were on.
  // Update Progress stays the landing view (as before). "workItems"
  // (e.g. a notification's work item link) is Dashboard's MY ASSIGNED
  // WORK tab.
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    if (requested === "workItems") return "dashboard";
    return TABS.some((t) => t.key === requested) ? (requested as TabKey) : "update";
  });
  const [section, setSection] = useState<SectionKey>(() =>
    searchParams.get("tab") === "workItems" ? "assigned" : "dashboard"
  );
  const [query, setQuery] = useState("");

  // Notification focus — same URL mechanism as the Contractor/
  // Subcontractor Reviews tab (lib/notifications.ts
  // resolveNotificationTarget): ?focus=<submissionId> targets the exact
  // History entry; ?item=<code> is the fallback (the latest History entry
  // for that work item, or its card on Work Items); ?n=<notificationId>
  // drives the banner. NotificationBell navigates with a full page load,
  // so these are read fresh on every notification click.
  const focusSubmissionId = searchParams.get("focus");
  const focusItemCode = searchParams.get("item");
  const notificationId = searchParams.get("n");
  const historyFocusId =
    (focusSubmissionId && history.some((h) => h.submissionId === focusSubmissionId)
      ? focusSubmissionId
      : focusItemCode
        ? history.find((h) => h.workItemCode === focusItemCode)?.submissionId
        : null) ?? null;
  useEffect(() => {
    if (!focusSubmissionId && !focusItemCode) return;
    const timer = setTimeout(() => {
      document.querySelector("[data-focused=true]")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 300);
    return () => clearTimeout(timer);
  }, [focusSubmissionId, focusItemCode]);

  // Task selection belongs to ONE work item: it is stored together with
  // that work item id and only honored while that same work item is the
  // active one, so changing the work item or project (which changes the
  // active work item) resets it with no effect/reset code. With no single
  // work item chosen ("All assigned"), there are no tasks at all.
  const [taskSel, setTaskSel] = useState({ workItemId: "", taskId: "" });

  // Project / Work Item changes re-render the whole page on the server
  // (several seconds), but everything the selectors need is already here.
  // `pending` lets the selector show the new choice immediately; the
  // update form below is dimmed and inert until the server has caught up
  // so a submission can never target the previous work item.
  const router = useRouter();
  const [isNavigating, startTransition] = useTransition();
  const [pendingNav, setPendingNav] = useState<{
    kind: "project" | "workItem";
    workItemId: string;
    projectId?: string;
  } | null>(null);
  const pending = isNavigating ? pendingNav : null;
  function navigate(
    url: string,
    next: { kind: "project" | "workItem"; workItemId: string; projectId?: string }
  ) {
    setPendingNav(next);
    startTransition(() => {
      router.push(url);
    });
  }

  const activeWorkItemId = current?.activeWorkItemId ?? "";
  const activeTasks =
    !current || current.isAutoSuggested
      ? []
      : (workItems.find((w) => w.workItemId === activeWorkItemId)?.tasks ?? []);
  const selectedTask =
    taskSel.workItemId === activeWorkItemId
      ? (activeTasks.find((t) => t.id === taskSel.taskId) ?? null)
      : null;

  const needle = query.trim().toLowerCase();
  const filteredWorkItems = useMemo(
    () =>
      needle
        ? workItems.filter((w) =>
            [w.code, w.description, ...w.tasks.map((t) => t.label)].some((text) =>
              text.toLowerCase().includes(needle)
            )
          )
        : workItems,
    [workItems, needle]
  );

  const heading = HEADINGS[tab];

  return (
    <DashboardShell
      tabs={[...TABS]}
      activeTab={tab}
      onTabChange={(key) => setTab(key as TabKey)}
      heading={heading}
      showGreeting={false}
      subheading={
        <>
          <span className="text-foreground-muted">Current Project:</span>{" "}
          <span className="font-medium text-foreground">{projectName}</span> · {departmentName}
          {projectLocation ? ` · ${projectLocation}` : ""}
        </>
      }
      userId={workerId}
      userEmail={userEmail}
      roleLabel="Worker"
      profileTabKey="profile"
      showNotificationToasts
      actions={projectSwitcher}
    >
        {/* Dashboard tabs — Dashboard / My Assigned Work. */}
        {tab === "dashboard" && (
          <TabNav tabs={[...SECTIONS]} active={section} onChange={(key) => setSection(key as SectionKey)} />
        )}

        {/* ---------------- Dashboard ---------------- */}
        {tab === "dashboard" && section === "dashboard" &&
          (current ? (
            // Current work only — What to do today / My Assigned Work /
            // Latest Submission were duplicates of the UPDATE PROGRESS and
            // MY ASSIGNED WORK tabs and History, so they're not repeated here.
            <div className="space-y-4">
              <WorkerHeroCard
                workItemCode={current.activeWorkItem.code}
                workItemDescription={current.activeWorkItem.description}
                plannedQuantity={current.activeWorkItem.plannedQuantity}
                unitOfMeasure={current.activeWorkItem.unitOfMeasure}
                submittedQuantity={current.submittedQuantity}
                latestSubmission={current.latestSubmission}
                approvedQuantity={current.approvedQuantity}
                progressPercentage={current.progressPercentage}
                isCompleted={current.isCompleted}
              />
              {current.noEligibleWorkNote && (
                <p className="text-sm text-foreground-secondary bg-surface-soft border border-line rounded-lg p-3">
                  {current.noEligibleWorkNote}
                </p>
              )}
            </div>
          ) : (
            <EmptyState
              icon={ListChecks}
              title="No work items assigned yet"
              description={`Nothing is currently assigned to you in ${projectName} — ${departmentName}. Ask your Subcontractor or Contractor to assign a work item. Your past submissions are still in History.`}
              action={
                <Button variant="secondary" size="sm" onClick={() => setTab("history")}>
                  View history
                </Button>
              }
            />
          ))}

        {/* ---------------- My Assigned Work ---------------- */}
        {tab === "dashboard" && section === "assigned" && (
          <div className="space-y-4">
            {notificationId && (
              <NotificationFocusBanner
                notificationId={notificationId}
                recordInQueue={!!focusItemCode && workItems.some((w) => w.code === focusItemCode)}
                missingMessage="This work item is no longer assigned to you — see History for your submissions."
              />
            )}
            {/* Same Filters panel as History, so the two screens read alike. */}
            <div className="rounded-lg border border-line bg-surface p-4 text-sm shadow-sm">
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-foreground-secondary font-medium">Filters</p>
                <span className="text-xs text-foreground-muted tabular-nums">
                  {filteredWorkItems.length === workItems.length
                    ? `${workItems.length} work item${workItems.length === 1 ? "" : "s"}`
                    : `${filteredWorkItems.length} of ${workItems.length} work items`}
                </span>
              </div>
              <div className="relative max-w-md">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground-muted"
                  strokeWidth={2}
                  aria-hidden
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by code, name or task"
                  aria-label="Search work items"
                  className="pl-9 bg-white"
                />
              </div>
            </div>

            {!taskContextEnabled && workItems.length > 1 && (
              <p className="text-xs text-foreground-secondary bg-surface-soft border border-line rounded-lg px-3 py-2">
                Work item selection is turned off for this project, so updates go to your current work
                item. Your other assigned work items are shown here for reference.
              </p>
            )}

            {workItems.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="No work items assigned yet"
                description="Ask your Subcontractor or Contractor to assign a work item."
              />
            ) : filteredWorkItems.length === 0 ? (
              <EmptyState icon={Search} title={`No work items match “${query.trim()}”`} />
            ) : (
              // The shared Work Items list (same as Contractor/Subcontractor
              // Work Items): Work Item · Progress · Status · Actions, with
              // its built-in View Updates (the existing feed, scoped
              // server-side to this worker's own updates). No amounts —
              // earnedAmount is never passed for a Worker.
              <Card className="!p-0 overflow-hidden">
                <WorkItemList
                  rows={filteredWorkItems.map((w) => ({
                    workItemId: w.workItemId,
                    code: w.code,
                    description: w.description,
                    progressPercentage: w.progressPercentage,
                    status: workItemStatus(w),
                    tag: w.workItemId === activeWorkItemId ? "Current" : undefined,
                    detail:
                      w.tasks.length > 0
                        ? `Tasks: ${w.tasks.map((t) => `${t.label}${t.conditional ? " (if applicable)" : ""}`).join(" · ")}`
                        : undefined,
                  }))}
                  focusedWorkItemId={focusItemCode ? (workItems.find((w) => w.code === focusItemCode)?.workItemId ?? null) : null}
                  // Actions: only the list's built-in View Updates. History
                  // is its own sidebar entry, and Update Progress is the
                  // way into the update form.
                />
              </Card>
            )}
          </div>
        )}

        {/* ---------------- Update Progress (default) ---------------- */}
        {tab === "update" && !current && (
          <EmptyState
            icon={ListChecks}
            title="No work items assigned yet"
            description={`Nothing is currently assigned to you in ${projectName} — ${departmentName}. Ask your Subcontractor or Contractor to assign a work item. Your past submissions are still in History.`}
            action={
              <Button variant="secondary" size="sm" onClick={() => setTab("history")}>
                View history
              </Button>
            }
          />
        )}
        {tab === "update" && current && (
          // The update form only — the separate "Today's Progress" panel is
          // not repeated here (the Dashboard tab shows current progress).
          // Full content width, same as the Dashboard tab.
          <div className="space-y-4">
                {taskContextEnabled && (workItems.length > 0 || (projects?.length ?? 0) > 0) && (
                  <WorkItemSelector
                    workItems={workItems}
                    activeWorkItemId={current.activeWorkItemId}
                    isAutoSuggested={current.isAutoSuggested}
                    suggestionNote={current.suggestionNote}
                    projects={projects}
                    activeProjectId={activeProjectId}
                    taskSelection={taskSel}
                    onTaskChange={(workItemId, taskId) => setTaskSel({ workItemId, taskId })}
                    pending={pending}
                    onNavigate={navigate}
                  />
                )}
                {current.noEligibleWorkNote && (
                  <p className="text-sm text-foreground-secondary bg-surface-soft border border-line rounded-lg p-3">
                    {current.noEligibleWorkNote}
                  </p>
                )}
                <div
                  aria-busy={pending !== null}
                  className={pending ? "opacity-50 pointer-events-none select-none" : undefined}
                >
                  <DailyWorkUpdate
                    workerId={workerId}
                    workItemId={current.activeWorkItem.id}
                    workItemCode={current.activeWorkItem.code}
                    workItemDescription={current.activeWorkItem.description}
                    departmentName={departmentName}
                    plannedQuantity={current.activeWorkItem.plannedQuantity}
                    unitOfMeasure={current.activeWorkItem.unitOfMeasure}
                    taskId={selectedTask?.id ?? null}
                    taskLabel={selectedTask?.label ?? null}
                    workItemExplicitlySelected={!current.isAutoSuggested}
                    approvedProgress={current.progressPercentage}
                  />
                </div>
          </div>
        )}

        {/* ---------------- History ---------------- */}
        {tab === "history" && (
          <div className="space-y-4">
            {notificationId && (
              <NotificationFocusBanner
                notificationId={notificationId}
                recordInQueue={historyFocusId !== null}
                missingMessage="This submission isn't in your History list."
              />
            )}
            {/* The shared Submission History — the same screen as
                Contractor/Subcontractor History: filters, submissions,
                status & review, reviewer comments and each row's View
                Updates. */}
            <SubmissionHistoryTable
                items={history.map((h) => ({
                  submissionId: h.submissionId,
                  submittedAt: h.submittedAt,
                  workerName: profile.displayName,
                  departmentName: h.departmentName,
                  workItemCode: h.workItemCode,
                  workItemDescription: h.workItemDescription,
                  submittedProgress: h.submittedProgress,
                  submittedQuantity: h.submittedQuantity,
                  unit: h.unit,
                  reviewStatusLabel: h.reviewStatusLabel,
                  reviewStatusCode: h.reviewStatusCode,
                  correctedProgress: h.correctedProgress,
                  approvalComments: h.approvalComments,
                  taskLabel: h.taskLabel ?? null,
                }))}
                focusSubmissionId={historyFocusId}
              />
          </div>
        )}

        {tab === "communication" && <ChatPanel contextProjectId={activeProjectId} />}

        {/* ---------------- Profile ---------------- */}
        {tab === "profile" && (
          <Card className="max-w-xl space-y-4 text-sm">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand text-white text-base font-semibold">
                {profile.displayName
                  .split(" ")
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((p) => p[0]?.toUpperCase())
                  .join("")}
              </span>
              <div className="min-w-0">
                <p className="text-lg font-semibold text-foreground truncate">{profile.displayName}</p>
                <Badge variant="brand" dot={false}>
                  Worker
                </Badge>
              </div>
            </div>
            <dl className="divide-y divide-line rounded-lg border border-line">
              {(
                [
                  ["Email", profile.email],
                  ["Current Project", projectName],
                  ...(projectLocation ? ([["Location", projectLocation]] as const) : []),
                  ["Department", departmentName],
                  ["Assigned work items", String(workItems.length)],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 px-3 py-2">
                  <dt className="text-foreground-secondary">{label}</dt>
                  <dd className="font-medium text-foreground text-right break-all">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-foreground-muted">
              To change your name, project or department, contact your Admin.
            </p>
          </Card>
        )}
    </DashboardShell>
  );
}
