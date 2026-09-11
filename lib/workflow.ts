import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserContext, assertRole, isAdminUser, resolveActorRole, CONTRACTOR_ROLES } from "./authContext";
import { hasDelegatedPermission } from "./delegation";
import { updateWorkItemValues } from "./admin";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";
import {
  createProgressNotification,
  createReviewerNotification,
  listDepartmentReviewers,
} from "./notifications";
import {
  formatDateUS,
  formatUserDisplayName,
  humanizeWorkerSubmissionStatus,
  type WorkerSubmissionStatusCode,
} from "./format";
import {
  calculateCompletedQuantity,
  calculateEarnedAmount,
  calculateEstimatedAmount,
  calculateProgressPercentage,
  isWorkItemComplete,
} from "./calculations";

/**
 * Role-based construction progress workflow, built on the existing
 * Construction Automation schema (companies/projects/departments/
 * work_items/users/user_project_roles/extraction_submissions/
 * user_validations/unified_records/work_item_progress/reporting_periods).
 *
 * No new tables. Pipeline stage for a submission is derived, not stored:
 *   - no user_validations row yet          -> pending Foreman review
 *   - user_validations row, approval_status
 *     is null                              -> pending Supervisor approval
 *   - user_validations.approval_status =
 *     'APPROVED' and unified_records.status
 *     = 'APPROVED'                         -> approved (counts toward
 *                                             Today's / MTD Progress)
 * Rollback clears approval_status back to null and flips the
 * unified_records row to 'ROLLED_BACK' (kept, not duplicated) so it
 * drops out of the approved views and back into the Supervisor queue.
 */

export type ProgressData = {
  description: string;
  progress_percentage: number;
  /** Present when the work item has a planned_quantity and progress was
   * calculated (not manually entered) — see lib/calculations.ts. */
  completed_quantity?: number | null;
  unit?: string | null;
};

export type SelectableUser = {
  userId: string;
  email: string;
  role: string;
  projectId: string;
  projectName: string;
  departmentId: string;
  departmentName: string;
};

export async function listSelectableUsers(
  supabase: SupabaseClient
): Promise<SelectableUser[]> {
  const { data, error } = await supabase
    .from("user_project_roles")
    .select(
      "user_id, role, project_id, department_id, status, users(user_mail), projects(project_name), departments(department_name)"
    )
    .eq("status", "Active");

  if (error) {
    throw new Error(`Failed to load users: ${error.message}`);
  }

  type Row = {
    user_id: string;
    role: string;
    project_id: string;
    department_id: string;
    users: { user_mail: string } | { user_mail: string }[] | null;
    projects: { project_name: string } | { project_name: string }[] | null;
    departments:
      | { department_name: string }
      | { department_name: string }[]
      | null;
  };

  const one = <T,>(v: T | T[] | null): T | null =>
    Array.isArray(v) ? v[0] ?? null : v;

  return ((data ?? []) as Row[]).map((row) => ({
    userId: row.user_id,
    email: one(row.users)?.user_mail ?? "(unknown)",
    role: row.role,
    projectId: row.project_id,
    projectName: one(row.projects)?.project_name ?? "(unknown project)",
    departmentId: row.department_id,
    departmentName:
      one(row.departments)?.department_name ?? "(unknown department)",
  }));
}

// getUserContext moved to ./authContext (shared with lib/delegation.ts,
// which would otherwise need to import it from here and create a
// cycle) — re-exported below so every existing `from "@/lib/workflow"`
// import keeps working unchanged.
export { getUserContext };

const WORK_ITEM_SELECT =
  "work_item_id, project_id, department_id, line_item_no, description_of_work, scheduled_value, planned_quantity, unit_of_measure";

type WorkItemRecord = {
  work_item_id: string;
  project_id: string;
  department_id: string;
  line_item_no: string;
  description_of_work: string;
  scheduled_value: number | null;
  planned_quantity: number | null;
  unit_of_measure: string | null;
};

/**
 * Lowest line_item_no work item currently assigned (work_item_assignments,
 * status Active) to this worker within their department — the default
 * work item when the Worker hasn't (yet) picked one explicitly. Replaces
 * the old "lowest line_item_no in the department" default: a worker can
 * only ever land on a work item that is actually theirs. Still used as
 * the fallback inside resolveWorkItemForWorker below.
 */
async function getPrimaryAssignedWorkItem(
  supabase: SupabaseClient,
  workerId: string,
  departmentId: string
): Promise<WorkItemRecord> {
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("work_item_assignments")
    .select(`work_items!inner(${WORK_ITEM_SELECT})`)
    .eq("user_id", workerId)
    .eq("status", "Active")
    .eq("work_items.department_id", departmentId)
    .eq("work_items.status", "Active")
    .order("line_item_no", { referencedTable: "work_items", ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load assigned work item: ${error.message}`);
  }

  const workItem = data
    ? ((Array.isArray(data.work_items) ? data.work_items[0] : data.work_items) as
        | WorkItemRecord
        | undefined)
    : undefined;

  if (!workItem) {
    throw new Error(
      `No work item is assigned to worker ${workerId} in department ${departmentId}`
    );
  }

  return workItem;
}

async function getWorkItemById(
  supabase: SupabaseClient,
  workItemId: string
): Promise<WorkItemRecord> {
  const { data, error } = await supabase
    .from("work_items")
    .select(WORK_ITEM_SELECT)
    .eq("work_item_id", workItemId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load work item: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Work item ${workItemId} not found`);
  }

  return data;
}

/** Reviewer display name for notification text — same lookup/formatting
 * as every worker/user display name elsewhere in this app (see toQueueItem). */
async function getUserDisplayName(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("users")
    .select("user_mail, first_name, last_name")
    .eq("user_id", userId)
    .single();
  if (error || !data) return "(unknown)";
  return formatUserDisplayName({
    firstName: data.first_name,
    lastName: data.last_name,
    email: data.user_mail,
  });
}

/** Project/department names + work item description for notification
 * text — a single lookup shared by every notification-creating action
 * below (foremanForwardSubmission/supervisorApprove/
 * supervisorEditSubmission/supervisorRollback) so they can never
 * disagree on how a work item/project/department reads in a
 * notification. */
async function getProgressNotificationContext(
  supabase: SupabaseClient,
  params: { projectId: string; departmentId: string; workItemId: string }
): Promise<{ projectName: string; departmentName: string; workItemDescription: string }> {
  const [{ data: project }, { data: department }, workItem] = await Promise.all([
    supabase.from("projects").select("project_name").eq("project_id", params.projectId).single(),
    supabase
      .from("departments")
      .select("department_name")
      .eq("department_id", params.departmentId)
      .single(),
    getWorkItemById(supabase, params.workItemId),
  ]);

  return {
    projectName: project?.project_name ?? "(unknown project)",
    departmentName: department?.department_name ?? "(unknown department)",
    workItemDescription: workItem.description_of_work,
  };
}

/** Whether work_item_assignments has an Active row for this exact
 * (worker, work item) pair — the actual authorization check behind
 * resolveWorkItemForWorker, so a worker can never view or submit
 * against a work item that isn't theirs, department match alone is not
 * enough (see migration 00000000000005_work_item_assignments). */
async function isWorkItemAssignedToWorker(
  supabase: SupabaseClient,
  workerId: string,
  workItemId: string
): Promise<boolean> {
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("work_item_assignments")
    .select("work_item_id")
    .eq("user_id", workerId)
    .eq("work_item_id", workItemId)
    .eq("status", "Active")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to check work item assignment: ${error.message}`);
  }
  return !!data;
}

/**
 * Resolves which work item a Worker action applies to: an explicit
 * workItemId (from the dropdown / next-task selection) if given, only
 * when it both belongs to the worker's department AND is actually
 * assigned to this worker — otherwise the same lowest-line_item_no
 * assigned default this app always used. Centralized here so
 * getWorkerDashboard and submitWorkerProgress can never disagree about
 * which work item "current" means, and a worker can never view or
 * submit against another department's work item, or an unassigned work
 * item even within their own department.
 */
async function resolveWorkItemForWorker(
  supabase: SupabaseClient,
  workerId: string,
  departmentId: string,
  workItemId?: string | null
): Promise<WorkItemRecord> {
  if (!workItemId) {
    return getPrimaryAssignedWorkItem(supabase, workerId, departmentId);
  }

  const workItem = await getWorkItemById(supabase, workItemId);
  if (workItem.department_id !== departmentId) {
    throw new Error(
      `Work item ${workItemId} does not belong to department ${departmentId}`
    );
  }
  if (!(await isWorkItemAssignedToWorker(supabase, workerId, workItemId))) {
    throw new Error(
      `Work item ${workItemId} is not assigned to worker ${workerId}`
    );
  }
  return workItem;
}

export type WorkItemOption = {
  workItemId: string;
  lineItemNo: string;
  code: string;
  description: string;
  scheduledValue: number | null;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  /** Cumulative progress across every APPROVED record for this work
   * item, all time (not date-bounded) — see getWorkItemCurrentStatus.
   * Null if never approved (or, for percentage-only legacy items, if
   * nothing has been approved yet). */
  progressPercentage: number | null;
  isCompleted: boolean;
  /** Other work_item_ids in the same department that must be complete
   * before this one is eligible for the next-task suggestion. Empty =
   * no prerequisites, always eligible. See work_item_dependencies. */
  dependsOnWorkItemIds: string[];
  /** !isCompleted && every dependsOnWorkItemIds entry is complete
   * (vacuously true when there are none). Advisory only — drives the
   * next-task suggestion, does not block manual selection. */
  isEligible: boolean;
};

/**
 * Shared by listWorkItemsForDepartment (Foreman/Supervisor: every work
 * item in the department) and listAssignedWorkItemsForWorker (Worker:
 * only their own) — one annotation path so completion/eligibility can
 * never disagree between the two views.
 */
async function annotateWorkItemOptions(
  supabase: SupabaseClient,
  items: WorkItemRecord[]
): Promise<WorkItemOption[]> {
  const withStatus = await Promise.all(
    items.map(async (item) => {
      const status = await getWorkItemCurrentStatus(
        supabase,
        item.work_item_id,
        item.planned_quantity
      );
      return {
        workItemId: item.work_item_id,
        lineItemNo: item.line_item_no,
        code: item.line_item_no,
        description: item.description_of_work,
        scheduledValue: item.scheduled_value,
        plannedQuantity: item.planned_quantity,
        unitOfMeasure: item.unit_of_measure,
        progressPercentage: status.progressPercentage,
        isCompleted: status.isCompleted,
      };
    })
  );

  const dependencyMap = await getWorkItemDependencyMap(
    supabase,
    items.map((i) => i.work_item_id)
  );
  const completedIds = new Set(
    withStatus.filter((w) => w.isCompleted).map((w) => w.workItemId)
  );

  return withStatus.map((w) => {
    const dependsOnWorkItemIds = dependencyMap.get(w.workItemId) ?? [];
    const isEligible =
      !w.isCompleted && dependsOnWorkItemIds.every((id) => completedIds.has(id));
    return { ...w, dependsOnWorkItemIds, isEligible };
  });
}

/**
 * Every Active work item in a department, in construction sequence
 * (line_item_no order), each annotated with its own completion state.
 * This is the Foreman/Subcontractor and Supervisor/Contractor view —
 * they review and approve across every worker in their department, so
 * they intentionally see the whole department's work items, not just
 * one worker's assigned subset (see listAssignedWorkItemsForWorker for
 * that narrower, Worker-facing view).
 */
export async function listWorkItemsForDepartment(
  supabase: SupabaseClient,
  departmentId: string
): Promise<WorkItemOption[]> {
  const { data, error } = await supabase
    .from("work_items")
    .select(WORK_ITEM_SELECT)
    .eq("department_id", departmentId)
    .eq("status", "Active")
    .order("line_item_no", { ascending: true });

  if (error) {
    throw new Error(`Failed to load work items: ${error.message}`);
  }

  return annotateWorkItemOptions(supabase, data ?? []);
}

/**
 * Only the Active work items explicitly assigned (work_item_assignments)
 * to this worker, within their department — the Worker's "My Work
 * Items" list. A work item can be assigned to several workers at once
 * (many-to-many); this returns only this worker's own set, never every
 * work item in the department (see listWorkItemsForDepartment for that).
 */
export async function listAssignedWorkItemsForWorker(
  supabase: SupabaseClient,
  workerId: string,
  departmentId: string
): Promise<WorkItemOption[]> {
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("work_item_assignments")
    .select(`work_items!inner(${WORK_ITEM_SELECT})`)
    .eq("user_id", workerId)
    .eq("status", "Active")
    .eq("work_items.department_id", departmentId)
    .eq("work_items.status", "Active");

  if (error) {
    throw new Error(`Failed to load assigned work items: ${error.message}`);
  }

  type Row = { work_items: WorkItemRecord | WorkItemRecord[] | null };

  const items = ((data ?? []) as Row[])
    .map((row) => (Array.isArray(row.work_items) ? row.work_items[0] : row.work_items))
    .filter((w): w is WorkItemRecord => !!w)
    .sort((a, b) => a.line_item_no.localeCompare(b.line_item_no));

  return annotateWorkItemOptions(supabase, items);
}

/**
 * Every currently-incomplete work item in the department whose
 * prerequisites (if any) are all complete — zero, one, or several.
 * Department-level work already runs in parallel (each department is
 * independent everywhere in this app); this is about work items
 * *within* one department, which are no longer forced through a
 * single line_item_no chain (Foundation -> Walls -> Roofing -> ...).
 * line_item_no still orders the list for display, but is no longer
 * read as a dependency graph — real dependencies are configured
 * explicitly via work_item_dependencies (see isEligible on
 * WorkItemOption, computed in listWorkItemsForDepartment).
 */
export function suggestNextWorkItem(workItems: WorkItemOption[]): WorkItemOption[] {
  return workItems.filter((w) => w.isEligible);
}

/** Current open reporting period covering `date` for `projectCode`. */
async function getCurrentReportingPeriod(
  supabase: SupabaseClient,
  projectCode: string,
  date: string
) {
  const { data, error } = await supabase
    .from("reporting_periods")
    .select("reporting_period_id, period_start, period_end")
    .eq("project_code", projectCode)
    .lte("period_start", date)
    .gte("period_end", date)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load reporting period: ${error.message}`);
  }
  return data;
}

