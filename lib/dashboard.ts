import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserContext, isAdminUser, CONTRACTOR_ROLES } from "./authContext";
import { getActiveDelegationsForUser } from "./delegation";
import { listDepartments, listProjects, listWorkItems } from "./admin";
import { getWorkItemCurrentStatus } from "./workflow";
import { calculateEstimatedAmount, calculateOverallProgress } from "./calculations";

/**
 * Cross-department, cross-project aggregate Dashboard — the one view in
 * this app that spans more than a single department (every other
 * dashboard — Worker/Foreman/Supervisor — is scoped to exactly one
 * department by ctx.departmentId; see lib/workflow.ts). Reuses
 * getWorkItemCurrentStatus (the same cumulative-approved-quantity math
 * every other progress figure in this app is built on) so this can
 * never disagree with a department's own dashboard about a work item's
 * progress — "approved progress is the only progress used in reports"
 * holds here too, nothing here reads original_data/corrected_data.
 *
 * Authorization mirrors the rest of the app (no login — see
 * lib/supabase.ts): ADMIN sees every project/department; a Contractor/
 * Subcontractor sees their own department plus any department covered
 * by an active delegation (same expansion app/workflow/supervisor/page.tsx
 * already does for its own delegated panel); a Worker is not authorized
 * for this aggregate view at all (they have their own, narrower
 * dashboard — see getWorkerDashboard) and this throws for that role.
 * Every filter (project/department/date/status) is intersected with
 * this computed scope server-side — a filter value outside the caller's
 * scope is ignored, never trusted to widen access.
 */

export type DashboardFilters = {
  projectId?: string | null;
  departmentId?: string | null;
  /** ISO yyyy-mm-dd bounds for the work-item table's "activity in range"
   * reading — the KPI cards and month comparisons are always current/
   * previous calendar month, independent of this. */
  from?: string | null;
  to?: string | null;
  status?: "ALL" | "COMPLETED" | "IN_PROGRESS" | "STUCK" | "PENDING";
};

export type DashboardScopeOption = { projectId: string; projectName: string };
export type DashboardDepartmentOption = {
  departmentId: string;
  departmentName: string;
  projectId: string;
};

export type DashboardWorkItemRow = {
  workItemId: string;
  code: string;
  description: string;
  projectId: string;
  projectName: string;
  departmentId: string;
  departmentName: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  approvedQuantity: number | null;
  progressPercentage: number | null;
  isCompleted: boolean;
  /** Not completed, and no APPROVED activity recorded within the last
   * STUCK_THRESHOLD_DAYS — a derived signal from real timestamps
   * already in unified_records, never a fabricated status. A work item
   * that has never had anything approved yet is "Pending", not "Stuck"
   * (it hasn't stalled, it just hasn't started). */
  isStuck: boolean;
  lastApprovedAt: string | null;
  /** Financial fields are present only when includeFinancials is true
   * for this caller (see DashboardData) — omitted (undefined), never a
   * fake 0, for a caller without financial visibility. */
  scheduledValue?: number | null;
  estimatedAmount?: number | null;
};

export type DashboardDepartmentSummary = {
  departmentId: string;
  departmentName: string;
  projectId: string;
  projectName: string;
  totalWorkItems: number;
  completedCount: number;
  stuckCount: number;
  pendingCount: number;
  /** Department Overall Progress — see lib/calculations.ts
   * calculateOverallProgress (plain average of every Active work item in
   * the department; an item with no approved progress yet counts as 0%),
   * the same definition the Contractor brief and Subcontractor dashboard
   * use. Null only when the department has no Active work items. */
  overallProgressPercent: number | null;
  totalEstimatedAmount?: number | null;
  totalApprovedValue?: number | null;
  currentMonthApprovedValue?: number | null;
  previousMonthApprovedValue?: number | null;
};

export type DashboardData = {
  scopeProjects: DashboardScopeOption[];
  scopeDepartments: DashboardDepartmentOption[];
  includeFinancials: boolean;
  kpis: {
    totalProjects: number;
    /** A project counts as completed when every one of its Active work
     * items is individually complete (>=100% approved) — never
     * fabricated from a status field this schema doesn't have. Zero
     * work items in a project means it's not counted as completed
     * (nothing to be complete). */
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

const STUCK_THRESHOLD_DAYS = 14;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthBounds(monthsAgo: 0 | 1): { from: string; to: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - monthsAgo;
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));
  return { from: isoDate(start), to: isoDate(end) };
}

type UnifiedRecordRow = {
  work_item_id: string;
  accepted_quantity: number | null;
  accepted_at: string | null;
};

