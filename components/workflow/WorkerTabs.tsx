"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  LayoutDashboard,
  ListChecks,
  History as HistoryIcon,
  CheckCircle2,
  FileClock,
  LogOut,
  MessageSquare,
  CalendarDays,
  UserRound,
  Search,
  ArrowLeft,
  ClipboardList,
} from "lucide-react";
import ChatPanel from "@/components/workflow/ChatPanel";
import ProfileChip from "@/components/workflow/ProfileChip";
import WorkerHeroCard from "@/components/workflow/WorkerHeroCard";
import WorkItemSelector, {
  type WorkItemOptionView,
} from "@/components/workflow/WorkItemSelector";
import DailyWorkUpdate from "@/components/workflow/DailyWorkUpdate";
import StatusFlow from "@/components/workflow/StatusFlow";
import ProgressRing from "@/components/workflow/charts/ProgressRing";
import NotificationBell from "@/components/workflow/NotificationBell";
import NotificationFocusBanner from "@/components/workflow/NotificationFocusBanner";
import { formatDateUS, formatPercent, formatQuantity, humanizeApprovalStatus } from "@/lib/format";
import type { WorkerSubmissionStatusCode } from "@/lib/format";
import { progressColorClass } from "@/lib/progressColor";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Badge, { type BadgeVariant } from "@/components/ui/Badge";
import Input from "@/components/ui/Input";
import EmptyState from "@/components/ui/EmptyState";
import { logout } from "@/app/login/actions";

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
   * purely for the header's profile chip (see ProfileChip). */
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

const TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "workItems", label: "Work Items", icon: ListChecks },
  { key: "history", label: "History", icon: HistoryIcon },
  { key: "communication", label: "Communication", icon: MessageSquare },
  { key: "profile", label: "Profile", icon: UserRound },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const HEADINGS: Record<TabKey, string> = {
  dashboard: "Worker Dashboard",
  workItems: "My Work Items",
  history: "History",
  communication: "Communication",
  profile: "My Profile",
};

const REVIEW_STATUS_BADGE: Record<WorkerSubmissionStatusCode, { variant: BadgeVariant; label: string }> = {
  AWAITING_FOREMAN_REVIEW: { variant: "info", label: "Awaiting Subcontractor review" },
  AWAITING_SUPERVISOR_APPROVAL: { variant: "warning", label: "Awaiting Contractor approval" },
  APPROVED: { variant: "success", label: "Approved" },
  ROLLED_BACK: { variant: "error", label: "Returned for correction" },
};

function workItemStatus(w: WorkItemOptionView): { variant: BadgeVariant; label: string } {
  if (w.isCompleted) return { variant: "success", label: "Completed" };
  if (w.isEligible) return { variant: "brand", label: "Ready" };
  return { variant: "neutral", label: "Waiting on prerequisites" };
}