/**
 * Latest APPROVED unified_records row for a work item, optionally
 * bounded to [fromDate, toDate] (inclusive, by accepted_at date).
 */
async function getLatestApprovedRecord(
  supabase: SupabaseClient,
  workItemId: string,
  bounds?: { from: string; to: string }
) {
  let query = supabase
    .from("unified_records")
    .select(
      "unified_record_id, accepted_data, accepted_at, work_item_id, status"
    )
    .eq("work_item_id", workItemId)
    .eq("status", "APPROVED")
    .order("accepted_at", { ascending: false })
    .limit(1);

  if (bounds) {
    query = query
      .gte("accepted_at", `${bounds.from}T00:00:00`)
      .lte("accepted_at", `${bounds.to}T23:59:59`);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`Failed to load approved progress: ${error.message}`);
  }
  return data;
}

/**
 * Sum of accepted_quantity across every APPROVED (non-rolled-back)
 * unified_records row for a work item, all-time (not date-bounded) —
 * the running total of physical quantity actually completed so far.
 * Rows with a null accepted_quantity (e.g. legacy percentage-only
 * submissions mixed into the same work item's history) contribute 0
 * rather than being skipped.
 */
async function getCumulativeApprovedQuantity(
  supabase: SupabaseClient,
  workItemId: string
): Promise<number> {
  const { data, error } = await supabase
    .from("unified_records")
    .select("accepted_quantity")
    .eq("work_item_id", workItemId)
    .eq("status", "APPROVED");

  if (error) {
    throw new Error(`Failed to load approved quantities: ${error.message}`);
  }
  return (data ?? []).reduce(
    (sum, row) => sum + (row.accepted_quantity ?? 0),
    0
  );
}

/**
 * Sum of accepted_quantity across every APPROVED unified_records row
 * for a work item whose accepted_at falls within [bounds.from,
 * bounds.to] (inclusive) — the date-bounded counterpart to
 * getCumulativeApprovedQuantity above, used for "today's approved
 * completed quantity" (see getWorkerDashboard's todaysEarnedAmount).
 * Same status = 'APPROVED' filter as everywhere else progress is
 * computed in this app: a ROLLED_BACK or not-yet-approved record
 * (still status null/pending on user_validations, never inserted into
 * unified_records at all until Supervisor approval) never contributes
 * here, so an unapproved or rolled-back submission can never inflate a
 * worker's earned amount.
 */
async function getApprovedQuantityInRange(
  supabase: SupabaseClient,
  workItemId: string,
  bounds: { from: string; to: string }
): Promise<number> {
  const { data, error } = await supabase
    .from("unified_records")
    .select("accepted_quantity")
    .eq("work_item_id", workItemId)
    .eq("status", "APPROVED")
    .gte("accepted_at", `${bounds.from}T00:00:00`)
    .lte("accepted_at", `${bounds.to}T23:59:59`);

  if (error) {
    throw new Error(`Failed to load approved quantity for range: ${error.message}`);
  }
  return (data ?? []).reduce((sum, row) => sum + (row.accepted_quantity ?? 0), 0);
}

/**
 * Current progress % / completion for a work item, "right now" (not
 * date-bounded) — the concept used everywhere this app answers "is
 * this work item currently complete":
 *   - when the work item has a planned_quantity configured, progress
 *     is the true running sum of every APPROVED submission's
 *     accepted_quantity divided by planned_quantity (25 m² one day +
 *     20 m² another day = 45/100 = 45%, never just the latest
 *     submission's own percentage);
 *   - when it does NOT have a planned_quantity (percentage-only legacy
 *     mode), there is nothing to sum against, so this keeps the
 *     existing "latest APPROVED submission's stored percentage is a
 *     snapshot of current status" behavior, unchanged.
 * Used by getWorkItemCumulativeList (MTD Progress / Work Summary) and
 * getWorkerDashboard for exactly this "current state" reading.
 * Deliberately NOT used by getTodaysProgress/getYesterdaysProgress —
 * those are an activity log of actual submissions on one date (see
 * listSubmissionsForDateRange), a different concept.
 */
export async function getWorkItemCurrentStatus(
  supabase: SupabaseClient,
  workItemId: string,
  plannedQuantity: number | null
): Promise<{
  progressPercentage: number | null;
  isCompleted: boolean;
  /** The raw cumulative approved quantity behind progressPercentage (see
   * getCumulativeApprovedQuantity) — null in percentage-only legacy mode,
   * where there is no quantity to sum. Callers that display progress in
   * quantity terms (e.g. "45 of 100 m²"), not just "45%", need this. */
  approvedQuantity: number | null;
}> {
  if (plannedQuantity !== null && plannedQuantity > 0) {
    const cumulativeQuantity = await getCumulativeApprovedQuantity(supabase, workItemId);
    const progressPercentage = calculateProgressPercentage(cumulativeQuantity, plannedQuantity);
    return {
      progressPercentage,
      isCompleted: isWorkItemComplete(progressPercentage),
      approvedQuantity: cumulativeQuantity,
    };
  }

  const latest = await getLatestApprovedRecord(supabase, workItemId);
  const progressPercentage =
    (latest?.accepted_data as ProgressData | null)?.progress_percentage ?? null;
  return {
    progressPercentage,
    isCompleted: isWorkItemComplete(progressPercentage),
    approvedQuantity: null,
  };
}

/** work_item_id -> [depends_on_work_item_id, ...] for a set of work
 * item ids (typically one department's items). No entry / empty array
 * means "no prerequisites, always eligible." */