/** Every APPROVED unified_records row for a set of work items — one
 * query shared by lastApprovedAt / stuck detection / monthly value
 * calculations below, instead of one query per work item per concern. */
async function getApprovedUnifiedRecords(
  supabase: SupabaseClient,
  workItemIds: string[]
): Promise<UnifiedRecordRow[]> {
  if (workItemIds.length === 0) return [];
  const { data, error } = await supabase
    .from("unified_records")
    .select("work_item_id, accepted_quantity, accepted_at")
    .eq("status", "APPROVED")
    .in("work_item_id", workItemIds);

  if (error) throw new Error(`Failed to load approved records: ${error.message}`);
  return data ?? [];
}

function sumQuantityInRange(
  records: UnifiedRecordRow[],
  workItemId: string,
  bounds: { from: string; to: string }
): number {
  return records
    .filter(
      (r) =>
        r.work_item_id === workItemId &&
        r.accepted_at !== null &&
        r.accepted_at >= `${bounds.from}T00:00:00` &&
        r.accepted_at <= `${bounds.to}T23:59:59`
    )
    .reduce((sum, r) => sum + (r.accepted_quantity ?? 0), 0);
}

/**
 * The (project, department) scope this caller may see, and whether they
 * may see financial fields — the single authorization decision every
 * other computation in this module is filtered through.
 */
async function resolveDashboardScope(
  supabase: SupabaseClient,
  userId: string
): Promise<{
  isAdmin: boolean;
  includeFinancials: boolean;
  projectIds: Set<string> | "ALL";
  departmentIds: Set<string> | "ALL";
}> {
  if (await isAdminUser(supabase, userId)) {
    return { isAdmin: true, includeFinancials: true, projectIds: "ALL", departmentIds: "ALL" };
  }

  const ctx = await getUserContext(supabase, userId);
  if (ctx.role === "WORKER") {
    throw new Error(
      "Workers are not authorized for the aggregate Dashboard — use your Worker Dashboard instead."
    );
  }

  const projectIds = new Set<string>([ctx.projectId]);
  const departmentIds = new Set<string>([ctx.departmentId]);
  // Every project/department the user holds a reviewer (non-Worker) role
  // in — a Contractor with roles on several projects sees each of them,
  // not only their first role's. Still only the user's own Active rows.
  for (const row of ctx.availableProjects) {
    if (row.role !== "WORKER") {
      projectIds.add(row.projectId);
      departmentIds.add(row.departmentId);
    }
  }

  // A delegated Contractor also sees the department(s)/project(s)
  // covered by their active delegation(s) — same expansion
  // app/workflow/supervisor/page.tsx already does for its own delegated
  // panel, reused here rather than re-derived.
  if (CONTRACTOR_ROLES.includes(ctx.role)) {
    const activeDelegations = await getActiveDelegationsForUser(supabase, userId).catch(() => []);
    if (activeDelegations.length > 0) {
      const allDepartments = await listDepartments(supabase);
      for (const delegation of activeDelegations) {
        for (const project of delegation.projects) {
          projectIds.add(project.projectId);
          const departmentsForProject = delegation.departments.filter(
            (d) => d.projectId === project.projectId
          );
          const ids =
            departmentsForProject.length > 0
              ? departmentsForProject.map((d) => d.departmentId)
              : allDepartments
                  .filter((d) => d.projectId === project.projectId)
                  .map((d) => d.departmentId);
          ids.forEach((id) => departmentIds.add(id));
        }
      }
    }
  }

  return { isAdmin: false, includeFinancials: true, projectIds, departmentIds };
}

