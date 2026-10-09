"use client";

import { useEffect, useState } from "react";
import ProgressBar from "@/components/workflow/charts/ProgressBar";
import ProgressRing from "@/components/workflow/charts/ProgressRing";
import ProgressValue from "@/components/workflow/charts/ProgressValue";
import WorkItemList, { workItemStatus } from "@/components/workflow/WorkItemList";
import WorkItemTaskManager, { type ManagedTask } from "@/components/workflow/WorkItemTaskManager";
import { DashboardKpiCards, type DashboardKpiValues, type KpiCardActions } from "@/components/workflow/KpiCards";
import { formatDateUS, formatMoney } from "@/lib/format";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Input, { Select } from "@/components/ui/Input";
import ErrorNotice from "@/components/ui/ErrorNotice";
import { errorMessage, readApiJson } from "@/lib/apiClient";
import { Search } from "lucide-react";

type DashboardScopeOption = { projectId: string; projectName: string };
type DashboardDepartmentOption = { departmentId: string; departmentName: string; projectId: string };

type DashboardWorkItemRow = {
  workItemId: string;
  code: string;
  description: string;
  projectName: string;
  departmentId: string;
  departmentName: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  approvedQuantity: number | null;
  progressPercentage: number | null;
  isCompleted: boolean;
  isStuck: boolean;
  lastApprovedAt: string | null;
  estimatedAmount?: number | null;
  /** Present in every /api/workflow/dashboard response (lib/dashboard.ts). */
  tasks?: ManagedTask[];
};

type DashboardDepartmentSummary = {
  departmentId: string;
  departmentName: string;
  projectName: string;
  totalWorkItems: number;
  completedCount: number;
  stuckCount: number;
  pendingCount: number;
  overallProgressPercent: number | null;
  totalEstimatedAmount?: number | null;
  totalApprovedValue?: number | null;
  currentMonthApprovedValue?: number | null;
  previousMonthApprovedValue?: number | null;
};

type DashboardData = {
  scopeProjects: DashboardScopeOption[];
  scopeDepartments: DashboardDepartmentOption[];
  includeFinancials: boolean;
  kpis: {
    totalProjects: number;
    completedProjects: number;
    totalDepartments: number;
    totalWorkItems: number;
    overallProgressPercent: number | null;
    totalEstimatedAmount: number | null;
    totalApprovedValue: number | null;
    remainingValue: number | null;
    currentMonthApprovedValue: number | null;
    previousMonthApprovedValue: number | null;
  };
  departments: DashboardDepartmentSummary[];
  workItems: DashboardWorkItemRow[];
};

type StatusFilter = "ALL" | "COMPLETED" | "IN_PROGRESS" | "STUCK" | "PENDING";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "ALL", label: "All Statuses" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "STUCK", label: "Stuck" },
  { value: "PENDING", label: "Pending" },
];

/**
 * Contractor Dashboard — "show the maximum important information in
 * the shortest possible time" (see project design brief). Deliberately
 * NOT a full BI view of everything lib/dashboard.ts computes: Overall
 * Progress first, then Project Value, then Department Progress, then a
 * simple Work Items list — matching the "overall result -> important
 * breakdown -> details" hierarchy a school report card uses, not a
 * database table. Every number here is read straight from the existing
 * /api/workflow/dashboard response (lib/dashboard.ts) — no calculation
 * is duplicated or changed, only which fields are rendered and how
 * they're formatted (see lib/format.ts formatPercent/formatQuantity,
 * which only fix floating-point display artifacts, never the
 * underlying value).
 */
export type DashboardSection = "overview" | "departments" | "workItems" | "kpis";
const ALL_SECTIONS: DashboardSection[] = ["overview", "departments", "workItems"];