async function getWorkItemDependencyMap(
  supabase: SupabaseClient,
  workItemIds: string[]
): Promise<Map<string, string[]>> {
  if (workItemIds.length === 0) return new Map();

  const { data, error } = await getSupabaseServiceRoleClient()
    .from("work_item_dependencies")
    .select("work_item_id, depends_on_work_item_id")
    .in("work_item_id", workItemIds);

  if (error) {
    throw new Error(`Failed to load work item dependencies: ${error.message}`);
  }

  const map = new Map<string, string[]>();
  for (const row of data ?? []) {
    const list = map.get(row.work_item_id) ?? [];
    list.push(row.depends_on_work_item_id);
    map.set(row.work_item_id, list);
  }
  return map;
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * First day of the current calendar month, computed from the real
 * clock every call — never a stored/seeded value, so this rolls over
 * automatically at every month boundary (Sept -> Oct -> Nov -> ... ->
 * Dec -> Jan) with no admin action required. MTD is calendar-month
 * based, not tied to whether a reporting_periods row happens to exist
 * for the current month (see getWorkSummary's reportingPeriodLabel,
 * which is display-only and falls back gracefully when one doesn't).
 */
function currentMonthStartISODate(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

// ------------------------------------------------------------------
// Worker
// ------------------------------------------------------------------

export type WorkerDashboard = {
  projectName: string;
  departmentName: string;
  // Raw scheduledValue/full estimatedAmount are still never exposed
  // here (Worker has no general financial-visibility permission — see
  // WorkItemOption/QueueItem/WorkItemProgressView in this file, which
  // DO carry those for Contractor/Subcontractor/Admin). The one
  // deliberate exception is todaysEarnedAmount below: a single derived
  // figure (per-unit rate x today's own approved quantity), not the
  // underlying Scheduled Value itself — explicitly requested so a
  // Worker can see the value of work they actually got approved today,
  // never editable by them and never a broader financial view.
  workItem: {
    id: string;
    code: string;
    description: string;
    plannedQuantity: number | null;
    unitOfMeasure: string | null;
  };
  todaysProgress: number | null;
  /** Latest APPROVED progress for this work item, not date-bound — the
   * item's true current completion state (see suggestNextWorkItem). */
  overallProgress: number | null;
  /** Cumulative approved quantity behind overallProgress — null in
   * percentage-only legacy mode (no planned_quantity configured). Lets
   * the dashboard show "45 of 100 m²", not just "45%". */
  overallApprovedQuantity: number | null;
  /** Monetary value of THIS work item's APPROVED activity today only —
   * (Scheduled Value / Planned Quantity) x today's approved completed
   * quantity (see lib/calculations.ts calculateEarnedAmount). A
   * genuine $0 when the work item is configured but nothing was
   * approved yet today; null only when the work item itself has no
   * planned_quantity/scheduled_value configured (the figure truly
   * cannot be computed, never fabricated as $0 in that case). This is
   * the value of completed WORK, not a wage/salary figure. */
  todaysEarnedAmount: number | null;
  isCompleted: boolean;
  latestSubmissionStatusCode: WorkerSubmissionStatusCode | null;
  latestSubmissionStatusLabel: string | null;
};

/**
 * Status of the worker's most recent submission, derived from whether a
 * user_validations row exists for it and its approval_status — no new
 * database state, just reading what's already there.
 */
async function getLatestSubmissionStatus(
  supabase: SupabaseClient,
  workerId: string
): Promise<WorkerSubmissionStatusCode | null> {
  const { data: submission, error } = await supabase
    .from("extraction_submissions")
    .select("extraction_submission_id, created_at")
    .eq("worker_id", workerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load latest submission: ${error.message}`);
  }
  if (!submission) return null;

  const { data: validation, error: valError } = await supabase
    .from("user_validations")
    .select("approval_status")
    .eq("submission_id", submission.extraction_submission_id)
    .maybeSingle();

  if (valError) {
    throw new Error(`Failed to load validation status: ${valError.message}`);
  }
  if (!validation) return "AWAITING_FOREMAN_REVIEW";
  if (validation.approval_status === "APPROVED") return "APPROVED";
  if (validation.approval_status === "ROLLED_BACK") return "ROLLED_BACK";
  return "AWAITING_SUPERVISOR_APPROVAL";
}

export async function getWorkerDashboard(
  supabase: SupabaseClient,
  userId: string,
  workItemId?: string | null
): Promise<WorkerDashboard> {
  const ctx = await getUserContext(supabase, userId);
  const workItem = await resolveWorkItemForWorker(supabase, userId, ctx.departmentId, workItemId);
  const todayBounds = { from: todayISODate(), to: todayISODate() };
  const [todaysApproved, todaysApprovedQuantity, overallStatus, statusCode] = await Promise.all([
    getLatestApprovedRecord(supabase, workItem.work_item_id, todayBounds),
    getApprovedQuantityInRange(supabase, workItem.work_item_id, todayBounds),
    getWorkItemCurrentStatus(supabase, workItem.work_item_id, workItem.planned_quantity),
    getLatestSubmissionStatus(supabase, userId),
  ]);

  return {
    projectName: ctx.projectName,
    departmentName: ctx.departmentName,
    workItem: {
      id: workItem.work_item_id,
      code: workItem.line_item_no,
      description: workItem.description_of_work,
      plannedQuantity: workItem.planned_quantity,
      unitOfMeasure: workItem.unit_of_measure,
    },
    todaysProgress:
      (todaysApproved?.accepted_data as ProgressData | null)?.progress_percentage ??
      null,
    overallProgress: overallStatus.progressPercentage,
    overallApprovedQuantity: overallStatus.approvedQuantity,
    todaysEarnedAmount: calculateEarnedAmount(
      todaysApprovedQuantity,
      workItem.planned_quantity,
      workItem.scheduled_value
    ),
    isCompleted: overallStatus.isCompleted,
    latestSubmissionStatusCode: statusCode,
    latestSubmissionStatusLabel: statusCode
      ? humanizeWorkerSubmissionStatus(statusCode)
      : null,
  };
}

export async function submitWorkerProgress(
  supabase: SupabaseClient,
  params: {
    workerId: string;
    workItemId?: string | null;
    /** Optional: number typed/selected by the worker in the dropdown or
     * detected from their update text. Client-submitted progressPercentage
     * is only used as a fallback (work item has no planned_quantity
     * configured yet) — whenever a planned quantity exists, the server
     * recomputes progress from completedQuantity itself so the % can
     * never be spoofed from the client. */
    completedQuantity?: number | null;
    progressPercentage: number;
    description: string;
  }
): Promise<void> {
  const ctx = await getUserContext(supabase, params.workerId);
  const workItem = await resolveWorkItemForWorker(
    supabase,
    params.workerId,
    ctx.departmentId,
    params.workItemId
  );

  const calculatedProgress = calculateProgressPercentage(
    params.completedQuantity,
    workItem.planned_quantity
  );
  const progressPercentage = calculatedProgress ?? params.progressPercentage;

  const structured: ProgressData = {
    description: params.description,
    progress_percentage: progressPercentage,
    completed_quantity:
      calculatedProgress !== null ? params.completedQuantity ?? null : null,
    unit: calculatedProgress !== null ? workItem.unit_of_measure : null,
  };

  const { error } = await supabase.from("extraction_submissions").insert({
    project_id: ctx.projectId,
    department_id: ctx.departmentId,
    work_item_id: workItem.work_item_id,
    worker_id: params.workerId,
    input_type: "TEXT",
    raw_input_text: params.description,
    structured_output: structured,
    submission_status: "SUBMITTED",
  });

  if (error) {
    throw new Error(`Failed to submit progress: ${error.message}`);
  }

  // Tell the responsible reviewer(s) — every Active Foreman in this
  // department — that a submission is waiting, rather than leaving
  // them to discover it only by opening the queue. Best-effort: a
  // notification failure must never fail the submission itself (see
  // createReviewerNotification's own try/catch-free, logged-error
  // contract).
  const foremanIds = await listDepartmentReviewers(supabase, ctx.projectId, ctx.departmentId, ["FOREMAN"]);
  if (foremanIds.length > 0) {
    const workerName = await getUserDisplayName(supabase, params.workerId);
    await createReviewerNotification(supabase, {
      recipientUserIds: foremanIds,
      type: "SUBMISSION_PENDING_REVIEW",
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      departmentId: ctx.departmentId,
      departmentName: ctx.departmentName,
      workItemId: workItem.work_item_id,
      workItemDescription: workItem.description_of_work,
      submittedProgress: progressPercentage,
      actorUserId: params.workerId,
      actorRole: "WORKER",
      actorName: workerName,
    });
  }
}

// ------------------------------------------------------------------
// Shared: submission queues
// ------------------------------------------------------------------

export type QueueItem = {
  submissionId: string;
  /** extraction_submissions.created_at, ISO timestamp — when this
   * submission was made (display via lib/format.ts formatDateUS, not
   * the raw string). Added for the Worker's own History view, where
   * "when" matters since delayed approval keeps older entries around
   * for a while; every other current consumer of QueueItem already
   * groups by date server-side (Today's/Yesterday's/History bounds) so
   * this is additive, nothing existing reads or depends on it. */
  submittedAt: string;
  workerName: string;
  projectName: string;
  departmentName: string;
  workItemCode: string;
  workItemDescription: string;
  submittedProgress: number;
  /** Quantity/unit as originally submitted (see ProgressData.completed_quantity/unit)
   * — null for percentage-only work items or legacy submissions. */
  submittedQuantity: number | null;
  unit: string | null;
  description: string;
  validationId: string | null;
  correctedProgress: number | null;
  comments: string | null;
  approvalComments: string | null;
  approvalStatus: string | null;
  scheduledValue: number | null;
  /** Estimated Amount for whichever progress is currently displayed
   * (corrected if present, else submitted) — scheduledValue x progress/100. */
  estimatedAmount: number | null;
  isCompleted: boolean;
  /** Where this specific submission currently sits in the review
   * pipeline — same 4-state vocabulary as getLatestSubmissionStatus,
   * derived here from validationId/approvalStatus instead of a second
   * query. Awaiting-foreman vs awaiting-supervisor are otherwise
   * indistinguishable (both read as approvalStatus === null). */
  reviewStatusCode: WorkerSubmissionStatusCode;
  reviewStatusLabel: string;
};

type SubmissionRow = {
  extraction_submission_id: string;
  structured_output: ProgressData | null;
  raw_input_text: string | null;
  created_at: string;
  project_id: string;
  department_id: string;
  work_item_id: string;
  users:
    | { user_mail: string; first_name: string | null; last_name: string | null }
    | { user_mail: string; first_name: string | null; last_name: string | null }[]
    | null;
  projects: { project_name: string } | { project_name: string }[] | null;
  departments:
    | { department_name: string }
    | { department_name: string }[]
    | null;
  work_items:
    | {
        line_item_no: string;
        description_of_work: string;
        scheduled_value: number | null;
        planned_quantity: number | null;
      }
    | {
        line_item_no: string;
        description_of_work: string;
        scheduled_value: number | null;
        planned_quantity: number | null;
      }[]
    | null;
};

const one = <T,>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? v[0] ?? null : v;

function toQueueItem(
  row: SubmissionRow,
  validation: {
    user_validations_id: string;
    corrected_data: ProgressData | null;
    original_data: ProgressData | null;
    comments: string | null;
    approval_comments: string | null;
    approval_status: string | null;
  } | null,
  /** Overrides the per-submission isCompleted with the work item's true
   * cumulative completion state (see getWorkItemCurrentStatus) — passed
   * by getCurrentWorkItemRecords (Supervisor Tab1/Tab2 badges), which
   * knows the work item's planned_quantity and history. Omitted by
   * listForemanQueue, which keeps the original per-submission reading
   * since a Foreman card is about reviewing one specific report. */
  cumulativeIsCompleted?: boolean
): QueueItem {
  const structured = row.structured_output;
  const worker = one(row.users);
  const scheduledValue = one(row.work_items)?.scheduled_value ?? null;
  const submittedProgress =
    validation?.original_data?.progress_percentage ??
    structured?.progress_percentage ??
    0;
  const submittedQuantity =
    validation?.original_data?.completed_quantity ?? structured?.completed_quantity ?? null;
  const unit = validation?.original_data?.unit ?? structured?.unit ?? null;
  const correctedProgress = validation?.corrected_data?.progress_percentage ?? null;
  const displayedProgress = correctedProgress ?? submittedProgress;
  const reviewStatusCode: WorkerSubmissionStatusCode = !validation
    ? "AWAITING_FOREMAN_REVIEW"
    : validation.approval_status === "APPROVED"
      ? "APPROVED"
      : validation.approval_status === "ROLLED_BACK"
        ? "ROLLED_BACK"
        : "AWAITING_SUPERVISOR_APPROVAL";

  return {
    submissionId: row.extraction_submission_id,
    submittedAt: row.created_at,
    workerName: worker
      ? formatUserDisplayName({
          firstName: worker.first_name,
          lastName: worker.last_name,
          email: worker.user_mail,
        })
      : "(unknown)",
    projectName: one(row.projects)?.project_name ?? "(unknown)",
    departmentName: one(row.departments)?.department_name ?? "(unknown)",
    workItemCode: one(row.work_items)?.line_item_no ?? "",
    workItemDescription: one(row.work_items)?.description_of_work ?? "",
    submittedProgress,
    submittedQuantity,
    unit,
    reviewStatusCode,
    reviewStatusLabel: humanizeWorkerSubmissionStatus(reviewStatusCode),
    description:
      validation?.original_data?.description ??
      structured?.description ??
      row.raw_input_text ??
      "",
    validationId: validation?.user_validations_id ?? null,
    correctedProgress,
    comments: validation?.comments ?? null,
    approvalComments: validation?.approval_comments ?? null,
    approvalStatus: validation?.approval_status ?? null,
    scheduledValue,
    estimatedAmount: calculateEstimatedAmount(scheduledValue, displayedProgress),
    isCompleted: cumulativeIsCompleted ?? isWorkItemComplete(displayedProgress),
  };
}

const SUBMISSION_SELECT =
  "extraction_submission_id, structured_output, raw_input_text, created_at, project_id, department_id, work_item_id, users(user_mail, first_name, last_name), projects(project_name), departments(department_name), work_items(line_item_no, description_of_work, scheduled_value, planned_quantity)";

/**
 * Submissions with no user_validations row yet — the Foreman's queue.
 *
 * extraction_submissions is also written by the separate Extraction
 * Accuracy Test pipeline (/api/handwritten|voice|text), which uses
 * submission_status 'PENDING_REVIEW'/'REJECTED' and never 'SUBMITTED'.
 * Filtering to 'SUBMITTED' keeps that pre-existing, unrelated usage of
 * the same table out of the Foreman's queue.
 */
export async function listForemanQueue(
  supabase: SupabaseClient,
  foremanUserId: string
): Promise<QueueItem[]> {
  const ctx = await getUserContext(supabase, foremanUserId);

  const { data: submissions, error } = await supabase
    .from("extraction_submissions")
    .select(SUBMISSION_SELECT)
    .eq("department_id", ctx.departmentId)
    .eq("submission_status", "SUBMITTED")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load submissions: ${error.message}`);
  }

  const { data: validations, error: valError } = await supabase
    .from("user_validations")
    .select("submission_id");

  if (valError) {
    throw new Error(`Failed to load validations: ${valError.message}`);
  }

  const validatedIds = new Set((validations ?? []).map((v) => v.submission_id));

  return ((submissions ?? []) as SubmissionRow[])
    .filter((row) => !validatedIds.has(row.extraction_submission_id))
    .map((row) => toQueueItem(row, null));
}

/**
 * Every individual submission actually created within [bounds] for a
 * department — one row per submission, never collapsed to "one current
 * record per work item" (unlike getCurrentWorkItemRecords) and never
 * padded out with every Active work item that had no activity. Powers
 * "Today's Progress" / "Yesterday" on the Supervisor dashboard: if
 * nothing was submitted on that date, this returns an empty list
 * rather than every work item showing "—". Same 'SUBMITTED' filter as
 * listForemanQueue, for the same reason (excludes the separate
 * Extraction Accuracy Test pipeline's rows).
 */
async function listSubmissionsForDateRange(
  supabase: SupabaseClient,
  departmentId: string,
  bounds: { from: string; to: string }
): Promise<QueueItem[]> {
  const { data: submissions, error } = await supabase
    .from("extraction_submissions")
    .select(SUBMISSION_SELECT)
    .eq("department_id", departmentId)
    .eq("submission_status", "SUBMITTED")
    .gte("created_at", `${bounds.from}T00:00:00`)
    .lte("created_at", `${bounds.to}T23:59:59`)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load submissions: ${error.message}`);
  }
  if (!submissions || submissions.length === 0) return [];

  const { data: validations, error: valError } = await supabase
    .from("user_validations")
    .select(
      "user_validations_id, submission_id, original_data, corrected_data, comments, approval_comments, approval_status"
    )
    .in(
      "submission_id",
      submissions.map((s) => s.extraction_submission_id)
    );

  if (valError) {
    throw new Error(`Failed to load validations: ${valError.message}`);
  }

  const validationBySubmission = new Map(
    (validations ?? []).map((v) => [v.submission_id, v])
  );

  return (submissions as SubmissionRow[]).map((row) =>
    toQueueItem(row, validationBySubmission.get(row.extraction_submission_id) ?? null)
  );
}

/**
 * department_id of the extraction_submissions row a submission id
 * points to — the ownership check every Foreman/Supervisor write action
 * below runs before touching anything, so a caller scoped to one
 * department (via their own Active user_project_roles row) can never
 * act on another department's submission/validation through a crafted
 * id, even though the id itself carries no department information a
 * client could be trusted to supply correctly. Mirrors the same
 * department-ownership check resolveWorkItemForWorker already does for
 * Workers.
 */
async function getSubmissionDepartmentId(
  supabase: SupabaseClient,
  submissionId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("extraction_submissions")
    .select("department_id")
    .eq("extraction_submission_id", submissionId)
    .single();

  if (error || !data) {
    throw new Error(`Submission not found: ${error?.message ?? submissionId}`);
  }
  return data.department_id;
}

/** Same check, starting from a user_validations id instead of a
 * submission id (validation -> submission -> department). */
async function getValidationDepartmentId(
  supabase: SupabaseClient,
  validationId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("user_validations")
    .select("submission_id")
    .eq("user_validations_id", validationId)
    .single();

  if (error || !data) {
    throw new Error(`Validation not found: ${error?.message ?? validationId}`);
  }
  return getSubmissionDepartmentId(supabase, data.submission_id);
}

async function assertSubmissionInDepartment(
  supabase: SupabaseClient,
  submissionId: string,
  departmentId: string
): Promise<void> {
  const actual = await getSubmissionDepartmentId(supabase, submissionId);
  if (actual !== departmentId) {
    throw new Error(`Submission ${submissionId} is not in department ${departmentId}`);
  }
}

async function assertValidationInDepartment(
  supabase: SupabaseClient,
  validationId: string,
  departmentId: string
): Promise<void> {
  const actual = await getValidationDepartmentId(supabase, validationId);
  if (actual !== departmentId) {
    throw new Error(`Validation ${validationId} is not in department ${departmentId}`);
  }
}

/** Same purpose as getSubmissionDepartmentId/getValidationDepartmentId
 * above, but returning project_id alongside department_id — the
 * delegation scope check (assertCanReviewProgress) needs both, since
 * hasDelegatedPermission matches on project_id first. Additive: the
 * Foreman-only helpers above are untouched and still used exactly as
 * before by foremanForwardSubmission/foremanAddComment. */
async function getSubmissionScope(
  supabase: SupabaseClient,
  submissionId: string
): Promise<{ projectId: string; departmentId: string }> {
  const { data, error } = await supabase
    .from("extraction_submissions")
    .select("project_id, department_id")
    .eq("extraction_submission_id", submissionId)
    .single();

  if (error || !data) {
    throw new Error(`Submission not found: ${error?.message ?? submissionId}`);
  }
  return { projectId: data.project_id, departmentId: data.department_id };
}

/** Same, starting from a user_validations id. */
async function getValidationScope(
  supabase: SupabaseClient,
  validationId: string
): Promise<{ projectId: string; departmentId: string }> {
  const { data, error } = await supabase
    .from("user_validations")
    .select("submission_id")
    .eq("user_validations_id", validationId)
    .single();

  if (error || !data) {
    throw new Error(`Validation not found: ${error?.message ?? validationId}`);
  }
  return getSubmissionScope(supabase, data.submission_id);
}

/**
 * Authorizes a caller to review progress (edit/comment/approve/
 * rollback, or list the review queue) for `scope`:
 *   - ADMIN always;
 *   - a Contractor (SUPERVISOR/MANAGER) whose own department matches
 *     scope.departmentId — the normal, un-delegated case, unchanged
 *     from before this permission existed;
 *   - a Contractor holding an active PROGRESS_REVIEW delegation
 *     covering scope.projectId/departmentId — the temporary Admin ->
 *     Contractor handoff, never a standing right.
 * Throws otherwise. Mirrors assertCanManageAssignments (the
 * WORKER_ASSIGNMENT equivalent) exactly, including checking
 * isAdminUser before ever calling getUserContext (a bootstrap-created
 * Admin has no user_project_roles row — see isAdminUser's doc).
 */
async function assertCanReviewProgress(
  supabase: SupabaseClient,
  callerUserId: string,
  scope: { projectId: string; departmentId: string }
): Promise<void> {
  if (await isAdminUser(supabase, callerUserId)) return;

  const ctx = await getUserContext(supabase, callerUserId);

  if (CONTRACTOR_ROLES.includes(ctx.role) && ctx.departmentId === scope.departmentId) {
    return;
  }

  if (CONTRACTOR_ROLES.includes(ctx.role)) {
    const delegated = await hasDelegatedPermission(supabase, callerUserId, "PROGRESS_REVIEW", scope);
    if (delegated) return;
  }

  throw new Error(
    `${ctx.role} ${callerUserId} is not authorized to review progress for department ${scope.departmentId}`
  );
}

// assertRole moved to ./authContext (see above); re-exported for
// existing callers. SUPERVISOR/MANAGER-role checks for Contractor
// actions now go through assertCanManageAssignments/
// assertCanReviewProgress (own-department OR delegated), not a bare
// assertRole(SUPERVISOR_ROLES) — see those functions.
export { assertRole };

export async function foremanForwardSubmission(
  supabase: SupabaseClient,
  params: {
    submissionId: string;
    foremanUserId: string;
    progressPercentage?: number;
    description?: string;
    comment?: string;
  }
): Promise<void> {
  const ctx = await getUserContext(supabase, params.foremanUserId);
  assertRole(ctx.role, ["FOREMAN"]);
  await assertSubmissionInDepartment(supabase, params.submissionId, ctx.departmentId);

  const { data: submission, error: fetchError } = await supabase
    .from("extraction_submissions")
    .select("structured_output, raw_input_text, work_item_id, worker_id")
    .eq("extraction_submission_id", params.submissionId)
    .single();

  if (fetchError || !submission) {
    throw new Error(
      `Submission not found: ${fetchError?.message ?? params.submissionId}`
    );
  }

  const base = submission.structured_output as ProgressData | null;
  const progressPercentage = params.progressPercentage ?? base?.progress_percentage ?? 0;
  const originalSubmittedPercentage = base?.progress_percentage ?? null;

  // Recompute completed_quantity from the (possibly corrected) percentage
  // rather than blindly carrying forward the Worker's original quantity —
  // otherwise a Foreman correcting the percentage without also touching
  // the quantity leaves MTD (which sums quantity, not percentage) reading
  // the pre-correction value. Null on percentage-only legacy work items
  // (no planned_quantity configured), same as before.
  const workItem = await getWorkItemById(supabase, submission.work_item_id);
  const recalculatedQuantity = calculateCompletedQuantity(
    progressPercentage,
    workItem.planned_quantity
  );

  const originalData: ProgressData = {
    description:
      params.description ?? base?.description ?? submission.raw_input_text ?? "",
    progress_percentage: progressPercentage,
    completed_quantity: recalculatedQuantity ?? base?.completed_quantity ?? null,
    unit: recalculatedQuantity !== null ? workItem.unit_of_measure : base?.unit ?? null,
  };

  const { error } = await supabase.from("user_validations").insert({
    submission_id: params.submissionId,
    user_id: params.foremanUserId,
    validation_status: "VALIDATED",
    original_data: originalData,
    comments: params.comment ?? null,
    validated_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to forward submission: ${error.message}`);
  }

  // Notify the worker only when the Subcontractor actually changed the
  // percentage before forwarding — a plain forward (or comment-only
  // forward) of the worker's own value is not a "change" and must not
  // notify (see lib/notifications.ts module doc). Nothing is approved
  // yet at this stage, so this reads as "progress", never "approved
  // progress".
  if (originalSubmittedPercentage !== null && progressPercentage !== originalSubmittedPercentage) {
    const [reviewerName, notifCtx] = await Promise.all([
      getUserDisplayName(supabase, params.foremanUserId),
      getProgressNotificationContext(supabase, {
        projectId: ctx.projectId,
        departmentId: ctx.departmentId,
        workItemId: submission.work_item_id,
      }),
    ]);

    await createProgressNotification(supabase, {
      recipientUserId: submission.worker_id,
      type: "PROGRESS_CHANGED",
      projectId: ctx.projectId,
      projectName: notifCtx.projectName,
      departmentId: ctx.departmentId,
      departmentName: notifCtx.departmentName,
      workItemId: submission.work_item_id,
      workItemDescription: notifCtx.workItemDescription,
      submissionId: params.submissionId,
      submittedProgress: originalSubmittedPercentage,
      previousApprovedProgress: null,
      newApprovedProgress: progressPercentage,
      reviewerUserId: params.foremanUserId,
      reviewerRole: "FOREMAN",
      reviewerName,
      remarks: params.comment ?? null,
      progressNoun: "progress",
    });
  }

  // Tell the next-level reviewer(s) — every Active Supervisor/Manager
  // in this department — that a forwarded submission is now waiting
  // for their approval, AND tell the originating Worker that their
  // submission moved forward. Both fire unconditionally on every
  // forward (unlike the Worker-facing notify-on-change block above,
  // which only fires when the Foreman actually edited the percentage):
  // a forward always moves the submission out of the Foreman's queue
  // and into the Supervisor's, so both sides always need to know,
  // whether or not anything was changed. foremanName/forwardNotifCtx
  // are computed once, unconditionally, and reused by both
  // notifications below rather than duplicated per recipient.
  const foremanName = await getUserDisplayName(supabase, params.foremanUserId);
  const forwardNotifCtx = await getProgressNotificationContext(supabase, {
    projectId: ctx.projectId,
    departmentId: ctx.departmentId,
    workItemId: submission.work_item_id,
  });

  // Worker-facing: the ORIGINAL SUBMITTER (submission.worker_id, never
  // params.foremanUserId — the currently-acting Foreman is the actor,
  // not the recipient), reusing the same SUBMISSION_FORWARDED event
  // type as the reviewer-facing notification below rather than adding
  // a new one. One row per forward action (this function only ever
  // runs once per submission — a forwarded submission leaves
  // listForemanQueue for good, see its validatedIds filter — so this
  // can never double-fire for the same forward).
  await createProgressNotification(supabase, {
    recipientUserId: submission.worker_id,
    type: "SUBMISSION_FORWARDED",
    projectId: ctx.projectId,
    projectName: forwardNotifCtx.projectName,
    departmentId: ctx.departmentId,
    departmentName: forwardNotifCtx.departmentName,
    workItemId: submission.work_item_id,
    workItemDescription: forwardNotifCtx.workItemDescription,
    submissionId: params.submissionId,
    submittedProgress: progressPercentage,
    previousApprovedProgress: null,
    newApprovedProgress: null,
    reviewerUserId: params.foremanUserId,
    reviewerRole: "FOREMAN",
    reviewerName: foremanName,
    remarks: params.comment ?? null,
    progressNoun: "progress",
  });

  const supervisorIds = await listDepartmentReviewers(supabase, ctx.projectId, ctx.departmentId, CONTRACTOR_ROLES);
  if (supervisorIds.length > 0) {
    await createReviewerNotification(supabase, {
      recipientUserIds: supervisorIds,
      type: "SUBMISSION_FORWARDED",
      projectId: ctx.projectId,
      projectName: forwardNotifCtx.projectName,
      departmentId: ctx.departmentId,
      departmentName: forwardNotifCtx.departmentName,
      workItemId: submission.work_item_id,
      workItemDescription: forwardNotifCtx.workItemDescription,
      submittedProgress: progressPercentage,
      actorUserId: params.foremanUserId,
      actorRole: "FOREMAN",
      actorName: foremanName,
      remarks: params.comment ?? null,
    });
  }
}

