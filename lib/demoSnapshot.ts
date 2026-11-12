import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isDemoAccountEmail } from "./demoEmail";

/**
 * Snapshot / reseed safeguard for the ISOLATED presentation project(s)
 * (PRES). A writable public Demo Admin can edit the presentation project's
 * departments and work items; this module captures a known-good baseline
 * and restores it, so accidental or abusive demo changes are recoverable.
 *
 * SAFETY — this module can NEVER touch real client data:
 *   1. Every operation first calls assertIsolatedDemoProject(), which
 *      refuses unless the project id is in the caller-supplied allow-list
 *      (the configured DEMO_PROJECT_IDS) AND every Active member of that
 *      project is a reserved @example.com demo account. One real member and
 *      it throws — exactly the invariant checkDemoAccount relies on.
 *   2. Restore only ever writes to rows of that one verified project
 *      (departments / work_items / work_item_dependencies), scoped by
 *      project_id. It never writes to users, auth, delegations, companies,
 *      or any other project.
 *   3. planRestore() computes the change set WITHOUT writing (the dry run);
 *      applyRestore() writes, and re-asserts isolation immediately before
 *      doing so. Deletion of drift rows happens only when explicitly asked
 *      for (prune) — by default restore is purely additive/corrective.
 *
 * The module takes a Supabase-shaped client, so it is unit-tested against
 * an in-memory table store (tests/demo-presentation-safeguard.test.cjs) —
 * no network, no production database.
 */

export type DepartmentRow = {
  department_id: string;
  project_id: string;
  department_code: string | null;
  department_name: string | null;
  status: string | null;
};
export type WorkItemRow = {
  work_item_id: string;
  project_id: string;
  department_id: string;
  line_item_no: string | null;
  csi_line_code: string | null;
  description_of_work: string | null;
  scheduled_value: number | null;
  unit_of_measure: string | null;
  planned_quantity: number | null;
  retainage_percent: number | null;
  status: string | null;
};
export type DependencyRow = { work_item_id: string; depends_on_work_item_id: string };

export type PresentationSnapshot = {
  /** Snapshot format version — bump if the captured shape changes. */
  version: 1;
  projectId: string;
  capturedAt: string;
  departments: DepartmentRow[];
  workItems: WorkItemRow[];
  dependencies: DependencyRow[];
};

const DEPARTMENT_COLUMNS = "department_id, project_id, department_code, department_name, status";
const WORK_ITEM_COLUMNS =
  "work_item_id, project_id, department_id, line_item_no, csi_line_code, description_of_work, scheduled_value, unit_of_measure, planned_quantity, retainage_percent, status";

/** Thrown when a project is not a safe, isolated presentation project. The
 * safeguard always fails closed on this — it never guesses. */
export class NotIsolatedDemoProjectError extends Error {}

/**
 * The one gate every snapshot/restore passes first. Refuses unless:
 *  - `projectId` is one of the configured demo project ids (allow-list), and
 *  - every Active member of that project is an @example.com demo account.
 * Never throws anything but NotIsolatedDemoProjectError for a refusal (a
 * genuine lookup error is rethrown so a failure is never mistaken for "safe").
 */
export async function assertIsolatedDemoProject(
  admin: SupabaseClient,
  projectId: string,
  allowedProjectIds: Set<string>
): Promise<void> {
  if (!allowedProjectIds.has(projectId)) {
    throw new NotIsolatedDemoProjectError(
      `Refused: ${projectId} is not one of the configured presentation projects.`
    );
  }
  const { data, error } = await admin
    .from("user_project_roles")
    .select("users(user_mail)")
    .eq("project_id", projectId)
    .eq("status", "Active");
  if (error) {
    throw new Error(`Failed to verify project isolation for ${projectId}: ${error.message}`);
  }
  const members = data ?? [];
  const realMember = members.find((row) => {
    const user = Array.isArray(row.users) ? row.users[0] : row.users;
    return !isDemoAccountEmail((user as { user_mail?: unknown } | null)?.user_mail);
  });
  if (realMember) {
    throw new NotIsolatedDemoProjectError(
      `Refused: project ${projectId} has a non-demo (real) member, so it is not a safe presentation project to snapshot or restore.`
    );
  }
}

/** Reads a complete baseline of one isolated presentation project. READ ONLY. */
export async function snapshotPresentationProject(
  admin: SupabaseClient,
  projectId: string,
  allowedProjectIds: Set<string>
): Promise<PresentationSnapshot> {
  await assertIsolatedDemoProject(admin, projectId, allowedProjectIds);

  const { data: departments, error: deptError } = await admin
    .from("departments")
    .select(DEPARTMENT_COLUMNS)
    .eq("project_id", projectId);
  if (deptError) throw new Error(`Failed to read departments: ${deptError.message}`);

  const { data: workItems, error: workItemError } = await admin
    .from("work_items")
    .select(WORK_ITEM_COLUMNS)
    .eq("project_id", projectId);
  if (workItemError) throw new Error(`Failed to read work items: ${workItemError.message}`);

  const workItemIds = (workItems ?? []).map((w) => (w as WorkItemRow).work_item_id);
  let dependencies: DependencyRow[] = [];
  if (workItemIds.length > 0) {
    const { data: deps, error: depError } = await admin
      .from("work_item_dependencies")
      .select("work_item_id, depends_on_work_item_id")
      .in("work_item_id", workItemIds);
    if (depError) throw new Error(`Failed to read work item dependencies: ${depError.message}`);
    dependencies = (deps ?? []) as DependencyRow[];
  }

  return {
    version: 1,
    projectId,
    capturedAt: new Date().toISOString(),
    departments: (departments ?? []) as DepartmentRow[],
    workItems: (workItems ?? []) as WorkItemRow[],
    dependencies,
  };
}