function ProgressBar({ percent }: { percent: number | null }) {
  const pct = percent ?? 0;
  return (
    <div className="h-2 w-full rounded-full bg-line-soft overflow-hidden" aria-hidden>
      <div
        className={`h-full rounded-full ${progressColorClass(pct, "bg")}`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

/**
 * Worker's persistent navigation (left sidebar, same visual shell as
 * before): Dashboard / Work Items / History / Communication / Profile,
 * with Sign out once at the bottom of the sidebar.
 *   - Dashboard is the landing view: current project, what's assigned,
 *     what to work on now, latest submission status, one button into
 *     the update form.
 *   - Work Items lists every Active assignment (searchable); "Update
 *     progress" opens the existing update form (WorkItemSelector +
 *     DailyWorkUpdate, which ends with the optional photo step, +
 *     progress panel) in the same tab —
 *     the former separate "Work Update" and "Work Details" tabs.
 *   - History is the worker's own submissions plus the former separate
 *     "Approved Work" list.
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
  approvedWork,
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
  const [tab, setTab] = useState<TabKey>(() => {
    const requested = searchParams.get("tab");
    if (requested === "update") return "workItems";
    return TABS.some((t) => t.key === requested) ? (requested as TabKey) : "dashboard";
  });
  const [workItemsView, setWorkItemsView] = useState<"list" | "update">(
    searchParams.get("tab") === "update" ? "update" : "list"
  );
  const [query, setQuery] = useState("");
  const [historyView, setHistoryView] = useState<"submissions" | "approved">("submissions");
  const [historyStatus, setHistoryStatus] = useState<"ALL" | "IN_REVIEW" | "APPROVED" | "ROLLED_BACK">("ALL");
  const [logoAvailable, setLogoAvailable] = useState(true);

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

  /** Opens the update form. For a different work item than the current
   * one, switches to it via the same URL-driven selection WorkItemSelector
   * uses (identity/assignment re-checked server-side) — only offered when
   * the project's selection switch is on (see taskContextEnabled). The
   * current item opens as-is, keeping its auto-suggested/explicit state. */
  function openUpdate(workItemId: string) {
    setTab("workItems");
    setWorkItemsView("update");
    if (taskContextEnabled && workItemId !== activeWorkItemId) {
      const qs = new URLSearchParams();
      if (activeProjectId) qs.set("projectId", activeProjectId);
      qs.set("workItemId", workItemId);
      navigate(`/workflow/worker?${qs.toString()}`, { kind: "workItem", workItemId, projectId: activeProjectId });
    }
  }

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

  const filteredHistory = history.filter((item) => {
    if (historyStatus === "ALL") return true;
    if (historyStatus === "IN_REVIEW")
      return item.reviewStatusCode === "AWAITING_FOREMAN_REVIEW" || item.reviewStatusCode === "AWAITING_SUPERVISOR_APPROVAL";
    return item.reviewStatusCode === historyStatus;
  });

  const completedCount = workItems.filter((w) => w.isCompleted).length;
  const readyCount = workItems.filter((w) => !w.isCompleted && w.isEligible).length;
  const waitingCount = workItems.length - completedCount - readyCount;

  const heading = tab === "workItems" && workItemsView === "update" ? "Work Update" : HEADINGS[tab];

  return (
    // No rounded corners/border/shadow/page padding around this shell —
    // it's the light page canvas (bg-background) that every white Card
    // sits on top of, not a card itself.
    <div className="flex flex-col lg:flex-row bg-background min-h-screen">
      <aside className="lg:w-60 shrink-0 bg-gradient-to-b from-navy-deep via-navy to-brand text-white flex flex-col">
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
                onClick={() => {
                  setTab(key);
                  if (key === "workItems") setWorkItemsView("list");
                }}
                aria-current={tab === key ? "page" : undefined}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors duration-150 ${
                  tab === key
                    ? "bg-brand text-white shadow-sm"
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

      <div className="flex-1 min-w-0 p-4 sm:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-xl sm:text-2xl font-extrabold text-foreground tracking-tight">{heading}</h2>
            <p className="text-sm text-foreground-secondary">
              <span className="text-foreground-muted">Current Project:</span>{" "}
              <span className="font-medium text-foreground">{projectName}</span> · {departmentName}
              {projectLocation ? ` · ${projectLocation}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 min-w-0 max-w-full">
            {projectSwitcher}
            <span
              suppressHydrationWarning
              className="hidden sm:inline-flex items-center gap-1.5 text-xs text-foreground-secondary bg-surface-soft border border-line rounded-full px-3 py-1.5"
            >
              <CalendarDays className="h-3.5 w-3.5" strokeWidth={2} />
              {new Date().toLocaleDateString("en-US", {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </span>
            <NotificationBell userId={workerId} showToasts />
            {userEmail && <ProfileChip email={userEmail} roleLabel="Worker" />}
          </div>
        </div>

        {/* ---------------- Dashboard (landing) ---------------- */}
        {tab === "dashboard" &&
          (current ? (
            <div className="grid lg:grid-cols-[1.5fr_1fr] gap-5 items-start">
              <div className="space-y-4">
                <WorkerHeroCard
                  workItemCode={current.activeWorkItem.code}
                  workItemDescription={current.activeWorkItem.description}
                  plannedQuantity={current.activeWorkItem.plannedQuantity}
                  unitOfMeasure={current.activeWorkItem.unitOfMeasure}
                  submittedQuantity={current.submittedQuantity}
                  approvedQuantity={current.approvedQuantity}
                  progressPercentage={current.progressPercentage}
                  isCompleted={current.isCompleted}
                />
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 text-sm">
                    <p className="font-semibold text-foreground">What to do today</p>
                    <p className="text-foreground-secondary">
                      {current.isCompleted
                        ? "This work item is complete — pick another assigned work item to update."
                        : `Submit today's progress for ${current.activeWorkItem.code} — ${current.activeWorkItem.description}.`}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button onClick={() => openUpdate(current.activeWorkItemId)}>
                      <ClipboardList className="h-4 w-4" strokeWidth={2} />
                      Update progress
                    </Button>
                  </div>
                </Card>
                {current.noEligibleWorkNote && (
                  <p className="text-sm text-foreground-secondary bg-surface-soft border border-line rounded-lg p-3">
                    {current.noEligibleWorkNote}
                  </p>
                )}
              </div>

              <div className="space-y-4">
                <Card className="space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-foreground">My Assigned Work</p>
                    <button
                      type="button"
                      onClick={() => {
                        setTab("workItems");
                        setWorkItemsView("list");
                      }}
                      className="text-xs font-medium text-brand hover:underline"
                    >
                      View all
                    </button>
                  </div>
                  <p className="text-2xl font-bold text-foreground tabular-nums leading-none">
                    {workItems.length}{" "}
                    <span className="text-sm font-medium text-foreground-secondary">
                      work item{workItems.length === 1 ? "" : "s"}
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {completedCount > 0 && <Badge variant="success">{completedCount} completed</Badge>}
                    {readyCount > 0 && <Badge variant="brand">{readyCount} ready</Badge>}
                    {waitingCount > 0 && <Badge variant="neutral">{waitingCount} waiting</Badge>}
                  </div>
                </Card>

                <Card className="space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-foreground">Latest Submission</p>
                    <button
                      type="button"
                      onClick={() => setTab("history")}
                      className="text-xs font-medium text-brand hover:underline"
                    >
                      View history
                    </button>
                  </div>
                  {current.latestSubmissionStatusCode ? (
                    <>
                      <Badge variant={REVIEW_STATUS_BADGE[current.latestSubmissionStatusCode].variant}>
                        {REVIEW_STATUS_BADGE[current.latestSubmissionStatusCode].label}
                      </Badge>
                      <div className="pt-1">
                        <StatusFlow statusCode={current.latestSubmissionStatusCode} />
                      </div>
                    </>
                  ) : (
                    <p className="text-foreground-muted">You haven&apos;t submitted any updates yet.</p>
                  )}
                  <p className="text-xs text-foreground-secondary pt-1">
                    Approved today for {current.activeWorkItem.code}:{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {formatPercent(current.todaysProgress)}
                    </span>
                  </p>
                </Card>
              </div>
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

        {/* ---------------- Work Items: list ---------------- */}
        {tab === "workItems" && workItemsView === "list" && (
          <div className="space-y-4">
            {notificationId && (
              <NotificationFocusBanner
                notificationId={notificationId}
                recordInQueue={!!focusItemCode && workItems.some((w) => w.code === focusItemCode)}
                missingMessage="This work item is no longer assigned to you — see History for your submissions."
              />
            )}
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
              <div className="grid gap-3 md:grid-cols-2">
                {filteredWorkItems.map((w) => {
                  const status = workItemStatus(w);
                  const isCurrent = w.workItemId === activeWorkItemId;
                  const canUpdate = taskContextEnabled || isCurrent;
                  const isFocused = !!focusItemCode && w.code === focusItemCode;
                  return (
                    <div
                      key={w.workItemId}
                      data-focused={isFocused ? "true" : undefined}
                      className={`scroll-mt-4 rounded-lg ${
                        isFocused ? "ring-2 ring-warning-border ring-offset-2 ring-offset-background" : ""
                      }`}
                    >
                    <Card className={`space-y-3 text-sm ${isCurrent ? "border-brand-border" : ""}`}>
                      {isFocused && <Badge variant="warning">From your notification</Badge>}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs text-foreground-muted">{w.code}</p>
                          <p className="font-semibold text-foreground leading-snug">{w.description}</p>
                          <p className="text-xs text-foreground-secondary">
                            {projectName} · {departmentName}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge variant={status.variant}>{status.label}</Badge>
                          {isCurrent && <span className="text-[11px] text-brand font-medium">Current</span>}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <ProgressBar percent={w.progressPercentage} />
                        <p className="text-xs text-foreground-secondary tabular-nums">
                          {formatPercent(w.progressPercentage ?? 0)} approved
                        </p>
                      </div>
                      {w.tasks.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {w.tasks.map((t) => (
                            <span
                              key={t.id}
                              className="rounded-full border border-line bg-surface-soft px-2 py-0.5 text-[11px] text-foreground-secondary"
                            >
                              {t.label}
                              {t.conditional ? " (if applicable)" : ""}
                            </span>
                          ))}
                        </div>
                      )}
                      {canUpdate && (
                        <div className="flex justify-end">
                          <Button size="sm" variant={isCurrent ? "primary" : "secondary"} onClick={() => openUpdate(w.workItemId)}>
                            Update progress
                          </Button>
                        </div>
                      )}
                    </Card>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ---------------- Work Items: update form ---------------- */}
        {tab === "workItems" && workItemsView === "update" && current && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setWorkItemsView("list")}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={2} />
              All work items
            </button>
            <div className="grid lg:grid-cols-[1.5fr_1fr] gap-5 items-start">
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
                  />
                </div>
              </div>

              {/* Right rail — same figures as the Dashboard's
                  WorkerHeroCard (same props, no recomputation). Photo
                  capture is now step 2 of the update itself (see
                  DailyWorkUpdate / LiveUpdateBar), not a separate card. */}
              <div className="space-y-4">
                <Card>
                  <p className="text-xs uppercase tracking-wide text-foreground-muted font-medium mb-3">
                    Today&apos;s Progress
                  </p>
                  <div className="flex flex-col items-center">
                    <ProgressRing
                      percent={current.progressPercentage}
                      label="Overall Progress"
                      size={110}
                      strokeWidth={10}
                    />
                  </div>
                  <div className="mt-4 space-y-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground-secondary">Current Work</span>
                      <span className="font-medium text-foreground text-right truncate max-w-[55%]">
                        {current.activeWorkItem.code}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground-secondary">Approved</span>
                      <span className="font-medium text-success tabular-nums">
                        {current.approvedQuantity !== null
                          ? `${formatQuantity(current.approvedQuantity)} ${current.activeWorkItem.unitOfMeasure ?? ""}`
                          : formatPercent(current.progressPercentage)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground-secondary">Submitted (pending)</span>
                      <span className="font-medium text-info tabular-nums">
                        {current.submittedQuantity !== null
                          ? `${formatQuantity(current.submittedQuantity)} ${current.activeWorkItem.unitOfMeasure ?? ""}`
                          : "—"}
                      </span>
                    </div>
                    {current.latestSubmissionStatusLabel && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-foreground-secondary">Latest Status</span>
                        <span
                          className={`font-medium text-right ${
                            current.latestSubmissionStatusCode === "ROLLED_BACK" ? "text-error" : "text-foreground"
                          }`}
                        >
                          {current.latestSubmissionStatusLabel}
                        </span>
                      </div>
                    )}
                  </div>
                </Card>
              </div>
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
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  ["submissions", `My Submissions (${history.length})`],
                  ["approved", `Approved Work (${approvedWork.length})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setHistoryView(key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors duration-150 ${
                    historyView === key
                      ? "bg-brand text-white"
                      : "bg-surface-soft text-foreground-secondary border border-line hover:bg-surface-hover"
                  }`}
                >
                  {label}
                </button>
              ))}
              {historyView === "submissions" && (
                <select
                  value={historyStatus}
                  onChange={(e) => setHistoryStatus(e.target.value as typeof historyStatus)}
                  aria-label="Filter by status"
                  className="ml-auto rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                >
                  <option value="ALL">All statuses</option>
                  <option value="IN_REVIEW">In review</option>
                  <option value="APPROVED">Approved</option>
                  <option value="ROLLED_BACK">Returned for correction</option>
                </select>
              )}
            </div>

            {historyView === "submissions" && (
              <Card className="!p-0 overflow-hidden text-sm text-foreground">
                {filteredHistory.length === 0 ? (
                  <EmptyState icon={FileClock} title={history.length === 0 ? "No submissions yet" : "No submissions with this status"} />
                ) : (
                  <div className="divide-y divide-line">
                    {filteredHistory.map((item) => {
                      const badge = REVIEW_STATUS_BADGE[item.reviewStatusCode];
                      const adjusted =
                        item.correctedProgress !== null && item.correctedProgress !== item.submittedProgress;
                      return (
                        <div
                          key={item.submissionId}
                          data-focused={item.submissionId === historyFocusId ? "true" : undefined}
                          className={`scroll-mt-4 px-4 py-3 space-y-1.5 ${
                            item.submissionId === historyFocusId ? "ring-2 ring-inset ring-warning-border bg-warning-soft/40" : ""
                          }`}
                        >
                          {item.submissionId === historyFocusId && (
                            <Badge variant="warning">From your notification</Badge>
                          )}
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="font-medium text-foreground">
                                <span className="text-foreground-secondary">{item.workItemCode}</span> —{" "}
                                {item.workItemDescription}
                              </p>
                              <p className="text-xs text-foreground-muted">
                                Submitted {formatDateUS(item.submittedAt)} · {item.projectName} · {item.departmentName}
                              </p>
                              {item.taskLabel && (
                                <p className="text-xs text-foreground-secondary">Task: {item.taskLabel}</p>
                              )}
                            </div>
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                          </div>
                          <p>
                            <span className="text-foreground-secondary">You submitted:</span>{" "}
                            <span className="font-medium tabular-nums">
                              {item.submittedQuantity !== null
                                ? `${formatQuantity(item.submittedQuantity)} ${item.unit ?? ""}`.trim()
                                : formatPercent(item.submittedProgress)}
                            </span>
                          </p>
                          {adjusted && (
                            <p>
                              <span className="text-foreground-secondary">Adjusted by reviewer to:</span>{" "}
                              <span className="font-medium tabular-nums">{formatPercent(item.correctedProgress)}</span>
                            </p>
                          )}
                          {item.approvalComments && (
                            <p className="text-xs text-foreground-secondary">
                              <span className="font-medium">Reviewer comment:</span> {item.approvalComments}
                            </p>
                          )}
                          <div className="pt-0.5">
                            <StatusFlow statusCode={item.reviewStatusCode} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            )}

            {historyView === "approved" && (
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
                              ? `${formatQuantity(item.approvedQuantity)} ${item.unit ?? ""}`.trim()
                              : formatPercent(item.progressPercentage)}
                          </span>
                        </p>
                        <p className="text-xs text-foreground-secondary">
                          {humanizeApprovalStatus("APPROVED")} by Contractor
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </div>
        )}

        {tab === "communication" && <ChatPanel />}

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
      </div>
    </div>
  );
}