export async function foremanAddComment(
  supabase: SupabaseClient,
  params: { validationId: string; comment: string; foremanUserId: string }
): Promise<void> {
  const ctx = await getUserContext(supabase, params.foremanUserId);
  assertRole(ctx.role, ["FOREMAN"]);
  await assertValidationInDepartment(supabase, params.validationId, ctx.departmentId);

  const { error } = await supabase
    .from("user_validations")
    .update({ comments: params.comment })
    .eq("user_validations_id", params.validationId);

  if (error) {
    throw new Error(`Failed to add comment: ${error.message}`);
  }
}

// ------------------------------------------------------------------
// Foreman: work-item assignment management (Subcontractor assigns
// Work Items to Workers in their own department — see
// work_item_assignments, and the Worker-side read of it in
// listAssignedWorkItemsForWorker/resolveWorkItemForWorker above, which
// this writes to and is otherwise unchanged).
// ------------------------------------------------------------------

export type DepartmentWorker = {
  userId: string;
  email: string;
  displayName: string;
};

/** Active WORKER-role users in one department/project — the Subcontractor's
 * assignment picker. Scoped the same way getUserContext scopes everything
 * else (Active user_project_roles row), so a Removed worker assignment
 * can't be targeted. */
async function listDepartmentWorkers(
  supabase: SupabaseClient,
  departmentId: string,
  projectId: string
): Promise<DepartmentWorker[]> {
  const { data, error } = await supabase
    .from("user_project_roles")
    .select("user_id, users(user_mail, first_name, last_name)")
    .eq("department_id", departmentId)
    .eq("project_id", projectId)
    .eq("role", "WORKER")
    .eq("status", "Active");

  if (error) {
    throw new Error(`Failed to load department workers: ${error.message}`);
  }

  type UserRow = { user_mail: string; first_name: string | null; last_name: string | null };
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  return (data ?? []).map((row) => {
    const u = one(row.users as UserRow | UserRow[] | null);
    return {
      userId: row.user_id as string,
      email: u?.user_mail ?? "(unknown)",
      displayName: u
        ? formatUserDisplayName({ firstName: u.first_name, lastName: u.last_name, email: u.user_mail })
        : "(unknown)",
    };
  });
}