export type RestorePlan = {
  projectId: string;
  /** Baseline rows to re-insert/update (restore their captured values). */
  departmentsToRestore: number;
  workItemsToRestore: number;
  dependenciesToRestore: number;
  /** Rows present now but absent from the baseline (demo drift). Removed
   * only when `prune` is set; otherwise just reported. */
  departmentDriftIds: string[];
  workItemDriftIds: string[];
};

/**
 * Computes what a restore would change, WITHOUT writing anything (the dry
 * run). Reads the project's current rows and diffs them against the
 * baseline. Always isolation-gated first.
 */
export async function planRestore(
  admin: SupabaseClient,
  snapshot: PresentationSnapshot,
  allowedProjectIds: Set<string>
): Promise<RestorePlan> {
  await assertIsolatedDemoProject(admin, snapshot.projectId, allowedProjectIds);

  const { data: currentDepartments, error: deptError } = await admin
    .from("departments")
    .select("department_id")
    .eq("project_id", snapshot.projectId);
  if (deptError) throw new Error(`Failed to read departments: ${deptError.message}`);
  const { data: currentWorkItems, error: workItemError } = await admin
    .from("work_items")
    .select("work_item_id")
    .eq("project_id", snapshot.projectId);
  if (workItemError) throw new Error(`Failed to read work items: ${workItemError.message}`);

  const baselineDeptIds = new Set(snapshot.departments.map((d) => d.department_id));
  const baselineWorkItemIds = new Set(snapshot.workItems.map((w) => w.work_item_id));

  const departmentDriftIds = (currentDepartments ?? [])
    .map((d) => (d as { department_id: string }).department_id)
    .filter((id) => !baselineDeptIds.has(id));
  const workItemDriftIds = (currentWorkItems ?? [])
    .map((w) => (w as { work_item_id: string }).work_item_id)
    .filter((id) => !baselineWorkItemIds.has(id));

  return {
    projectId: snapshot.projectId,
    departmentsToRestore: snapshot.departments.length,
    workItemsToRestore: snapshot.workItems.length,
    dependenciesToRestore: snapshot.dependencies.length,
    departmentDriftIds,
    workItemDriftIds,
  };
}

export type RestoreResult = RestorePlan & { applied: true; prunedDepartments: number; prunedWorkItems: number };

/**
 * Applies a restore: upserts every baseline department/work item/dependency
 * (restoring their captured values), and — only when `prune` is true —
 * deletes the drift rows (departments/work items present now but not in the
 * baseline) within this one isolated project. Re-asserts isolation
 * immediately before writing, so a project that became non-isolated since
 * the plan was computed is refused. Writes only to this project's rows.
 */
export async function applyRestore(
  admin: SupabaseClient,
  snapshot: PresentationSnapshot,
  allowedProjectIds: Set<string>,
  options: { prune?: boolean } = {}
): Promise<RestoreResult> {
  const plan = await planRestore(admin, snapshot, allowedProjectIds);
  // Fail closed: re-verify isolation at the moment of writing.
  await assertIsolatedDemoProject(admin, snapshot.projectId, allowedProjectIds);

  if (snapshot.departments.length > 0) {
    const { error } = await admin.from("departments").upsert(snapshot.departments, { onConflict: "department_id" });
    if (error) throw new Error(`Failed to restore departments: ${error.message}`);
  }
  if (snapshot.workItems.length > 0) {
    const { error } = await admin.from("work_items").upsert(snapshot.workItems, { onConflict: "work_item_id" });
    if (error) throw new Error(`Failed to restore work items: ${error.message}`);
  }

  let prunedWorkItems = 0;
  let prunedDepartments = 0;
  if (options.prune) {
    if (plan.workItemDriftIds.length > 0) {
      const { error } = await admin.from("work_items").delete().in("work_item_id", plan.workItemDriftIds);
      if (error) throw new Error(`Failed to prune work items: ${error.message}`);
      prunedWorkItems = plan.workItemDriftIds.length;
    }
    if (plan.departmentDriftIds.length > 0) {
      const { error } = await admin.from("departments").delete().in("department_id", plan.departmentDriftIds);
      if (error) throw new Error(`Failed to prune departments: ${error.message}`);
      prunedDepartments = plan.departmentDriftIds.length;
    }
  }

  // Dependencies: restore the baseline set for the baseline's work items.
  if (snapshot.dependencies.length > 0) {
    const { error } = await admin
      .from("work_item_dependencies")
      .upsert(snapshot.dependencies, { onConflict: "work_item_id,depends_on_work_item_id" });
    if (error) throw new Error(`Failed to restore work item dependencies: ${error.message}`);
  }

  return { ...plan, applied: true, prunedDepartments, prunedWorkItems };
}