export async function getDashboardData(
  supabase: SupabaseClient,
  userId: string,
  filters: DashboardFilters
): Promise<DashboardData> {
  const scope = await resolveDashboardScope(supabase, userId);

  const [allProjects, allDepartments, allWorkItems] = await Promise.all([
    listProjects(supabase),
    listDepartments(supabase),
    listWorkItems(supabase),
  ]);

  const accessibleProjects = allProjects.filter(
    (p) => scope.projectIds === "ALL" || scope.projectIds.has(p.projectId)
  );
  const accessibleProjectIds = new Set(accessibleProjects.map((p) => p.projectId));

  const accessibleDepartments = allDepartments.filter(
    (d) =>
      accessibleProjectIds.has(d.projectId) &&
      (scope.departmentIds === "ALL" || scope.departmentIds.has(d.departmentId))
  );
  const accessibleDepartmentIds = new Set(accessibleDepartments.map((d) => d.departmentId));

  // Filters narrow the accessible scope; a filter value outside it is
  // silently ignored (never trusted to widen access beyond `scope`).
  const filterProjectId =
    filters.projectId && accessibleProjectIds.has(filters.projectId) ? filters.projectId : null;
  const filterDepartmentId =
    filters.departmentId && accessibleDepartmentIds.has(filters.departmentId)
      ? filters.departmentId
      : null;

  const departmentById = new Map(accessibleDepartments.map((d) => [d.departmentId, d]));
  const projectById = new Map(accessibleProjects.map((p) => [p.projectId, p]));

  const inScopeWorkItems = allWorkItems.filter((w) => {
    if (!departmentById.has(w.departmentId)) return false;
    if (w.status !== "Active") return false;
    const department = departmentById.get(w.departmentId)!;
    if (filterProjectId && department.projectId !== filterProjectId) return false;
    if (filterDepartmentId && w.departmentId !== filterDepartmentId) return false;
    return true;
  });

  const workItemIds = inScopeWorkItems.map((w) => w.workItemId);
  const approvedRecords = await getApprovedUnifiedRecords(supabase, workItemIds);
  const lastApprovedByWorkItem = new Map<string, string>();
  for (const record of approvedRecords) {
    if (!record.accepted_at) continue;
    const current = lastApprovedByWorkItem.get(record.work_item_id);
    if (!current || record.accepted_at > current) {
      lastApprovedByWorkItem.set(record.work_item_id, record.accepted_at);
    }
  }

  const currentMonth = monthBounds(0);
  const previousMonth = monthBounds(1);
  const stuckCutoff = Date.now() - STUCK_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  const rows: DashboardWorkItemRow[] = await Promise.all(
    inScopeWorkItems.map(async (w) => {
      const status = await getWorkItemCurrentStatus(supabase, w.workItemId, w.plannedQuantity);
      const department = departmentById.get(w.departmentId)!;
      const project = projectById.get(department.projectId);
      const lastApprovedAt = lastApprovedByWorkItem.get(w.workItemId) ?? null;
      const isStuck =
        !status.isCompleted &&
        lastApprovedAt !== null &&
        new Date(lastApprovedAt).getTime() < stuckCutoff;

      return {
        workItemId: w.workItemId,
        code: w.lineItemNo,
        description: w.descriptionOfWork,
        projectId: department.projectId,
        projectName: project?.projectName ?? "(unknown project)",
        departmentId: w.departmentId,
        departmentName: department.departmentName,
        plannedQuantity: w.plannedQuantity,
        unitOfMeasure: w.unitOfMeasure,
        approvedQuantity: status.approvedQuantity,
        progressPercentage: status.progressPercentage,
        isCompleted: status.isCompleted,
        isStuck,
        lastApprovedAt,
        scheduledValue: scope.includeFinancials ? w.scheduledValue : undefined,
        estimatedAmount: scope.includeFinancials
          ? calculateEstimatedAmount(w.scheduledValue, status.progressPercentage)
          : undefined,
      };
    })
  );

  // Date range narrows the work-item table to items with APPROVED
  // activity in [from, to] — an activity log reading, same concept as
  // listSubmissionsForDateRange in lib/workflow.ts, just at the
  // aggregate level. Department roll-ups (below) are unaffected, same
  // reasoning as the status filter.
  const dateFiltered =
    filters.from && filters.to
      ? rows.filter((r) =>
          approvedRecords.some(
            (rec) =>
              rec.work_item_id === r.workItemId &&
              rec.accepted_at !== null &&
              rec.accepted_at >= `${filters.from}T00:00:00` &&
              rec.accepted_at <= `${filters.to}T23:59:59`
          )
        )
      : rows;

  const statusFiltered = dateFiltered.filter((r) => {
    switch (filters.status) {
      case "COMPLETED":
        return r.isCompleted;
      case "STUCK":
        return r.isStuck;
      case "PENDING":
        return !r.isCompleted && r.progressPercentage === null;
      case "IN_PROGRESS":
        return !r.isCompleted && !r.isStuck && r.progressPercentage !== null;
      default:
        return true;
    }
  });

  // Department summaries always reflect the full in-scope set (not the
  // status-filtered rows) — the status filter narrows the table, not
  // the department roll-up, so switching the status filter doesn't make
  // departments disappear from the chart.
  const departmentSummaries: DashboardDepartmentSummary[] = accessibleDepartments
    .filter((d) => !filterDepartmentId || d.departmentId === filterDepartmentId)
    .filter((d) => !filterProjectId || d.projectId === filterProjectId)
    .map((d) => {
      const items = rows.filter((r) => r.departmentId === d.departmentId);
      const project = projectById.get(d.projectId);

      let totalEstimatedAmount = 0;
      let totalApprovedValue = 0;
      let currentMonthApprovedValue = 0;
      let previousMonthApprovedValue = 0;
      let hasFinancialData = false;

      for (const item of items) {
        if (scope.includeFinancials && item.scheduledValue !== null && item.scheduledValue !== undefined) {
          hasFinancialData = true;
          totalEstimatedAmount += item.scheduledValue;
          if (item.estimatedAmount !== null && item.estimatedAmount !== undefined) {
            totalApprovedValue += item.estimatedAmount;
          }

          if (item.plannedQuantity !== null && item.plannedQuantity > 0) {
            const currentQty = sumQuantityInRange(approvedRecords, item.workItemId, currentMonth);
            const previousQty = sumQuantityInRange(approvedRecords, item.workItemId, previousMonth);
            currentMonthApprovedValue += item.scheduledValue * (currentQty / item.plannedQuantity);
            previousMonthApprovedValue += item.scheduledValue * (previousQty / item.plannedQuantity);
          }
        }
      }

      return {
        departmentId: d.departmentId,
        departmentName: d.departmentName,
        projectId: d.projectId,
        projectName: project?.projectName ?? "(unknown project)",
        totalWorkItems: items.length,
        completedCount: items.filter((i) => i.isCompleted).length,
        stuckCount: items.filter((i) => i.isStuck).length,
        pendingCount: items.filter((i) => !i.isCompleted && !i.isStuck).length,
        overallProgressPercent: calculateOverallProgress(items.map((i) => i.progressPercentage)),
        totalEstimatedAmount: scope.includeFinancials && hasFinancialData ? round2(totalEstimatedAmount) : null,
        totalApprovedValue: scope.includeFinancials && hasFinancialData ? round2(totalApprovedValue) : null,
        currentMonthApprovedValue:
          scope.includeFinancials && hasFinancialData ? round2(currentMonthApprovedValue) : null,
        previousMonthApprovedValue:
          scope.includeFinancials && hasFinancialData ? round2(previousMonthApprovedValue) : null,
      };
    });

  // Project completion: every Active work item in the project (within
  // scope) must individually be complete; a project with zero in-scope
  // work items is not counted (nothing to be complete).
  const completedProjects = accessibleProjects.filter((p) => {
    const items = rows.filter((r) => r.projectId === p.projectId);
    return items.length > 0 && items.every((i) => i.isCompleted);
  }).length;

  const kpiFinancials = rows.reduce(
    (acc, r) => {
      if (scope.includeFinancials && r.scheduledValue !== null && r.scheduledValue !== undefined) {
        acc.totalEstimatedAmount += r.scheduledValue;
        if (r.estimatedAmount !== null && r.estimatedAmount !== undefined) {
          acc.totalApprovedValue += r.estimatedAmount;
        }
      }
      return acc;
    },
    { totalEstimatedAmount: 0, totalApprovedValue: 0 }
  );

  const currentMonthTotal = departmentSummaries.reduce(
    (sum, d) => sum + (d.currentMonthApprovedValue ?? 0),
    0
  );
  const previousMonthTotal = departmentSummaries.reduce(
    (sum, d) => sum + (d.previousMonthApprovedValue ?? 0),
    0
  );
  const anyFinancialData = departmentSummaries.some((d) => d.totalEstimatedAmount !== null);

  return {
    scopeProjects: accessibleProjects.map((p) => ({ projectId: p.projectId, projectName: p.projectName })),
    scopeDepartments: accessibleDepartments.map((d) => ({
      departmentId: d.departmentId,
      departmentName: d.departmentName,
      projectId: d.projectId,
    })),
    includeFinancials: scope.includeFinancials,
    kpis: {
      totalProjects: accessibleProjects.length,
      completedProjects,
      totalDepartments: accessibleDepartments.length,
      totalWorkItems: rows.length,
      overallProgressPercent: calculateOverallProgress(rows.map((r) => r.progressPercentage)),
      totalEstimatedAmount:
        scope.includeFinancials && anyFinancialData ? round2(kpiFinancials.totalEstimatedAmount) : null,
      totalApprovedValue:
        scope.includeFinancials && anyFinancialData ? round2(kpiFinancials.totalApprovedValue) : null,
      remainingValue:
        scope.includeFinancials && anyFinancialData
          ? round2(kpiFinancials.totalEstimatedAmount - kpiFinancials.totalApprovedValue)
          : null,
      currentMonthApprovedValue: scope.includeFinancials && anyFinancialData ? round2(currentMonthTotal) : null,
      previousMonthApprovedValue: scope.includeFinancials && anyFinancialData ? round2(previousMonthTotal) : null,
    },
    departments: departmentSummaries,
    workItems: statusFiltered,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