export type WorkItemAssignmentView = {
  workItemId: string;
  workItemCode: string;
  workItemDescription: string;
  userId: string;
  workerDisplayName: string;
  workerEmail: string;
};

/** Every Active work_item_assignments row for a department, joined for
 * display — the Subcontractor's "currently assigned" list. */
async function listWorkItemAssignmentsForDepartment(
  supabase: SupabaseClient,
  departmentId: string
): Promise<WorkItemAssignmentView[]> {
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("work_item_assignments")
    .select(
      `work_item_id, user_id, work_items!inner(line_item_no, description_of_work, department_id), users(user_mail, first_name, last_name)`
    )
    .eq("status", "Active")
    .eq("work_items.department_id", departmentId);

  if (error) {
    throw new Error(`Failed to load work item assignments: ${error.message}`);
  }

  type WorkItemRow = { line_item_no: string; description_of_work: string; department_id: string };
  type UserRow = { user_mail: string; first_name: string | null; last_name: string | null };
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  return (data ?? []).map((row) => {
    const w = one(row.work_items as WorkItemRow | WorkItemRow[] | null);
    const u = one(row.users as UserRow | UserRow[] | null);
    return {
      workItemId: row.work_item_id as string,
      workItemCode: w?.line_item_no ?? "",
      workItemDescription: w?.description_of_work ?? "",
      userId: row.user_id as string,
      workerDisplayName: u
        ? formatUserDisplayName({ firstName: u.first_name, lastName: u.last_name, email: u.user_mail })
        : "(unknown)",
      workerEmail: u?.user_mail ?? "(unknown)",
    };
  });
}

export type ForemanAssignmentBoard = {
  departmentName: string;
  workers: DepartmentWorker[];
  workItems: WorkItemOption[];
  assignments: WorkItemAssignmentView[];
};

/** Everything the Subcontractor's assignment-management page needs, in
 * one call: their own department's workers, work items, and current
 * assignments. Requires the caller to actually be a Subcontractor
 * (FOREMAN) — the same role check every other Foreman action uses. */
export async function getForemanAssignmentBoard(
  supabase: SupabaseClient,
  subcontractorUserId: string
): Promise<ForemanAssignmentBoard> {
  const ctx = await getUserContext(supabase, subcontractorUserId);
  assertRole(ctx.role, ["FOREMAN"]);

  const [workers, workItems, assignments] = await Promise.all([
    listDepartmentWorkers(supabase, ctx.departmentId, ctx.projectId),
    listWorkItemsForDepartment(supabase, ctx.departmentId),
    listWorkItemAssignmentsForDepartment(supabase, ctx.departmentId),
  ]);

  return { departmentName: ctx.departmentName, workers, workItems, assignments };
}

/**
 * Same board as getForemanAssignmentBoard, for a Contractor
 * (SUPERVISOR/MANAGER) acting under an active WORKER_ASSIGNMENT
 * delegation instead of being the department's own Subcontractor.
 * Unlike getForemanAssignmentBoard (which always uses the caller's own
 * ctx.departmentId/ctx.projectId), the department/project here are
 * explicit parameters — a delegated Contractor's own home department
 * can be a different one entirely — and are checked against the
 * delegation's scope, never trusted from the caller alone. Throws if
 * no matching active delegation exists.
 */
export async function getDelegatedAssignmentBoard(
  supabase: SupabaseClient,
  params: { contractorUserId: string; projectId: string; departmentId: string }
): Promise<ForemanAssignmentBoard> {
  const ctx = await getUserContext(supabase, params.contractorUserId);
  assertRole(ctx.role, CONTRACTOR_ROLES);

  const allowed = await hasDelegatedPermission(supabase, params.contractorUserId, "WORKER_ASSIGNMENT", {
    projectId: params.projectId,
    departmentId: params.departmentId,
  });
  if (!allowed) {
    throw new Error(
      `${ctx.userId} has no active Worker Assignment delegation for department ${params.departmentId}`
    );
  }

  const { data: deptRow, error } = await supabase
    .from("departments")
    .select("department_name")
    .eq("department_id", params.departmentId)
    .single();
  if (error || !deptRow) {
    throw new Error(`Department not found: ${error?.message ?? params.departmentId}`);
  }

  const [workers, workItems, assignments] = await Promise.all([
    listDepartmentWorkers(supabase, params.departmentId, params.projectId),
    listWorkItemsForDepartment(supabase, params.departmentId),
    listWorkItemAssignmentsForDepartment(supabase, params.departmentId),
  ]);

  return { departmentName: deptRow.department_name as string, workers, workItems, assignments };
}

/**
 * Same review queue as listSupervisorQueue, for a Contractor acting
 * under an active PROGRESS_REVIEW delegation instead of reviewing
 * their own department. Like getDelegatedAssignmentBoard, the
 * department/project are explicit parameters (never the caller's own
 * ctx), checked against the delegation's scope before anything is
 * returned. Reuses getCurrentWorkItemRecords — the exact same query
 * listSupervisorQueue itself calls for the normal case — so a
 * delegated review queue can never disagree with what an actual
 * department Contractor would see for that department.
 */
export async function getDelegatedProgressReviewQueue(
  supabase: SupabaseClient,
  params: { contractorUserId: string; projectId: string; departmentId: string }
): Promise<QueueItem[]> {
  const ctx = await getUserContext(supabase, params.contractorUserId);
  assertRole(ctx.role, CONTRACTOR_ROLES);

  const allowed = await hasDelegatedPermission(supabase, params.contractorUserId, "PROGRESS_REVIEW", {
    projectId: params.projectId,
    departmentId: params.departmentId,
  });
  if (!allowed) {
    throw new Error(
      `${ctx.userId} has no active Progress Review delegation for department ${params.departmentId}`
    );
  }

  return getCurrentWorkItemRecords(supabase, params.departmentId);
}

/**
 * Authorizes a caller to manage work_item_assignments for `workItem`:
 *   - ADMIN always (project-wide, per the app's role hierarchy);
 *   - a Subcontractor (FOREMAN) whose own department owns the work item;
 *   - a Contractor (SUPERVISOR/MANAGER) holding an active
 *     WORKER_ASSIGNMENT delegation covering the work item's
 *     project/department (see lib/delegation.ts) — the temporary
 *     Admin -> Contractor handoff, never a standing Contractor right.
 * Throws otherwise. Shared by assignWorkItemToWorker and
 * removeWorkItemAssignment so the two can never disagree about who's
 * allowed to touch an assignment.
 */
async function assertCanManageAssignments(
  supabase: SupabaseClient,
  callerUserId: string,
  workItem: WorkItemRecord
): Promise<void> {
  // Checked before getUserContext, not after: Admin identity comes from
  // users.user_role directly (isAdminUser), never from
  // user_project_roles — an Admin created via the original bootstrap
  // flow has no user_project_roles row at all, so calling
  // getUserContext for the caller first would throw for exactly that
  // account before this function ever got a chance to recognize it as
  // Admin (see isAdminUser's doc in lib/authContext.ts).
  if (await isAdminUser(supabase, callerUserId)) return;

  const callerCtx = await getUserContext(supabase, callerUserId);

  if (callerCtx.role === "FOREMAN" && workItem.department_id === callerCtx.departmentId) {
    return;
  }

  if (CONTRACTOR_ROLES.includes(callerCtx.role)) {
    const delegated = await hasDelegatedPermission(
      supabase,
      callerCtx.userId,
      "WORKER_ASSIGNMENT",
      { projectId: workItem.project_id, departmentId: workItem.department_id }
    );
    if (delegated) return;
  }

  throw new Error(
    `${callerCtx.role} ${callerCtx.userId} is not authorized to manage assignments for work item ${workItem.work_item_id}`
  );
}