export default function DashboardPanel({
  userId,
  initialData,
  sections = ALL_SECTIONS,
  showLiveUpdatesColumn = false,
  showSearch = false,
  animateProgress = false,
  initialProjectId,
  lockProjectId,
  showScope = true,
  pendingReviews = 0,
  onDepartmentChange,
  onKpisChange,
  kpiActions,
  departmentFilterOnly = false,
  query: queryProp,
  taskManagementDepartmentIds,
  headerAction,
  departmentId: departmentIdProp,
  showFilters = true,
}: {
  userId: string;
  initialData: DashboardData;
  /** Which of this panel's existing sections to render — defaults to
   * all three (unchanged behavior for the standalone aggregate
   * Dashboard at app/workflow/dashboard). The Contractor's own
   * Dashboard/Department Progress/Work Items tabs (see
   * components/workflow/ContractorTabs.tsx) mount this same component
   * once and just narrow `sections` per active tab — same fetch, same
   * filters, same calculations, only which part is visible changes. */
  sections?: DashboardSection[];
  /** When true, adds a "View Updates" action per Work Items row
   * that expands an IMAGE-ONLY LiveUpdateFeed inline, directly under
   * that row — never a navigation to the general Live Updates tab (see
   * LiveUpdateFeed's `mode` prop doc). Omitted entirely (no extra
   * column) for callers — like the standalone /workflow/dashboard page
   * — that have no per-row action for this. */
  showLiveUpdatesColumn?: boolean;
  /** Adds a search box to the Work Items section (code, name or
   * department; case-insensitive, client-side over the rows already
   * loaded). Off by default — the standalone aggregate Dashboard is
   * unchanged. */
  showSearch?: boolean;
  /** Count the Overall Progress ring up 0 → value on load (display only). */
  animateProgress?: boolean;
  /** Pre-select this project in the filters (the caller's current
   * project context) — the user can still change it. */
  initialProjectId?: string;
  /** Pins every fetch to this one project (the page's selected project
   * context) and hides the Project filter — the panel can then never
   * show or request another project's data. Department/status/date
   * filters still work within it. */
  lockProjectId?: string;
  /** Show the "Current Project / Department / Status" line above the
   * filters. The Contractor Dashboard turns it off — its header already
   * names the project. */
  showScope?: boolean;
  /** Pending Review count for the "kpis" section (the caller's own review
   * queue — not part of this panel's dashboard data). */
  pendingReviews?: number;
  /** Reports the Department filter's current value ("" = all in scope)
   * so a sibling (the Contractor's Overall Health summary) can follow
   * the same scope. */
  onDepartmentChange?: (departmentId: string) => void;
  /** Reports the values the KPI row is showing (same filters, same
   * numbers) whenever they change — e.g. for the Contractor's Summary
   * tab to describe them in words. */
  onKpisChange?: (kpis: DashboardKpiValues) => void;
  /** Show only the Department filter (plus Project when not locked) —
   * the Contractor Dashboard view. Status/From/To stay at their
   * defaults (All / no dates) while hidden. Off by default, so the
   * Work Items tab and the standalone Dashboard keep every filter. */
  departmentFilterOnly?: boolean;
  /** Click-through destinations for the "kpis" cards (see KpiCardActions). */
  kpiActions?: KpiCardActions;
  /** Search text owned by the page (the shared header toolbar search) —
   * replaces this panel's own Work Items search box when given. */
  query?: string;
  /** Departments where the caller may configure tasks (own Contractor
   * department, or a WORK_ITEM_MANAGEMENT delegation) — rows there get a
   * Tasks action with the shared WorkItemTaskManager. The server still
   * authorizes every task change itself. */
  taskManagementDepartmentIds?: string[];
  /** Extra control in the Work Items card header (e.g. Excel download). */
  headerAction?: React.ReactNode;
  /** Department chosen by the page (its header Department dropdown) —
   * when given it drives this panel's data exactly like the panel's own
   * Department filter would ("" = all in scope). */
  departmentId?: string;
  /** Render the Filters card (default). Off where the page provides its
   * own controls or none are needed. */
  showFilters?: boolean;
}) {
  const [ownQuery, setQuery] = useState("");
  const query = queryProp ?? ownQuery;
  // Which row's Tasks panel is open (one at a time).
  const [tasksOpenFor, setTasksOpenFor] = useState<string | null>(null);
  const canManageTasks = (departmentId: string) => !!taskManagementDepartmentIds?.includes(departmentId);
  // Default scope = the caller's own data, not "All" (see design
  // brief section 8): when the server has already resolved exactly one
  // project/department for this caller (the common case for a
  // Contractor scoped to their own department), that's what's
  // pre-selected. A caller in scope for several (e.g. a delegated
  // Contractor) still starts on "All" among THEIR OWN authorized set —
  // never a fabricated default beyond what the server already scoped
  // this response to.
  const [projectId, setProjectId] = useState(
    lockProjectId ??
    (initialProjectId && initialData.scopeProjects.some((p) => p.projectId === initialProjectId)
      ? initialProjectId
      : initialData.scopeProjects.length === 1
        ? initialData.scopeProjects[0].projectId
        : "")
  );
  const [ownDepartmentId, setDepartmentId] = useState(
    initialData.scopeDepartments.length === 1 ? initialData.scopeDepartments[0].departmentId : ""
  );
  const departmentId = departmentIdProp ?? ownDepartmentId;
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<DashboardData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllWorkItems, setShowAllWorkItems] = useState(false);
  // Bumped by Retry to re-run the load below after a failure.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ userId });
        if (projectId) params.set("projectId", projectId);
        if (departmentId) params.set("departmentId", departmentId);
        if (status !== "ALL") params.set("status", status);
        if (from) params.set("from", from);
        if (to) params.set("to", to);

        const res = await fetch(`/api/workflow/dashboard?${params.toString()}`);
        const json = await readApiJson<DashboardData>(res, "Couldn't load the latest dashboard data.");
        if (!ignore) setData(json);
      } catch (err) {
        // The previously loaded figures stay on screen under the notice.
        if (!ignore) setError(errorMessage(err, "Couldn't load the latest dashboard data."));
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [userId, projectId, departmentId, status, from, to, attempt]);

  useEffect(() => {
    onDepartmentChange?.(departmentId);
  }, [departmentId, onDepartmentChange]);

  const availableDepartments = data.scopeDepartments.filter(
    (d) => !projectId || d.projectId === projectId
  );

  const completedCount = data.workItems.filter((w) => w.isCompleted).length;
  // Work Left is 100 − Overall Progress (one value for the KPI card and
  // onKpisChange).
  const workLeftPercent = Math.max(0, Math.round((100 - (data.kpis.overallProgressPercent ?? 0)) * 10) / 10);
  const kpiRevenue = data.includeFinancials ? data.kpis.totalApprovedValue : null;
  useEffect(() => {
    onKpisChange?.({
      totalWorkItems: data.kpis.totalWorkItems,
      completedCount,
      pendingReviews,
      overallProgressPercent: data.kpis.overallProgressPercent ?? 0,
      estimatedRevenue: kpiRevenue,
      workLeftPercent,
    });
  }, [onKpisChange, data.kpis.totalWorkItems, completedCount, pendingReviews, data.kpis.overallProgressPercent, kpiRevenue, workLeftPercent]);
  const remainingCount = data.workItems.length - completedCount;
  const stuckCount = data.workItems.filter((w) => w.isStuck).length;

  const needle = query.trim().toLowerCase();
  const matchingWorkItems = needle
    ? data.workItems.filter((w) =>
        [w.code, w.description, w.departmentName].some((t) => t.toLowerCase().includes(needle))
      )
    : data.workItems;
  // A search shows every match; otherwise the existing 8-row cap applies.
  const visibleWorkItems = showAllWorkItems || needle ? matchingWorkItems : matchingWorkItems.slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Level 1 — who/what this dashboard is scoped to, in plain
          words, before any number. */}
      {showScope && (
      <Card className="text-sm flex flex-wrap items-center gap-x-6 gap-y-1">
        <p>
          <span className="text-foreground-secondary">Current Project: </span>
          <span className="font-medium text-foreground">
            {projectId
              ? data.scopeProjects.find((p) => p.projectId === projectId)?.projectName
              : data.scopeProjects.length === 1
                ? data.scopeProjects[0].projectName
                : `${data.scopeProjects.length} projects`}
          </span>
        </p>
        <p>
          <span className="text-foreground-secondary">Department: </span>
          <span className="font-medium text-foreground">
            {departmentId
              ? data.scopeDepartments.find((d) => d.departmentId === departmentId)?.departmentName
              : "All departments in scope"}
          </span>
        </p>
        <p>
          <span className="text-foreground-secondary">Status: </span>
          <span className="font-medium text-foreground">
            {data.kpis.overallProgressPercent !== null && data.kpis.overallProgressPercent >= 100
              ? "Complete"
              : "In Progress"}
          </span>
        </p>
      </Card>
      )}

      {/* Always visible — filtering options must be immediately visible,
          not hidden behind a click-to-expand dropdown. */}
      {showFilters && (
      <div className="rounded-lg border border-line bg-surface p-4 text-sm shadow-sm">
        <p className="text-foreground-secondary font-medium mb-2">Filters</p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {!lockProjectId && (
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Project</label>
            <Select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setDepartmentId("");
              }}
            >
              <option value="">All Projects</option>
              {data.scopeProjects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.projectName}
                </option>
              ))}
            </Select>
          </div>
          )}
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Department</label>
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">All Departments</option>
              {availableDepartments.map((d) => (
                <option key={d.departmentId} value={d.departmentId}>
                  {d.departmentName}
                </option>
              ))}
            </Select>
          </div>
          {!departmentFilterOnly && (
          <>
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Status</label>
            <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            {/* Native date input — its VALUE must stay ISO (yyyy-mm-dd,
                what the HTML control requires internally and what the
                filter/API actually sends); the browser also owns how it
                renders that value inside its own picker chrome, which
                follows OS/browser locale and can't be forced to
                MM-DD-YYYY without replacing the native control (not done
                here — that would risk the date-selection/filtering
                behavior this task explicitly says not to break). The
                small label below is this app's own MM-DD-YYYY text,
                additive only, next to (never replacing) the native
                input. */}
            <label className="block text-xs font-medium text-foreground-secondary mb-1">From</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full rounded-lg border border-line px-2.5 py-2 text-sm transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            {from && <p className="text-[11px] text-foreground-muted mt-0.5">{formatDateUS(from)}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full rounded-lg border border-line px-2.5 py-2 text-sm transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            {to && <p className="text-[11px] text-foreground-muted mt-0.5">{formatDateUS(to)}</p>}
          </div>
          </>
          )}
        </div>
        {((projectId && !lockProjectId) || departmentId || status !== "ALL" || from || to) && (
          <button
            onClick={() => {
              setProjectId(lockProjectId ?? "");
              setDepartmentId("");
              setStatus("ALL");
              setFrom("");
              setTo("");
            }}
            className="mt-2 text-xs text-brand transition-colors duration-150 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>
      )}

      {error && !loading && <ErrorNotice message={error} onRetry={() => setAttempt((n) => n + 1)} />}

      <div className={loading ? "opacity-60 pointer-events-none transition-opacity" : "transition-opacity"}>
        {sections.includes("kpis") && (
          // The same KPI row as the Subcontractor Dashboard (KpiCards),
          // from this panel's own filtered data — so the filters above
          // drive it. Work Left is 100 − Overall Progress, as there.
          <DashboardKpiCards
            totalWorkItems={data.kpis.totalWorkItems}
            completedCount={completedCount}
            pendingReviews={pendingReviews}
            overallProgressPercent={data.kpis.overallProgressPercent ?? 0}
            estimatedRevenue={data.includeFinancials ? data.kpis.totalApprovedValue : null}
            revenueHint="Estimated value of the work in scope at its current approved progress"
            workLeftPercent={workLeftPercent}
            actions={kpiActions}
          />
        )}

        {sections.includes("overview") && (
          <>
            {/* Level 1 — overall result, the one number that matters most. */}
            <Card className="flex flex-col sm:flex-row items-center gap-6">
              <ProgressRing percent={data.kpis.overallProgressPercent} label="Overall Progress" size={112} animate={animateProgress} />
              <div className="flex-1 w-full space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-success-soft rounded-lg py-4 text-center">
                    <p className="text-2xl font-bold text-success tabular-nums">{completedCount}</p>
                    <p className="text-xs text-foreground-secondary">Completed</p>
                  </div>
                  <div className="bg-warning-soft rounded-lg py-4 text-center">
                    <p className="text-2xl font-bold text-warning tabular-nums">{remainingCount}</p>
                    <p className="text-xs text-foreground-secondary">Remaining</p>
                  </div>
                </div>
                {stuckCount > 0 && (
                  <p className="text-xs text-error text-center sm:text-left">
                    {stuckCount} work item{stuckCount === 1 ? "" : "s"} need{stuckCount === 1 ? "s" : ""} attention
                  </p>
                )}
              </div>
            </Card>

            {/* Project Value — three numbers, no chart. */}
            {data.includeFinancials && (
              <Card className="mt-6">
                <h2 className="font-semibold text-foreground text-sm mb-3">Project Value</h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-lg font-bold text-foreground tabular-nums">
                      {data.kpis.totalEstimatedAmount !== null ? formatMoney(data.kpis.totalEstimatedAmount) : "—"}
                    </p>
                    <p className="text-xs text-foreground-secondary">Estimated</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-brand tabular-nums">
                      {data.kpis.totalApprovedValue !== null ? formatMoney(data.kpis.totalApprovedValue) : "—"}
                    </p>
                    <p className="text-xs text-foreground-secondary">Approved</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-warning tabular-nums">
                      {data.kpis.remainingValue !== null ? formatMoney(data.kpis.remainingValue) : "—"}
                    </p>
                    <p className="text-xs text-foreground-secondary">Remaining</p>
                  </div>
                </div>
              </Card>
            )}
          </>
        )}

        {sections.includes("departments") && (
          /* Level 2 — important breakdown: where is progress happening. */
          data.departments.length === 0 ? (
            <p className="text-sm text-foreground-muted mt-6">
              No departments in scope for the current filters.
            </p>
          ) : (
            <Card className="mt-6 space-y-3">
              <h2 className="font-semibold text-foreground text-sm">Department Progress</h2>
              <div className="space-y-3">
                {data.departments.map((d) => (
                  <div key={d.departmentId} className="text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-1.5">
                      <span className="text-foreground-secondary">
                        {d.departmentName}
                        {d.stuckCount > 0 && (
                          <span className="text-xs text-error"> · {d.stuckCount} needs attention</span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {/* Earned value (totalApprovedValue) at this progress,
                            of the department's scheduled value — both already
                            computed by lib/dashboard.ts. */}
                        <ProgressValue
                          percent={d.overallProgressPercent}
                          amount={data.includeFinancials ? d.totalApprovedValue : null}
                        />
                        {data.includeFinancials &&
                          d.totalApprovedValue !== null &&
                          d.totalApprovedValue !== undefined &&
                          d.totalEstimatedAmount !== null &&
                          d.totalEstimatedAmount !== undefined && (
                            <span className="text-xs text-foreground-secondary tabular-nums">
                              of {formatMoney(d.totalEstimatedAmount)}
                            </span>
                          )}
                      </span>
                    </div>
                    {/* One color rule everywhere (lib/progressColor.ts) — a
                        stuck item is flagged in the text above, it no longer
                        overrides the bar color. */}
                    <ProgressBar
                      percent={d.overallProgressPercent}
                      tooltip={`${d.departmentName}: ${d.completedCount} completed, ${d.pendingCount} pending, ${d.stuckCount} stuck (of ${d.totalWorkItems})`}
                    />
                  </div>
                ))}
              </div>
            </Card>
          )
        )}

        {sections.includes("workItems") && (
        /* Level 3/4 — actionable + detail: work items, simple columns
            only. Capped at 8 rows by default (Level 4 detail, not the
            first thing a Contractor should have to scroll through). */
        <Card className="not-first:mt-6 !p-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-line">
            <h2 className="font-semibold text-foreground text-sm">Work Items</h2>
            {headerAction}
            {showSearch && queryProp === undefined && (
              <div className="relative w-full sm:w-72">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground-muted"
                  strokeWidth={2}
                  aria-hidden
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by code or name"
                  aria-label="Search work items"
                  className="pl-9 !py-2"
                />
              </div>
            )}
          </div>
          {data.workItems.length === 0 ? (
            <p className="text-sm text-foreground-muted px-5 py-4">No work items match the current filters.</p>
          ) : matchingWorkItems.length === 0 ? (
            <p className="text-sm text-foreground-muted px-5 py-4">No work items match “{query.trim()}”.</p>
          ) : (
            <>
              {/* Shared Work Items list (same layout as the Subcontractor's
                  Work Item Management) — read-only here: no management
                  actions, just the per-row View Updates button. */}
              <WorkItemList
                showLiveUpdates={showLiveUpdatesColumn}
                rows={visibleWorkItems.map((item) => ({
                  workItemId: item.workItemId,
                  code: item.code,
                  description: item.description,
                  departmentName: data.scopeDepartments.length > 1 && !departmentId ? item.departmentName : null,
                  progressPercentage: item.progressPercentage,
                  // Earned value at this progress (lib/dashboard.ts estimatedAmount).
                  earnedAmount: data.includeFinancials ? item.estimatedAmount : null,
                  status: workItemStatus(item),
                }))}
                renderActions={
                  taskManagementDepartmentIds
                    ? (row) => {
                        const item = data.workItems.find((w) => w.workItemId === row.workItemId);
                        if (!item || !canManageTasks(item.departmentId)) return null;
                        const open = tasksOpenFor === row.workItemId;
                        return (
                          <Button
                            variant={open ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setTasksOpenFor(open ? null : row.workItemId)}
                            aria-expanded={open}
                          >
                            Tasks ({(item.tasks ?? []).filter((t) => t.status === "Active").length})
                          </Button>
                        );
                      }
                    : undefined
                }
                renderDetail={(row) => {
                  if (tasksOpenFor !== row.workItemId) return null;
                  const item = data.workItems.find((w) => w.workItemId === row.workItemId);
                  if (!item || !canManageTasks(item.departmentId)) return null;
                  return (
                    <div className="border-t border-line-soft bg-surface-soft px-4 py-3">
                      <WorkItemTaskManager
                        workItemId={item.workItemId}
                        tasks={item.tasks ?? []}
                        workItemLabel={`${item.code} — ${item.description}`}
                        defaultExpanded
                        onChanged={() => setAttempt((n) => n + 1)}
                      />
                    </div>
                  );
                }}
              />
              {!needle && data.workItems.length > 8 && (
                <button
                  onClick={() => setShowAllWorkItems((v) => !v)}
                  className="block px-5 py-3 text-xs text-brand transition-colors duration-150 hover:underline"
                >
                  {showAllWorkItems ? "Show fewer" : `Show all ${data.workItems.length} work items`}
                </button>
              )}
            </>
          )}
        </Card>
        )}
      </div>
    </div>
  );
}
