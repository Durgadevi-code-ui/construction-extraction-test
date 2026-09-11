"use client";

import { useEffect, useState } from "react";
import ProgressBar from "@/components/workflow/charts/ProgressBar";
import ProgressRing from "@/components/workflow/charts/ProgressRing";
import { formatDateUS, formatPercent } from "@/lib/format";

type DashboardScopeOption = { projectId: string; projectName: string };
type DashboardDepartmentOption = { departmentId: string; departmentName: string; projectId: string };

type DashboardWorkItemRow = {
  workItemId: string;
  code: string;
  description: string;
  projectName: string;
  departmentName: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  approvedQuantity: number | null;
  progressPercentage: number | null;
  isCompleted: boolean;
  isStuck: boolean;
  lastApprovedAt: string | null;
  estimatedAmount?: number | null;
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

function money(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function statusBadge(item: DashboardWorkItemRow) {
  if (item.isCompleted) return { label: "Completed", cls: "bg-green-100 text-green-700" };
  if (item.isStuck) return { label: "Stuck", cls: "bg-red-100 text-red-700" };
  if (item.progressPercentage === null) return { label: "Pending", cls: "bg-gray-100 text-foreground-secondary" };
  return { label: "In Progress", cls: "bg-amber-100 text-amber-700" };
}

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
export type DashboardSection = "overview" | "departments" | "workItems";
const ALL_SECTIONS: DashboardSection[] = ["overview", "departments", "workItems"];

export default function DashboardPanel({
  userId,
  initialData,
  sections = ALL_SECTIONS,
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
}) {
  // Default scope = the caller's own data, not "All" (see design
  // brief section 8): when the server has already resolved exactly one
  // project/department for this caller (the common case for a
  // Contractor scoped to their own department), that's what's
  // pre-selected. A caller in scope for several (e.g. a delegated
  // Contractor) still starts on "All" among THEIR OWN authorized set —
  // never a fabricated default beyond what the server already scoped
  // this response to.
  const [projectId, setProjectId] = useState(
    initialData.scopeProjects.length === 1 ? initialData.scopeProjects[0].projectId : ""
  );
  const [departmentId, setDepartmentId] = useState(
    initialData.scopeDepartments.length === 1 ? initialData.scopeDepartments[0].departmentId : ""
  );
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<DashboardData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllWorkItems, setShowAllWorkItems] = useState(false);

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
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to load dashboard.");
        if (!ignore) setData(json);
      } catch (err) {
        if (!ignore) setError(err instanceof Error ? err.message : "Failed to load dashboard.");
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [userId, projectId, departmentId, status, from, to]);

  const availableDepartments = data.scopeDepartments.filter(
    (d) => !projectId || d.projectId === projectId
  );

  const completedCount = data.workItems.filter((w) => w.isCompleted).length;
  const remainingCount = data.workItems.length - completedCount;
  const stuckCount = data.workItems.filter((w) => w.isStuck).length;

  const visibleWorkItems = showAllWorkItems ? data.workItems : data.workItems.slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Level 1 — who/what this dashboard is scoped to, in plain
          words, before any number. */}
      <section className="bg-white rounded-lg border border-line p-4 text-sm flex flex-wrap items-center gap-x-6 gap-y-1">
        <p>
          <span className="text-foreground-secondary">Project: </span>
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
      </section>

      {/* Simple filters — collapsed by default expectation is already
          met by the auto-selected scope above; these just let the user
          narrow further when they need to. */}
      <details className="bg-white rounded-lg border border-line p-4 text-sm">
        <summary className="cursor-pointer text-foreground-secondary select-none">Filters</summary>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-3">
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Project</label>
            <select
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setDepartmentId("");
              }}
              className="w-full rounded border border-line px-2 py-1.5 text-sm"
            >
              <option value="">All Projects</option>
              {data.scopeProjects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.projectName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Department</label>
            <select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="w-full rounded border border-line px-2 py-1.5 text-sm"
            >
              <option value="">All Departments</option>
              {availableDepartments.map((d) => (
                <option key={d.departmentId} value={d.departmentId}>
                  {d.departmentName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="w-full rounded border border-line px-2 py-1.5 text-sm"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
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
              className="w-full rounded border border-line px-2 py-1.5 text-sm"
            />
            {from && <p className="text-[11px] text-foreground-muted mt-0.5">{formatDateUS(from)}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full rounded border border-line px-2 py-1.5 text-sm"
            />
            {to && <p className="text-[11px] text-foreground-muted mt-0.5">{formatDateUS(to)}</p>}
          </div>
        </div>
        {(projectId || departmentId || status !== "ALL" || from || to) && (
          <button
            onClick={() => {
              setProjectId("");
              setDepartmentId("");
              setStatus("ALL");
              setFrom("");
              setTo("");
            }}
            className="mt-2 text-xs text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </details>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className={loading ? "opacity-60 pointer-events-none transition-opacity" : "transition-opacity"}>
        {sections.includes("overview") && (
          <>
            {/* Level 1 — overall result, the one number that matters most. */}
            <section className="bg-white rounded-lg border border-line p-5 flex flex-col sm:flex-row items-center gap-6">
              <ProgressRing percent={data.kpis.overallProgressPercent} label="Overall Progress" size={112} />
              <div className="flex-1 w-full space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-green-50 rounded-lg py-4 text-center">
                    <p className="text-2xl font-bold text-green-700">{completedCount}</p>
                    <p className="text-xs text-foreground-secondary">Completed</p>
                  </div>
                  <div className="bg-amber-50 rounded-lg py-4 text-center">
                    <p className="text-2xl font-bold text-amber-700">{remainingCount}</p>
                    <p className="text-xs text-foreground-secondary">Remaining</p>
                  </div>
                </div>
                {stuckCount > 0 && (
                  <p className="text-xs text-red-600 text-center sm:text-left">
                    {stuckCount} work item{stuckCount === 1 ? "" : "s"} need{stuckCount === 1 ? "s" : ""} attention
                  </p>
                )}
              </div>
            </section>

            {/* Project Value — three numbers, no chart. */}
            {data.includeFinancials && (
              <section className="bg-white rounded-lg border border-line p-4 mt-6">
                <h2 className="font-semibold text-foreground text-sm mb-3">Project Value</h2>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-lg font-bold text-foreground">
                      {data.kpis.totalEstimatedAmount !== null ? money(data.kpis.totalEstimatedAmount) : "—"}
                    </p>
                    <p className="text-xs text-foreground-secondary">Estimated</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-orange-700">
                      {data.kpis.totalApprovedValue !== null ? money(data.kpis.totalApprovedValue) : "—"}
                    </p>
                    <p className="text-xs text-foreground-secondary">Approved</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-amber-700">
                      {data.kpis.remainingValue !== null ? money(data.kpis.remainingValue) : "—"}
                    </p>
                    <p className="text-xs text-foreground-secondary">Remaining</p>
                  </div>
                </div>
              </section>
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
            <section className="bg-white rounded-lg border border-line p-4 mt-6 space-y-3">
              <h2 className="font-semibold text-foreground text-sm">Department Progress</h2>
              <div className="space-y-2">
                {data.departments.map((d) => (
                  <div key={d.departmentId} className="text-sm">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-foreground-secondary">{d.departmentName}</span>
                      <span className="text-xs text-foreground-secondary">
                        {formatPercent(d.overallProgressPercent)}
                        {d.stuckCount > 0 ? ` · ${d.stuckCount} needs attention` : ""}
                      </span>
                    </div>
                    <ProgressBar
                      percent={d.overallProgressPercent}
                      tooltip={`${d.departmentName}: ${d.completedCount} completed, ${d.pendingCount} pending, ${d.stuckCount} stuck (of ${d.totalWorkItems})`}
                      colorClass={d.stuckCount > 0 ? "bg-amber-500" : "bg-brand"}
                    />
                  </div>
                ))}
              </div>
            </section>
          )
        )}

        {sections.includes("workItems") && (
        /* Level 3/4 — actionable + detail: work items, simple columns
            only. Capped at 8 rows by default (Level 4 detail, not the
            first thing a Contractor should have to scroll through). */
        <section className="bg-white rounded-lg border border-line p-4 mt-6">
          <h2 className="font-semibold text-foreground text-sm mb-3">Work Items</h2>
          {data.workItems.length === 0 ? (
            <p className="text-sm text-foreground-muted">No work items match the current filters.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-foreground-secondary border-b border-line">
                      <th className="py-1.5 pr-2 font-medium">Work Item</th>
                      <th className="py-1.5 pr-2 font-medium">Progress</th>
                      <th className="py-1.5 pr-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleWorkItems.map((item) => {
                      const badge = statusBadge(item);
                      return (
                        <tr key={item.workItemId} className="border-b border-gray-50 last:border-0">
                          <td className="py-2 pr-2">
                            <span className="text-foreground-secondary">{item.code}</span> {item.description}
                            {data.scopeDepartments.length > 1 && !departmentId && (
                              <span className="text-foreground-muted text-xs"> · {item.departmentName}</span>
                            )}
                          </td>
                          <td className="py-2 pr-2 w-40">
                            <div className="flex items-center gap-2">
                              <div className="w-24">
                                <ProgressBar percent={item.progressPercentage} />
                              </div>
                              <span className="text-xs text-foreground-secondary whitespace-nowrap">
                                {formatPercent(item.progressPercentage)}
                              </span>
                            </div>
                          </td>
                          <td className="py-2 pr-2">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>
                              {badge.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {data.workItems.length > 8 && (
                <button
                  onClick={() => setShowAllWorkItems((v) => !v)}
                  className="mt-2 text-xs text-brand hover:underline"
                >
                  {showAllWorkItems ? "Show fewer" : `Show all ${data.workItems.length} work items`}
                </button>
              )}
            </>
          )}
        </section>
        )}
      </div>
    </div>
  );
}