/**
 * Assigns a Work Item to a Worker — the write side of
 * work_item_assignments (Worker-side reads are in
 * listAssignedWorkItemsForWorker/resolveWorkItemForWorker, unchanged).
 * Upserts on the (work_item_id, user_id) primary key so re-assigning
 * after a prior removal reactivates the same row instead of erroring on
 * a duplicate key or leaving two rows for the same pair.
 *
 * Every dimension of the business rule is checked server-side, not just
 * offered by the UI: caller must be authorized (Admin, the work item's
 * own Subcontractor, or a delegated Contractor — see
 * assertCanManageAssignments), and the worker must be an Active WORKER
 * in the *work item's* department AND project — never the caller's own
 * (a delegated Contractor's home department can differ from the
 * delegated one) — so a caller can never reach across departments or
 * assign to a non-Worker by crafting the request directly.
 */
export async function assignWorkItemToWorker(
  supabase: SupabaseClient,
  params: { subcontractorUserId: string; workItemId: string; workerUserId: string }
): Promise<void> {
  const workItem = await getWorkItemById(supabase, params.workItemId);
  await assertCanManageAssignments(supabase, params.subcontractorUserId, workItem);

  const workerCtx = await getUserContext(supabase, params.workerUserId);
  if (workerCtx.role !== "WORKER") {
    throw new Error(`User ${params.workerUserId} is not a Worker`);
  }
  if (workerCtx.departmentId !== workItem.department_id || workerCtx.projectId !== workItem.project_id) {
    throw new Error(
      `Worker ${params.workerUserId} is not in department ${workItem.department_id}`
    );
  }

  // Existence/role/scope checks above stay on the caller-supplied
  // `supabase` (work_items/user_project_roles, not in the 8-table
  // service-role-only set); the write itself is to work_item_assignments,
  // one of those 8 — see the P0 audit.
  const { error } = await getSupabaseServiceRoleClient().from("work_item_assignments").upsert(
    {
      work_item_id: params.workItemId,
      user_id: params.workerUserId,
      status: "Active",
      assigned_at: new Date().toISOString(),
    },
    { onConflict: "work_item_id,user_id" }
  );

  if (error) {
    throw new Error(`Failed to assign work item: ${error.message}`);
  }
}

/**
 * Removes (soft: status -> 'Removed', matching every other status field
 * in this schema) a Worker's assignment to a Work Item. Same
 * authorization as assignWorkItemToWorker (see
 * assertCanManageAssignments) — Admin, the work item's own
 * Subcontractor, or a delegated Contractor.
 */
export async function removeWorkItemAssignment(
  supabase: SupabaseClient,
  params: { subcontractorUserId: string; workItemId: string; workerUserId: string }
): Promise<void> {
  const workItem = await getWorkItemById(supabase, params.workItemId);
  await assertCanManageAssignments(supabase, params.subcontractorUserId, workItem);

  const { error } = await getSupabaseServiceRoleClient()
    .from("work_item_assignments")
    .update({ status: "Removed" })
    .eq("work_item_id", params.workItemId)
    .eq("user_id", params.workerUserId);

  if (error) {
    throw new Error(`Failed to remove assignment: ${error.message}`);
  }
}

/**
 * Edits Planned Quantity (+ Unit of Measure) for one work item —
 * Requirement: an appropriate higher-level user should be able to make
 * this specific, routine change without going through Admin every
 * time, while Worker must never be able to touch it at all.
 *
 * Authorized: ADMIN (any work item), or the work item's own
 * Subcontractor (FOREMAN)/Contractor (SUPERVISOR/MANAGER) — scoped to
 * their own department, no delegation needed for this (see module
 * doc). A Contractor acting *outside* their own department needs an
 * explicit PLANNED_QUANTITY_MANAGEMENT delegation, same as every other
 * cross-department admin capability in this app.
 */
export async function updatePlannedQuantity(
  supabase: SupabaseClient,
  params: {
    actorUserId: string;
    workItemId: string;
    plannedQuantity: number | null;
    unitOfMeasure?: string | null;
  }
): Promise<void> {
  const workItem = await getWorkItemById(supabase, params.workItemId);

  // isAdminUser first, not getUserContext — see assertCanManageAssignments
  // above for why (a bootstrap-created Admin has no user_project_roles row).
  if (!(await isAdminUser(supabase, params.actorUserId))) {
    const ctx = await getUserContext(supabase, params.actorUserId);

    const ownDepartment =
      (ctx.role === "FOREMAN" || CONTRACTOR_ROLES.includes(ctx.role)) &&
      workItem.department_id === ctx.departmentId;

    const authorized =
      ownDepartment ||
      (CONTRACTOR_ROLES.includes(ctx.role) &&
        (await hasDelegatedPermission(supabase, ctx.userId, "PLANNED_QUANTITY_MANAGEMENT", {
          projectId: workItem.project_id,
          departmentId: workItem.department_id,
        })));

    if (!authorized) {
      throw new Error(
        `${ctx.role} ${ctx.userId} is not authorized to edit Planned Quantity for work item ${params.workItemId}`
      );
    }
  }

  await updateWorkItemValues(supabase, params.workItemId, {
    plannedQuantity: params.plannedQuantity,
    ...(params.unitOfMeasure !== undefined ? { unitOfMeasure: params.unitOfMeasure } : {}),
  });
}

// ------------------------------------------------------------------
// Supervisor
// ------------------------------------------------------------------

/**
 * Every work_items row for a department (not submissions) — the real
 * count of distinct pieces of planned construction work.
 */
async function getWorkItemsForDepartment(
  supabase: SupabaseClient,
  departmentId: string
): Promise<{ work_item_id: string }[]> {
  const { data, error } = await supabase
    .from("work_items")
    .select("work_item_id")
    .eq("department_id", departmentId)
    .eq("status", "Active");

  if (error) {
    throw new Error(`Failed to load work items: ${error.message}`);
  }
  return data ?? [];
}

/**
 * ONE current record per work item — never one card per historical
 * submission. A work item can accumulate many forwarded submissions
 * over time (edited, rolled back, re-submitted); this collapses each
 * work item down to a single "current" record so the Supervisor sees
 * a work summary, not a submission history:
 *   - if the work item has a submission still awaiting Supervisor
 *     action (approval_status IS NULL), that is the current record;
 *   - otherwise the single most recently validated record (approved
 *     or rolled back) is the current record.
 * Shared by listSupervisorQueue (Tab 1 cards) and getWorkSummary
 * (Tab 2 status counts) so both tabs agree with each other and
 * neither counts raw historical submissions. Exported so the
 * Subcontractor's own dashboard can show "Awaiting Contractor Review"
 * (items with reviewStatusCode === "AWAITING_SUPERVISOR_APPROVAL" in
 * their own department) — the exact same records the Contractor's
 * queue is built from, filtered client-side by the caller, never a
 * second/different query or calculation.
 */
export async function getCurrentWorkItemRecords(
  supabase: SupabaseClient,
  departmentId: string
): Promise<QueueItem[]> {
  const { data: validations, error: valError } = await supabase
    .from("user_validations")
    .select(
      "user_validations_id, submission_id, original_data, corrected_data, comments, approval_comments, approval_status, validated_at"
    );

  if (valError) {
    throw new Error(`Failed to load validations: ${valError.message}`);
  }
  if (!validations || validations.length === 0) return [];

  const { data: submissions, error } = await supabase
    .from("extraction_submissions")
    .select(SUBMISSION_SELECT)
    .eq("department_id", departmentId)
    .in(
      "extraction_submission_id",
      validations.map((v) => v.submission_id)
    );

  if (error) {
    throw new Error(`Failed to load submissions: ${error.message}`);
  }

  const validationBySubmission = new Map(
    validations.map((v) => [v.submission_id, v])
  );

  const byWorkItem = new Map<
    string,
    { row: SubmissionRow; validation: (typeof validations)[number] }[]
  >();

  for (const row of (submissions ?? []) as SubmissionRow[]) {
    const validation = validationBySubmission.get(row.extraction_submission_id);
    if (!validation) continue;
    const list = byWorkItem.get(row.work_item_id) ?? [];
    list.push({ row, validation });
    byWorkItem.set(row.work_item_id, list);
  }

  const results = await Promise.all(
    Array.from(byWorkItem.entries()).map(async ([workItemId, entries]) => {
      const pending = entries.filter((e) => e.validation.approval_status === null);
      const pool = pending.length > 0 ? pending : entries;

      pool.sort((a, b) => {
        const aTime = a.validation.validated_at
          ? new Date(a.validation.validated_at).getTime()
          : 0;
        const bTime = b.validation.validated_at
          ? new Date(b.validation.validated_at).getTime()
          : 0;
        return bTime - aTime;
      });

      const winner = pool[0];
      const plannedQuantity = one(winner.row.work_items)?.planned_quantity ?? null;
      const status = await getWorkItemCurrentStatus(supabase, workItemId, plannedQuantity);
      return toQueueItem(winner.row, winner.validation, status.isCompleted);
    })
  );

  return results;
}

/**
 * The Supervisor's "Today's Work" list — one current record per work
 * item (see getCurrentWorkItemRecords), not one per historical
 * submission.
 */
export async function listSupervisorQueue(
  supabase: SupabaseClient,
  supervisorUserId: string
): Promise<QueueItem[]> {
  const ctx = await getUserContext(supabase, supervisorUserId);
  return getCurrentWorkItemRecords(supabase, ctx.departmentId);
}

export async function supervisorEditSubmission(
  supabase: SupabaseClient,
  params: {
    validationId: string;
    progressPercentage: number;
    description?: string;
    comment?: string;
    supervisorUserId: string;
  }
): Promise<void> {
  const editScope = await getValidationScope(supabase, params.validationId);
  await assertCanReviewProgress(supabase, params.supervisorUserId, editScope);

  const { data: validation, error: fetchError } = await supabase
    .from("user_validations")
    .select("original_data, corrected_data, submission_id")
    .eq("user_validations_id", params.validationId)
    .single();

  if (fetchError || !validation) {
    throw new Error(
      `Validation not found: ${fetchError?.message ?? params.validationId}`
    );
  }

  const base =
    (validation.corrected_data as ProgressData | null) ??
    (validation.original_data as ProgressData | null);

  // Same recompute as foremanForwardSubmission above — a Contractor
  // correction must keep completed_quantity consistent with the
  // corrected percentage, not the Worker's/Foreman's original quantity.
  const { data: submissionForEdit, error: submissionForEditError } = await supabase
    .from("extraction_submissions")
    .select("work_item_id, worker_id, project_id, department_id")
    .eq("extraction_submission_id", validation.submission_id)
    .single();

  if (submissionForEditError || !submissionForEdit) {
    throw new Error(
      `Submission not found: ${submissionForEditError?.message ?? validation.submission_id}`
    );
  }

  const workItemForEdit = await getWorkItemById(supabase, submissionForEdit.work_item_id);
  const recalculatedQuantityForEdit = calculateCompletedQuantity(
    params.progressPercentage,
    workItemForEdit.planned_quantity
  );

  const correctedData: ProgressData = {
    description: params.description ?? base?.description ?? "",
    progress_percentage: params.progressPercentage,
    completed_quantity: recalculatedQuantityForEdit ?? base?.completed_quantity ?? null,
    unit:
      recalculatedQuantityForEdit !== null
        ? workItemForEdit.unit_of_measure
        : base?.unit ?? null,
  };

  const { error } = await supabase
    .from("user_validations")
    .update({
      corrected_data: correctedData,
      comments: params.comment ?? undefined,
      validated_at: new Date().toISOString(),
    })
    .eq("user_validations_id", params.validationId);

  if (error) {
    throw new Error(`Failed to save correction: ${error.message}`);
  }

  // If this submission is already approved, the correction must be
  // reflected immediately in the accepted record — never leave the
  // stale pre-correction value displayed as Today's/MTD Progress.
  const { data: unified, error: unifiedFetchError } = await supabase
    .from("unified_records")
    .select("unified_record_id, status, accepted_data")
    .eq("user_validation_id", params.validationId)
    .maybeSingle();

  if (unifiedFetchError) {
    throw new Error(
      `Failed to look up approved record: ${unifiedFetchError.message}`
    );
  }

  if (unified && unified.status === "APPROVED") {
    const previousApprovedProgress =
      (unified.accepted_data as ProgressData | null)?.progress_percentage ?? null;

    const { error: updateUnifiedError } = await supabase
      .from("unified_records")
      .update({
        accepted_data: correctedData,
        accepted_quantity: correctedData.completed_quantity,
        accepted_unit: correctedData.unit,
      })
      .eq("unified_record_id", unified.unified_record_id);

    if (updateUnifiedError) {
      throw new Error(
        `Failed to update approved record: ${updateUnifiedError.message}`
      );
    }

    // Already-approved progress just changed again (e.g. 70% -> 80%) —
    // the worker must be notified a second time, per the spec's exact
    // "later changed from 70% to 80%" scenario. Skipped entirely when
    // the correction doesn't actually move the approved percentage.
    if (previousApprovedProgress !== correctedData.progress_percentage) {
      const [reviewerRole, reviewerName, notifCtx] = await Promise.all([
        resolveActorRole(supabase, params.supervisorUserId),
        getUserDisplayName(supabase, params.supervisorUserId),
        getProgressNotificationContext(supabase, {
          projectId: submissionForEdit.project_id,
          departmentId: submissionForEdit.department_id,
          workItemId: submissionForEdit.work_item_id,
        }),
      ]);

      await createProgressNotification(supabase, {
        recipientUserId: submissionForEdit.worker_id,
        type: "PROGRESS_CHANGED",
        projectId: submissionForEdit.project_id,
        projectName: notifCtx.projectName,
        departmentId: submissionForEdit.department_id,
        departmentName: notifCtx.departmentName,
        workItemId: submissionForEdit.work_item_id,
        workItemDescription: notifCtx.workItemDescription,
        submissionId: validation.submission_id,
        validationId: params.validationId,
        submittedProgress:
          (validation.original_data as ProgressData | null)?.progress_percentage ?? null,
        previousApprovedProgress,
        newApprovedProgress: correctedData.progress_percentage,
        reviewerUserId: params.supervisorUserId,
        reviewerRole,
        reviewerName,
        remarks: params.comment ?? null,
      });
    }
  }
}

export async function supervisorAddComment(
  supabase: SupabaseClient,
  params: { validationId: string; comment: string; supervisorUserId: string }
): Promise<void> {
  const commentScope = await getValidationScope(supabase, params.validationId);
  await assertCanReviewProgress(supabase, params.supervisorUserId, commentScope);

  const { error } = await supabase
    .from("user_validations")
    .update({ approval_comments: params.comment })
    .eq("user_validations_id", params.validationId);

  if (error) {
    throw new Error(`Failed to add comment: ${error.message}`);
  }
}

export async function supervisorApprove(
  supabase: SupabaseClient,
  params: { validationId: string; supervisorUserId: string; comment?: string }
): Promise<void> {
  const { data: validation, error: fetchError } = await supabase
    .from("user_validations")
    .select("submission_id, original_data, corrected_data")
    .eq("user_validations_id", params.validationId)
    .single();

  if (fetchError || !validation) {
    throw new Error(
      `Validation not found: ${fetchError?.message ?? params.validationId}`
    );
  }

  const { data: submission, error: subError } = await supabase
    .from("extraction_submissions")
    .select("project_id, department_id, work_item_id, worker_id")
    .eq("extraction_submission_id", validation.submission_id)
    .single();

  if (subError || !submission) {
    throw new Error(
      `Submission not found: ${subError?.message ?? validation.submission_id}`
    );
  }

  await assertCanReviewProgress(supabase, params.supervisorUserId, {
    projectId: submission.project_id,
    departmentId: submission.department_id,
  });

  const acceptedData =
    (validation.corrected_data as ProgressData | null) ??
    (validation.original_data as ProgressData | null);

  // Captured before this approval writes anything, so the notification
  // can report the true "previous approved progress" (e.g. 70% -> 80%)
  // rather than a value already overwritten by this same call.
  const previousApproved = await getLatestApprovedRecord(supabase, submission.work_item_id);
  const previousApprovedProgress =
    (previousApproved?.accepted_data as ProgressData | null)?.progress_percentage ?? null;

  const now = new Date().toISOString();

  const { error: valUpdateError } = await supabase
    .from("user_validations")
    .update({
      approval_status: "APPROVED",
      approved_by: params.supervisorUserId,
      approval_comments: params.comment ?? undefined,
      approved_at: now,
    })
    .eq("user_validations_id", params.validationId);

  if (valUpdateError) {
    throw new Error(`Failed to approve: ${valUpdateError.message}`);
  }

  const { data: existingUnified, error: unifiedFetchError } = await supabase
    .from("unified_records")
    .select("unified_record_id")
    .eq("user_validation_id", params.validationId)
    .maybeSingle();

  if (unifiedFetchError) {
    throw new Error(
      `Failed to look up approved record: ${unifiedFetchError.message}`
    );
  }

  if (existingUnified) {
    // Re-approving after a rollback: update the existing row, never
    // insert a duplicate.
    const { error: updateError } = await supabase
      .from("unified_records")
      .update({
        accepted_data: acceptedData,
        accepted_quantity: acceptedData?.completed_quantity ?? null,
        accepted_unit: acceptedData?.unit ?? null,
        status: "APPROVED",
        accepted_by: params.supervisorUserId,
        accepted_at: now,
      })
      .eq("unified_record_id", existingUnified.unified_record_id);

    if (updateError) {
      throw new Error(`Failed to update approved record: ${updateError.message}`);
    }
  } else {
    const { error: insertError } = await supabase.from("unified_records").insert({
      accepted_submission_id: validation.submission_id,
      user_validation_id: params.validationId,
      project_id: submission.project_id,
      department_id: submission.department_id,
      work_item_id: submission.work_item_id,
      accepted_data: acceptedData,
      accepted_quantity: acceptedData?.completed_quantity ?? null,
      accepted_unit: acceptedData?.unit ?? null,
      status: "APPROVED",
      accepted_by: params.supervisorUserId,
      accepted_at: now,
    });

    if (insertError) {
      throw new Error(`Failed to create approved record: ${insertError.message}`);
    }
  }

  const [reviewerRole, reviewerName, notifCtx] = await Promise.all([
    resolveActorRole(supabase, params.supervisorUserId),
    getUserDisplayName(supabase, params.supervisorUserId),
    getProgressNotificationContext(supabase, {
      projectId: submission.project_id,
      departmentId: submission.department_id,
      workItemId: submission.work_item_id,
    }),
  ]);

  await createProgressNotification(supabase, {
    recipientUserId: submission.worker_id,
    type: validation.corrected_data ? "PROGRESS_APPROVED_WITH_CHANGES" : "PROGRESS_APPROVED",
    projectId: submission.project_id,
    projectName: notifCtx.projectName,
    departmentId: submission.department_id,
    departmentName: notifCtx.departmentName,
    workItemId: submission.work_item_id,
    workItemDescription: notifCtx.workItemDescription,
    submissionId: validation.submission_id,
    validationId: params.validationId,
    submittedProgress:
      (validation.original_data as ProgressData | null)?.progress_percentage ?? null,
    previousApprovedProgress,
    newApprovedProgress: acceptedData?.progress_percentage ?? null,
    reviewerUserId: params.supervisorUserId,
    reviewerRole,
    reviewerName,
    remarks: params.comment ?? null,
  });
}

export async function supervisorRollback(
  supabase: SupabaseClient,
  params: { validationId: string; supervisorUserId: string }
): Promise<void> {
  const rollbackScope = await getValidationScope(supabase, params.validationId);
  await assertCanReviewProgress(supabase, params.supervisorUserId, rollbackScope);

  const { data: validation, error: valFetchError } = await supabase
    .from("user_validations")
    .select("submission_id, original_data")
    .eq("user_validations_id", params.validationId)
    .single();

  if (valFetchError || !validation) {
    throw new Error(`Validation not found: ${valFetchError?.message ?? params.validationId}`);
  }

  const { data: submissionForRollback, error: submissionFetchError } = await supabase
    .from("extraction_submissions")
    .select("worker_id, work_item_id")
    .eq("extraction_submission_id", validation.submission_id)
    .single();

  if (submissionFetchError || !submissionForRollback) {
    throw new Error(
      `Submission not found: ${submissionFetchError?.message ?? validation.submission_id}`
    );
  }

  const { error: valUpdateError } = await supabase
    .from("user_validations")
    .update({
      approval_status: "ROLLED_BACK",
      approved_by: null,
      approved_at: null,
    })
    .eq("user_validations_id", params.validationId);

  if (valUpdateError) {
    throw new Error(`Failed to rollback: ${valUpdateError.message}`);
  }

  const { data: existingUnified, error: fetchError } = await supabase
    .from("unified_records")
    .select("unified_record_id, accepted_data")
    .eq("user_validation_id", params.validationId)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to look up approved record: ${fetchError.message}`);
  }

  if (existingUnified) {
    const { error: updateError } = await supabase
      .from("unified_records")
      .update({ status: "ROLLED_BACK" })
      .eq("unified_record_id", existingUnified.unified_record_id);

    if (updateError) {
      throw new Error(`Failed to rollback approved record: ${updateError.message}`);
    }

    // Only a previously-approved record being rolled back is a real
    // "returned for correction" event worth notifying the worker about.
    const [reviewerRole, reviewerName, notifCtx] = await Promise.all([
      resolveActorRole(supabase, params.supervisorUserId),
      getUserDisplayName(supabase, params.supervisorUserId),
      getProgressNotificationContext(supabase, {
        projectId: rollbackScope.projectId,
        departmentId: rollbackScope.departmentId,
        workItemId: submissionForRollback.work_item_id,
      }),
    ]);

    await createProgressNotification(supabase, {
      recipientUserId: submissionForRollback.worker_id,
      type: "PROGRESS_RETURNED",
      projectId: rollbackScope.projectId,
      projectName: notifCtx.projectName,
      departmentId: rollbackScope.departmentId,
      departmentName: notifCtx.departmentName,
      workItemId: submissionForRollback.work_item_id,
      workItemDescription: notifCtx.workItemDescription,
      submissionId: validation.submission_id,
      validationId: params.validationId,
      submittedProgress:
        (validation.original_data as ProgressData | null)?.progress_percentage ?? null,
      previousApprovedProgress:
        (existingUnified.accepted_data as ProgressData | null)?.progress_percentage ?? null,
      newApprovedProgress: null,
      reviewerUserId: params.supervisorUserId,
      reviewerRole,
      reviewerName,
      remarks: null,
    });
  }
}

// ------------------------------------------------------------------
// Today's / Yesterday's Progress — an activity log, not a per-work-item
// roster: only work that was actually submitted on that date shows up
// (see listSubmissionsForDateRange). A quiet day returns an empty list
// rather than every Active work item padded out with "—".
// ------------------------------------------------------------------

export async function getTodaysProgress(
  supabase: SupabaseClient,
  supervisorUserId: string
): Promise<QueueItem[]> {
  const ctx = await getUserContext(supabase, supervisorUserId);
  const today = todayISODate();
  return listSubmissionsForDateRange(supabase, ctx.departmentId, { from: today, to: today });
}

/** Same as getTodaysProgress but bounded to the previous calendar day. */
export async function getYesterdaysProgress(
  supabase: SupabaseClient,
  supervisorUserId: string
): Promise<QueueItem[]> {
  const ctx = await getUserContext(supabase, supervisorUserId);
  const yesterday = isoDateOffset(-1);
  return listSubmissionsForDateRange(supabase, ctx.departmentId, {
    from: yesterday,
    to: yesterday,
  });
}

/**
 * Same activity log as getTodaysProgress/getYesterdaysProgress — same
 * department-scoped listSubmissionsForDateRange query, just with
 * caller-supplied bounds instead of hardcoded today/yesterday. Powers
 * the Contractor's separate "History" view (older/previous submissions),
 * with no new calculation or authorization logic of its own.
 */
export async function getSubmissionHistory(
  supabase: SupabaseClient,
  supervisorUserId: string,
  bounds: { from: string; to: string }
): Promise<QueueItem[]> {
  const ctx = await getUserContext(supabase, supervisorUserId);
  return listSubmissionsForDateRange(supabase, ctx.departmentId, bounds);
}

/**
 * A single Worker's own submission history — every extraction_submissions
 * row they created (own worker_id only, not the whole department; see
 * listSubmissionsForDateRange above for the department-wide equivalent
 * used by Contractor/Subcontractor screens), each with whatever
 * approval state it currently has (see toQueueItem/reviewStatusCode).
 * Delayed approval is the whole point of this list: a submission stays
 * visible here in its "Awaiting..." state for as long as it takes to be
 * reviewed, rather than disappearing until approved.
 */
export async function getWorkerSubmissionHistory(
  supabase: SupabaseClient,
  workerUserId: string
): Promise<QueueItem[]> {
  const ctx = await getUserContext(supabase, workerUserId);
  assertRole(ctx.role, ["WORKER"]);

  const { data: submissions, error } = await supabase
    .from("extraction_submissions")
    .select(SUBMISSION_SELECT)
    .eq("worker_id", workerUserId)
    .eq("submission_status", "SUBMITTED")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load submission history: ${error.message}`);
  }
  if (!submissions || submissions.length === 0) return [];

  const { data: validations, error: valError } = await supabase
    .from("user_validations")
    .select(
      "user_validations_id, submission_id, original_data, corrected_data, comments, approval_comments, approval_status"
    )
    .in(
      "submission_id",
      submissions.map((s) => s.extraction_submission_id)
    );

  if (valError) {
    throw new Error(`Failed to load validations: ${valError.message}`);
  }

  const validationBySubmission = new Map(
    (validations ?? []).map((v) => [v.submission_id, v])
  );

  return (submissions as SubmissionRow[]).map((row) =>
    toQueueItem(row, validationBySubmission.get(row.extraction_submission_id) ?? null)
  );
}

export type WorkerApprovedItem = {
  unifiedRecordId: string;
  workItemCode: string;
  workItemDescription: string;
  /** unified_records.accepted_quantity for THIS approval event — null in
   * percentage-only legacy mode (no planned_quantity configured), same
   * convention as everywhere else in this app (see
   * getWorkItemCurrentStatus.approvedQuantity). */
  approvedQuantity: number | null;
  unit: string | null;
  progressPercentage: number | null;
  /** unified_records.accepted_at — when this specific submission was
   * actually approved, distinct from when it was submitted (see
   * QueueItem.submittedAt on the same work). Delayed approval is exactly
   * why these two dates are kept separate rather than assumed equal. */
  approvedAt: string;
};

type UnifiedRecordWithJoinsRow = {
  unified_record_id: string;
  accepted_quantity: number | null;
  accepted_unit: string | null;
  accepted_data: ProgressData | null;
  accepted_at: string;
  work_items:
    | { line_item_no: string; description_of_work: string }
    | { line_item_no: string; description_of_work: string }[]
    | null;
};

/**
 * Every unified_records row APPROVED for this worker's own submissions —
 * the "Approved Work" tab (see components/workflow/WorkerTabs.tsx),
 * distinct from getWorkerSubmissionHistory (every submission, approved
 * or not). Reuses the same unified_records table every other approved-
 * progress figure in this app is built on (getCumulativeApprovedQuantity,
 * resolveDashboardScope, ...) — no new table, no duplicated calculation,
 * just a worker-scoped read of records that already exist. One row per
 * approval EVENT (not per work item), so a work item approved across
 * several separate days shows up here multiple times, each with its own
 * real accepted_quantity/accepted_at — never collapsed into a single
 * cumulative total (that's what the Dashboard tab's Approved/Completed
 * figure is for).
 */
export async function getWorkerApprovedWork(
  supabase: SupabaseClient,
  workerUserId: string
): Promise<WorkerApprovedItem[]> {
  const ctx = await getUserContext(supabase, workerUserId);
  assertRole(ctx.role, ["WORKER"]);

  const { data, error } = await supabase
    .from("unified_records")
    .select(
      "unified_record_id, accepted_quantity, accepted_unit, accepted_data, accepted_at, work_items(line_item_no, description_of_work), extraction_submissions!inner(worker_id)"
    )
    .eq("status", "APPROVED")
    .eq("extraction_submissions.worker_id", workerUserId)
    .order("accepted_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load approved work: ${error.message}`);
  }

  return ((data ?? []) as unknown as UnifiedRecordWithJoinsRow[]).map((row) => {
    const workItem = one(row.work_items);
    return {
      unifiedRecordId: row.unified_record_id,
      workItemCode: workItem?.line_item_no ?? "",
      workItemDescription: workItem?.description_of_work ?? "",
      approvedQuantity: row.accepted_quantity,
      unit: row.accepted_data?.unit ?? row.accepted_unit,
      progressPercentage: row.accepted_data?.progress_percentage ?? null,
      approvedAt: row.accepted_at,
    };
  });
}

// ------------------------------------------------------------------
// MTD / Work Summary — the broader, cumulative view: every Active work
// item's true current state (cumulative approved quantity vs planned
// quantity, same getWorkItemCurrentStatus used by the Worker Dashboard
// and Supervisor Tab1/Tab2 badges — see lib/workflow.ts module doc),
// never a single day's or a single submission's own percentage.
// ------------------------------------------------------------------

export type WorkItemProgressView = {
  workItemId: string;
  workItemCode: string;
  workItemDescription: string;
  /** work_items.scheduled_value — null if not set for this work item (never fabricated). */
  scheduledValue: number | null;
  /** work_items.planned_quantity / unit_of_measure — null/null when not
   * configured yet (never fabricated from scheduled_value). Lets callers
   * show progress in quantity terms ("45 of 100 m²"), not just percent. */
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  /** Cumulative approved quantity behind `progress` — null in
   * percentage-only legacy mode (no planned_quantity configured), where
   * there is no quantity to sum (see getWorkItemCurrentStatus). */
  approvedQuantity: number | null;
  progress: number | null;
  estimatedAmount: number | null;
  isCompleted: boolean;
};

/** Every Active work item in a department with its cumulative progress
 * (see getWorkItemCurrentStatus) — one query path shared by
 * getMTDProgress and getWorkSummary so neither can disagree. */
async function getWorkItemCumulativeList(
  supabase: SupabaseClient,
  departmentId: string
): Promise<WorkItemProgressView[]> {
  const { data, error } = await supabase
    .from("work_items")
    .select(WORK_ITEM_SELECT)
    .eq("department_id", departmentId)
    .eq("status", "Active")
    .order("line_item_no", { ascending: true });

  if (error) {
    throw new Error(`Failed to load work items: ${error.message}`);
  }

  return Promise.all(
    (data ?? []).map(async (item) => {
      const status = await getWorkItemCurrentStatus(
        supabase,
        item.work_item_id,
        item.planned_quantity
      );

      return {
        workItemId: item.work_item_id,
        workItemCode: item.line_item_no,
        workItemDescription: item.description_of_work,
        scheduledValue: item.scheduled_value,
        plannedQuantity: item.planned_quantity,
        unitOfMeasure: item.unit_of_measure,
        approvedQuantity: status.approvedQuantity,
        progress: status.progressPercentage,
        estimatedAmount: calculateEstimatedAmount(item.scheduled_value, status.progressPercentage),
        isCompleted: status.isCompleted,
      };
    })
  );
}

async function getProjectCode(supabase: SupabaseClient, projectId: string): Promise<string> {
  const { data: project, error } = await supabase
    .from("projects")
    .select("project_code")
    .eq("project_id", projectId)
    .single();

  if (error || !project) {
    throw new Error(`Failed to load project code: ${error?.message ?? projectId}`);
  }
  return project.project_code as string;
}

/**
 * "MTD Progress": despite the name, this is the broader cumulative
 * view per the mentor's requirement — each work item's true current
 * progress (cumulative approved quantity vs planned quantity, all
 * time), not a month-windowed snapshot. See getWorkItemCumulativeList.
 */
export async function getMTDProgress(
  supabase: SupabaseClient,
  supervisorUserId: string
): Promise<WorkItemProgressView[]> {
  const ctx = await getUserContext(supabase, supervisorUserId);
  return getWorkItemCumulativeList(supabase, ctx.departmentId);
}

// ------------------------------------------------------------------
// MTD Work Summary (Tab 2) — per-work-item cumulative progress plus
// department-wide counts derived from existing tables. No new fields
// invented; UI History filtering (Tab 1, client-side only) is a
// separate concern and has no bearing on this calculation.
// ------------------------------------------------------------------

export type WorkSummary = {
  projectName: string;
  departmentName: string;
  reportingPeriodLabel: string | null;
  /** Count of work_items rows — a piece of planned construction work, never a submission count. */
  totalWorkItems: number;
  /** Status counts below describe the CURRENT state of each work item (one entry per
   * work item, from getCurrentWorkItemRecords), never a count of historical submissions. */
  approvedCount: number;
  pendingCount: number;
  rolledBackCount: number;
  /** MTD progress/estimated amount/completion for every work item in the department. */
  workItems: WorkItemProgressView[];
};

export async function getWorkSummary(
  supabase: SupabaseClient,
  supervisorUserId: string
): Promise<WorkSummary> {
  const ctx = await getUserContext(supabase, supervisorUserId);
  const projectCode = await getProjectCode(supabase, ctx.projectId);
  const today = todayISODate();
  const monthStart = currentMonthStartISODate();

  const [period, workItems, currentRecords, mtdWorkItems] = await Promise.all([
    getCurrentReportingPeriod(supabase, projectCode, today),
    getWorkItemsForDepartment(supabase, ctx.departmentId),
    getCurrentWorkItemRecords(supabase, ctx.departmentId),
    getWorkItemCumulativeList(supabase, ctx.departmentId),
  ]);

  let approvedCount = 0;
  let pendingCount = 0;
  let rolledBackCount = 0;

  for (const record of currentRecords) {
    if (record.approvalStatus === "APPROVED") approvedCount++;
    else if (record.approvalStatus === "ROLLED_BACK") rolledBackCount++;
    else pendingCount++;
  }

  return {
    projectName: ctx.projectName,
    departmentName: ctx.departmentName,
    reportingPeriodLabel: period
      ? `${formatDateUS(period.period_start)} to ${formatDateUS(period.period_end)}`
      : `${formatDateUS(monthStart)} to ${formatDateUS(today)} (current month)`,
    totalWorkItems: workItems.length,
    approvedCount,
    pendingCount,
    rolledBackCount,
    workItems: mtdWorkItems,
  };
}
