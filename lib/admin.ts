import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";

/**
 * Admin Setup data access — reuses the existing Construction Automation
 * schema exactly as the rest of the app does (companies/projects/
 * departments/work_items/users). No new tables, no new columns: this
 * only lets a browser do what the app's seed data was previously only
 * ever set up with by hand in the Supabase dashboard.
 *
 * Access control: same non-mechanism as every other role in this
 * no-login test app (see lib/supabase.ts) — a user with
 * users.user_role = 'ADMIN' is "the admin", picked from a list exactly
 * like Worker/Foreman/Supervisor are. Enforced in app/admin/* pages,
 * not here.
 */

export type Company = {
  companyId: string;
  name: string;
  code: string;
  status: string;
};

export async function listCompanies(supabase: SupabaseClient): Promise<Company[]> {
  const { data, error } = await supabase
    .from("companies")
    .select("company_id, name, code, status")
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to load companies: ${error.message}`);

  return (data ?? []).map((c) => ({
    companyId: c.company_id,
    name: c.name,
    code: c.code,
    status: c.status,
  }));
}

export async function createCompany(
  supabase: SupabaseClient,
  params: { name: string; code: string; address?: string | null }
): Promise<void> {
  const { error } = await supabase.from("companies").insert({
    name: params.name,
    code: params.code,
    address: params.address ?? null,
    status: "Active",
  });
  if (error) throw new Error(`Failed to create company: ${error.message}`);
}

export type Project = {
  projectId: string;
  companyId: string;
  companyName: string;
  projectCode: string;
  projectName: string;
  projectLocation: string | null;
  status: string;
};

export async function listProjects(supabase: SupabaseClient): Promise<Project[]> {
  const { data, error } = await supabase
    .from("projects")
    .select(
      "project_id, company_id, project_code, project_name, project_location, status, companies(name)"
    )
    .order("project_name", { ascending: true });

  if (error) throw new Error(`Failed to load projects: ${error.message}`);

  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  return (data ?? []).map((p) => ({
    projectId: p.project_id,
    companyId: p.company_id,
    companyName: one(p.companies as { name: string } | { name: string }[] | null)?.name ?? "(unknown)",
    projectCode: p.project_code,
    projectName: p.project_name,
    projectLocation: p.project_location,
    status: p.status,
  }));
}

export async function createProject(
  supabase: SupabaseClient,
  params: {
    companyId: string;
    projectCode: string;
    projectName: string;
    projectLocation?: string | null;
  }
): Promise<void> {
  const { error } = await supabase.from("projects").insert({
    company_id: params.companyId,
    project_code: params.projectCode,
    project_name: params.projectName,
    project_location: params.projectLocation ?? null,
    status: "Active",
  });
  if (error) throw new Error(`Failed to create project: ${error.message}`);
}

/** project_id -> company_id — the scope a delegated PROJECT_MANAGEMENT
 * check resolves before editing (see app/api/admin/projects/route.ts). */
export async function getProjectCompanyId(
  supabase: SupabaseClient,
  projectId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("projects")
    .select("company_id")
    .eq("project_id", projectId)
    .single();
  if (error || !data) {
    throw new Error(`Project not found: ${error?.message ?? projectId}`);
  }
  return data.company_id as string;
}

/**
 * Updates a Project's editable details — project_code (the business
 * key) and company_id (which would re-parent the project) are
 * deliberately never touched here, same reasoning as
 * updateWorkItemValues never touching line_item_no/department. This is
 * the operation a PROJECT_MANAGEMENT delegation grants (edit only —
 * creating a brand-new project stays Admin-only, see
 * lib/delegationTypes.ts ADMIN_DELEGATION_PERMISSIONS doc).
 */
export async function updateProject(
  supabase: SupabaseClient,
  projectId: string,
  params: { projectName?: string; projectLocation?: string | null }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (params.projectName !== undefined) update.project_name = params.projectName;
  if (params.projectLocation !== undefined) update.project_location = params.projectLocation;

  const { error } = await supabase.from("projects").update(update).eq("project_id", projectId);
  if (error) throw new Error(`Failed to update project: ${error.message}`);
}

export type Department = {
  departmentId: string;
  projectId: string;
  projectName: string;
  departmentCode: string;
  departmentName: string;
  status: string;
};

export async function listDepartments(supabase: SupabaseClient): Promise<Department[]> {
  const { data, error } = await supabase
    .from("departments")
    .select(
      "department_id, project_id, department_code, department_name, status, projects(project_name)"
    )
    .order("department_name", { ascending: true });

  if (error) throw new Error(`Failed to load departments: ${error.message}`);

  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  return (data ?? []).map((d) => ({
    departmentId: d.department_id,
    projectId: d.project_id,
    projectName:
      one(d.projects as { project_name: string } | { project_name: string }[] | null)
        ?.project_name ?? "(unknown)",
    departmentCode: d.department_code,
    departmentName: d.department_name,
    status: d.status,
  }));
}

export async function createDepartment(
  supabase: SupabaseClient,
  params: { projectId: string; departmentCode: string; departmentName: string }
): Promise<void> {
  // Best-effort link to the standard catalog by exact (case-insensitive)
  // name match — same matching rule as the Excel import path
  // (findOrCreateProjectDepartment), so a manually-created "Electrical
  // Department" and an imported one both resolve to the same catalog
  // entry rather than the manual form always producing an unlinked
  // "custom" department for a name that IS actually standard.
  const standard = await findStandardDepartmentByExactName(supabase, params.departmentName);

  const { error } = await supabase.from("departments").insert({
    project_id: params.projectId,
    department_code: params.departmentCode,
    department_name: params.departmentName,
    status: "Active",
    standard_department_id: standard?.standardDepartmentId ?? null,
  });
  if (error) throw new Error(`Failed to create department: ${error.message}`);
}

/** department_id -> project_id — the scope a delegated
 * DEPARTMENT_MANAGEMENT/WORK_ITEM_MANAGEMENT check resolves before
 * acting on an existing department (see app/api/admin/departments/route.ts). */
export async function getDepartmentProjectId(
  supabase: SupabaseClient,
  departmentId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("departments")
    .select("project_id")
    .eq("department_id", departmentId)
    .single();
  if (error || !data) {
    throw new Error(`Department not found: ${error?.message ?? departmentId}`);
  }
  return data.project_id as string;
}

/**
 * Updates a Department's editable details — department_code and
 * project_id (which would re-parent it) are never touched here, same
 * reasoning as updateProject. The operation a DEPARTMENT_MANAGEMENT
 * delegation grants for editing (see lib/delegationTypes.ts).
 */
export async function updateDepartment(
  supabase: SupabaseClient,
  departmentId: string,
  params: { departmentName?: string }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (params.departmentName !== undefined) update.department_name = params.departmentName;

  const { error } = await supabase
    .from("departments")
    .update(update)
    .eq("department_id", departmentId);
  if (error) throw new Error(`Failed to update department: ${error.message}`);
}

export type StandardDepartment = {
  standardDepartmentId: string;
  code: string;
  name: string;
};

/** The reusable standard department catalog (see
 * supabase/migrations/00000000000011_standard_departments.sql) — the
 * "70% standard" half of the department model. Used both by the Admin
 * Setup UI (picking a standard department to activate on a project)
 * and by the Excel import flow (matching an uploaded department name
 * against the catalog before falling back to a custom department). */
export async function listStandardDepartments(
  // Unused: standard_departments now always goes through the dedicated
  // service-role client below (see the P0 audit) — kept in the
  // signature so every existing call site keeps compiling unchanged.
  _supabase: SupabaseClient
): Promise<StandardDepartment[]> {
  void _supabase;
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("standard_departments")
    .select("standard_department_id, code, name")
    .eq("status", "Active")
    .order("name", { ascending: true });

  if (error) throw new Error(`Failed to load standard departments: ${error.message}`);

  return (data ?? []).map((d) => ({
    standardDepartmentId: d.standard_department_id,
    code: d.code,
    name: d.name,
  }));
}

function slugCode(name: string): string {
  const alnum = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (alnum.slice(0, 8) || "DEPT") + Math.random().toString(36).slice(2, 5).toUpperCase();
}

/**
 * Case-insensitive exact match against the Active standard department
 * catalog — deliberately NOT `.ilike()`. A department name can contain
 * `%`/`_` (e.g. "R&D_Prototyping"), which `ilike` treats as SQL
 * wildcards, not literal characters — a name containing one could
 * silently match (or fail to match) the wrong catalog entry. The
 * catalog is small (a few dozen rows at most), so fetching Active rows
 * and comparing in JS is both correct and cheap — no per-call table
 * scan cost that would justify the wildcard risk.
 */
async function findStandardDepartmentByExactName(
  supabase: SupabaseClient,
  name: string
): Promise<{ standardDepartmentId: string; code: string } | null> {
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("standard_departments")
    .select("standard_department_id, code, name")
    .eq("status", "Active");

  if (error) {
    throw new Error(`Failed to look up standard department: ${error.message}`);
  }

  const target = name.trim().toLowerCase();
  const match = (data ?? []).find((d) => (d.name as string).trim().toLowerCase() === target);
  return match ? { standardDepartmentId: match.standard_department_id, code: match.code } : null;
}

/**
 * Finds an existing department in `projectId` matching `departmentName`
 * (case-insensitive, whitespace-trimmed — "Electrical" and "electrical "
 * are the same department), or creates one. A new department is linked
 * to the standard catalog when the name matches an Active standard
 * department (case-insensitive); otherwise it's created as a genuine
 * custom department (standard_department_id stays null) — exactly the
 * "standard catalog + project-specific activation + custom department
 * creation" model. The single entry point the Excel import flow uses so
 * re-processing the same file (or a corrected re-upload) never creates
 * duplicate "Electrical" rows for the same project.
 */
export async function findOrCreateProjectDepartment(
  supabase: SupabaseClient,
  projectId: string,
  departmentName: string
): Promise<{ departmentId: string; departmentName: string; wasCreated: boolean }> {
  const trimmedName = departmentName.trim();
  const targetLower = trimmedName.toLowerCase();

  // Exact case-insensitive match in JS, not `.ilike()` — see
  // findStandardDepartmentByExactName's doc for why (department names
  // can legitimately contain `%`/`_`, which ilike would treat as
  // wildcards). One project's department list is small, so this is
  // cheap.
  const { data: projectDepartments, error: findError } = await supabase
    .from("departments")
    .select("department_id, department_name")
    .eq("project_id", projectId);

  if (findError) {
    throw new Error(`Failed to look up department: ${findError.message}`);
  }
  const existing = (projectDepartments ?? []).find(
    (d) => (d.department_name as string).trim().toLowerCase() === targetLower
  );
  if (existing) {
    return {
      departmentId: existing.department_id,
      departmentName: existing.department_name,
      wasCreated: false,
    };
  }

  const standard = await findStandardDepartmentByExactName(supabase, trimmedName);

  const { data: created, error: createError } = await supabase
    .from("departments")
    .insert({
      project_id: projectId,
      department_code: standard?.code ?? slugCode(trimmedName),
      department_name: trimmedName,
      status: "Active",
      standard_department_id: standard?.standardDepartmentId ?? null,
    })
    .select("department_id, department_name")
    .single();

  if (createError || !created) {
    throw new Error(`Failed to create department: ${createError?.message ?? "no row returned"}`);
  }

  return { departmentId: created.department_id, departmentName: created.department_name, wasCreated: true };
}

/**
 * Creates or updates a work item from an imported spreadsheet row —
 * matched by (project_id, department_id, line_item_no) when a line
 * item number was supplied (the stable business identifier a real
 * project file uses), else by (project_id, department_id,
 * description_of_work) as a fallback so a file with no numbering
 * scheme still doesn't create duplicates on re-import. Existing
 * work_item_id and any assignments/progress history are preserved on
 * update — only the configuration fields a re-upload is meant to
 * refresh (description, quantity, unit, value, CSI code) are touched.
 */
export async function upsertWorkItemFromImport(
  supabase: SupabaseClient,
  params: {
    projectId: string;
    departmentId: string;
    lineItemNo: string | null;
    description: string;
    plannedQuantity: number | null;
    unitOfMeasure: string | null;
    scheduledValue: number | null;
    csiLineCode: string | null;
  }
): Promise<{ workItemId: string; wasCreated: boolean }> {
  let existingQuery = supabase
    .from("work_items")
    .select("work_item_id")
    .eq("project_id", params.projectId)
    .eq("department_id", params.departmentId);

  existingQuery = params.lineItemNo
    ? existingQuery.eq("line_item_no", params.lineItemNo)
    : existingQuery.eq("description_of_work", params.description);

  const { data: existing, error: findError } = await existingQuery.maybeSingle();
  if (findError) {
    throw new Error(`Failed to look up work item: ${findError.message}`);
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("work_items")
      .update({
        description_of_work: params.description,
        planned_quantity: params.plannedQuantity,
        unit_of_measure: params.unitOfMeasure,
        scheduled_value: params.scheduledValue,
        csi_line_code: params.csiLineCode,
      })
      .eq("work_item_id", existing.work_item_id);

    if (updateError) {
      throw new Error(`Failed to update work item: ${updateError.message}`);
    }
    return { workItemId: existing.work_item_id, wasCreated: false };
  }

  let lineItemNo = params.lineItemNo;
  if (!lineItemNo) {
    const { count, error: countError } = await supabase
      .from("work_items")
      .select("work_item_id", { count: "exact", head: true })
      .eq("department_id", params.departmentId);
    if (countError) {
      throw new Error(`Failed to number work item: ${countError.message}`);
    }
    lineItemNo = `AUTO-${(count ?? 0) + 1}`;
  }

  const { data: created, error: createError } = await supabase
    .from("work_items")
    .insert({
      project_id: params.projectId,
      department_id: params.departmentId,
      line_item_no: lineItemNo,
      description_of_work: params.description,
      planned_quantity: params.plannedQuantity,
      unit_of_measure: params.unitOfMeasure,
      scheduled_value: params.scheduledValue,
      csi_line_code: params.csiLineCode,
      status: "Active",
    })
    .select("work_item_id")
    .single();

  if (createError || !created) {
    throw new Error(`Failed to create work item: ${createError?.message ?? "no row returned"}`);
  }
  return { workItemId: created.work_item_id, wasCreated: true };
}

export type AdminWorkItem = {
  workItemId: string;
  departmentId: string;
  departmentName: string;
  lineItemNo: string;
  csiLineCode: string | null;
  descriptionOfWork: string;
  scheduledValue: number | null;
  unitOfMeasure: string | null;
  plannedQuantity: number | null;
  retainagePercent: number | null;
  status: string;
};

export async function listWorkItems(supabase: SupabaseClient): Promise<AdminWorkItem[]> {
  const { data, error } = await supabase
    .from("work_items")
    .select(
      "work_item_id, department_id, line_item_no, csi_line_code, description_of_work, scheduled_value, unit_of_measure, planned_quantity, retainage_percent, status, departments(department_name)"
    )
    .order("line_item_no", { ascending: true });

  if (error) throw new Error(`Failed to load work items: ${error.message}`);

  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  return (data ?? []).map((w) => ({
    workItemId: w.work_item_id,
    departmentId: w.department_id,
    departmentName:
      one(w.departments as { department_name: string } | { department_name: string }[] | null)
        ?.department_name ?? "(unknown)",
    lineItemNo: w.line_item_no,
    csiLineCode: w.csi_line_code,
    descriptionOfWork: w.description_of_work,
    scheduledValue: w.scheduled_value,
    unitOfMeasure: w.unit_of_measure,
    plannedQuantity: w.planned_quantity,
    retainagePercent: w.retainage_percent,
    status: w.status,
  }));
}

export async function createWorkItem(
  supabase: SupabaseClient,
  params: {
    departmentId: string;
    lineItemNo: string;
    csiLineCode?: string | null;
    descriptionOfWork: string;
    scheduledValue?: number | null;
    unitOfMeasure?: string | null;
    plannedQuantity?: number | null;
    retainagePercent?: number | null;
    /** Other work_item_ids this one depends on (see work_item_dependencies). */
    dependsOnWorkItemIds?: string[];
  }
): Promise<void> {
  // work_items requires project_id directly (not derivable from
  // department_id alone in a single insert) — look it up from the
  // chosen department so the caller only has to pick a department.
  const { data: department, error: deptError } = await supabase
    .from("departments")
    .select("project_id")
    .eq("department_id", params.departmentId)
    .single();

  if (deptError || !department) {
    throw new Error(
      `Department not found: ${deptError?.message ?? params.departmentId}`
    );
  }

  const { data: created, error } = await supabase
    .from("work_items")
    .insert({
      project_id: department.project_id,
      department_id: params.departmentId,
      line_item_no: params.lineItemNo,
      csi_line_code: params.csiLineCode ?? null,
      description_of_work: params.descriptionOfWork,
      scheduled_value: params.scheduledValue ?? null,
      unit_of_measure: params.unitOfMeasure ?? null,
      planned_quantity: params.plannedQuantity ?? null,
      retainage_percent: params.retainagePercent ?? null,
      status: "Active",
    })
    .select("work_item_id")
    .single();

  if (error || !created) {
    throw new Error(`Failed to create work item: ${error?.message ?? "no row returned"}`);
  }

  if (params.dependsOnWorkItemIds && params.dependsOnWorkItemIds.length > 0) {
    await setWorkItemDependencies(supabase, created.work_item_id, params.dependsOnWorkItemIds);
  }
}

/**
 * Updates only the fields the spec calls out as configurable after
 * creation (Scheduled Value / Planned Quantity / Unit of Measure) — the
 * exact fix for "Estimated Amount (Scheduled Value): Not set for this
 * work item" on seed data that predates this feature. Never touches
 * line_item_no/description/department (those define identity, not
 * configuration) so this can't silently re-point an existing item.
 */
export async function updateWorkItemValues(
  supabase: SupabaseClient,
  workItemId: string,
  params: {
    scheduledValue?: number | null;
    unitOfMeasure?: string | null;
    plannedQuantity?: number | null;
    retainagePercent?: number | null;
    csiLineCode?: string | null;
    /** Other work_item_ids this one depends on — when present, replaces
     * the full set (see setWorkItemDependencies). */
    dependsOnWorkItemIds?: string[];
  }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if ("scheduledValue" in params) update.scheduled_value = params.scheduledValue;
  if ("unitOfMeasure" in params) update.unit_of_measure = params.unitOfMeasure;
  if ("plannedQuantity" in params) update.planned_quantity = params.plannedQuantity;
  if ("retainagePercent" in params) update.retainage_percent = params.retainagePercent;
  if ("csiLineCode" in params) update.csi_line_code = params.csiLineCode;

  const { error } = await supabase
    .from("work_items")
    .update(update)
    .eq("work_item_id", workItemId);

  if (error) throw new Error(`Failed to update work item: ${error.message}`);

  if (params.dependsOnWorkItemIds !== undefined) {
    await setWorkItemDependencies(supabase, workItemId, params.dependsOnWorkItemIds);
  }
}

export type WorkItemDependency = {
  workItemId: string;
  dependsOnWorkItemId: string;
};

/** All prerequisite edges across every work item — same "load
 * everything, filter client-side" pattern as listWorkItems etc. */
export async function listWorkItemDependencies(
  // Unused: work_item_dependencies now always goes through the dedicated
  // service-role client below (see the P0 audit) — kept in the
  // signature so every existing call site keeps compiling unchanged.
  _supabase: SupabaseClient
): Promise<WorkItemDependency[]> {
  void _supabase;
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("work_item_dependencies")
    .select("work_item_id, depends_on_work_item_id");

  if (error) throw new Error(`Failed to load work item dependencies: ${error.message}`);

  return (data ?? []).map((d) => ({
    workItemId: d.work_item_id,
    dependsOnWorkItemId: d.depends_on_work_item_id,
  }));
}

/**
 * Replaces the full set of prerequisite edges for one work item with
 * exactly `dependsOnWorkItemIds` (delete-then-insert, not a diff — the
 * caller always sends the whole desired state, same as every other
 * update function in this file sends whole field values, not deltas).
 * Silently drops self-references and duplicates rather than erroring,
 * since the Admin UI picker already excludes the item itself.
 */
export async function setWorkItemDependencies(
  supabase: SupabaseClient,
  workItemId: string,
  dependsOnWorkItemIds: string[]
): Promise<void> {
  const distinctIds = [...new Set(dependsOnWorkItemIds)].filter((id) => id !== workItemId);
  const serviceSupabase = getSupabaseServiceRoleClient();

  const { error: deleteError } = await serviceSupabase
    .from("work_item_dependencies")
    .delete()
    .eq("work_item_id", workItemId);
  if (deleteError) {
    throw new Error(`Failed to clear work item dependencies: ${deleteError.message}`);
  }

  if (distinctIds.length === 0) return;

  const { error: insertError } = await serviceSupabase.from("work_item_dependencies").insert(
    distinctIds.map((dependsOnWorkItemId) => ({
      work_item_id: workItemId,
      depends_on_work_item_id: dependsOnWorkItemId,
    }))
  );
  if (insertError) {
    throw new Error(`Failed to save work item dependencies: ${insertError.message}`);
  }
}

export type AdminUser = {
  userId: string;
  email: string;
  departmentId: string;
  departmentName: string;
};

/** Users with user_role = 'ADMIN' — the Admin Setup picker, parallel to
 * listSelectableUsers in lib/workflow.ts but not project/department
 * scoped, since Admin Setup manages master data across all of them. */
export async function listAdminUsers(supabase: SupabaseClient): Promise<AdminUser[]> {
  const { data, error } = await supabase
    .from("users")
    .select("user_id, user_mail, department_id, status, departments(department_name)")
    .eq("user_role", "ADMIN")
    .eq("status", "Active");

  if (error) throw new Error(`Failed to load admin users: ${error.message}`);

  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  return (data ?? []).map((u) => ({
    userId: u.user_id,
    email: u.user_mail,
    departmentId: u.department_id,
    departmentName:
      one(u.departments as { department_name: string } | { department_name: string }[] | null)
        ?.department_name ?? "(unknown)",
  }));
}

/**
 * Creates the first Admin user, get-or-create by email exactly like
 * lib/construction.ts's getOrCreateTestWorker already does for the
 * extraction test worker — same pattern, not a new mechanism. Requires
 * an existing department (Admin, like every other role in this schema,
 * hangs off a department — see AGENTS.md: no direct Company -> User
 * relationship) so an admin bootstraps under any already-seeded
 * department rather than this needing its own special-cased identity.
 *
 * Only usable while there is genuinely no Admin yet ("bootstrap" — the
 * chicken-and-egg case where no one can pass the normal admin-only
 * check because no admin exists to pass it as). The instant at least
 * one Admin exists, this closes: creating additional Admin accounts
 * from then on goes through an authorized Admin's own Admin Setup ->
 * Users tab (createUserWithRole, already supports role ADMIN), which
 * is checked server-side in app/api/admin/users/route.ts. Without this
 * guard, this endpoint would otherwise let anyone mint an unlimited
 * number of Admin accounts with no credential at all — see
 * Requirement 12 (credentials/security administration must be
 * controlled by an existing higher authority, not self-service).
 */
export async function bootstrapAdminUser(
  supabase: SupabaseClient,
  params: { email: string; departmentId: string }
): Promise<string> {
  const { data: existing, error: findError } = await supabase
    .from("users")
    .select("user_id")
    .eq("user_mail", params.email)
    .maybeSingle();

  if (findError) throw new Error(`Failed to look up user: ${findError.message}`);
  if (existing) return existing.user_id;

  const existingAdmins = await listAdminUsers(supabase);
  if (existingAdmins.length > 0) {
    throw new Error(
      "An Admin account already exists. Ask an existing Admin to create additional Admin accounts via Admin Setup → Users."
    );
  }

  const { data: created, error: createError } = await supabase
    .from("users")
    .insert({
      department_id: params.departmentId,
      user_mail: params.email,
      user_role: "ADMIN",
      status: "Active",
    })
    .select("user_id")
    .single();

  if (createError || !created) {
    throw new Error(`Failed to create admin user: ${createError?.message ?? "no row returned"}`);
  }

  return created.user_id;
}

export type UserProjectRoleAssignment = {
  userProjectRoleId: string;
  projectId: string;
  projectName: string;
  departmentId: string;
  departmentName: string;
  role: string;
  status: string;
};

export type UserAccount = {
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** users.user_role — the account's default role/department (see
   * bootstrapAdminUser / getOrCreateTestWorker, which set this the same
   * way). The actual dashboard-scoping mechanism is user_project_roles
   * below (see lib/workflow.ts getUserContext), not this column. */
  role: string;
  status: string;
  departmentId: string;
  departmentName: string;
  /** Active project/department/role assignments — what actually drives
   * Worker/Foreman/Subcontractor/Contractor dashboard access (see
   * lib/workflow.ts getUserContext / listSelectableUsers). A user with
   * none of these can't use any workflow dashboard yet even though the
   * account itself exists. */
  projectRoles: UserProjectRoleAssignment[];
  /** Whether this account can log in yet (public.users.auth_user_id is
   * set — see supabase/migrations/00000000000010_users_auth_link.sql).
   * The raw auth_user_id itself is never returned here — it's Supabase
   * Auth's internal id, not something any UI needs to display, and
   * least-exposure is the safer default even though it isn't a secret
   * (see linkUserToAuthAccount below for the only place it's written). */
  isLinked: boolean;
};

/** Every user account, each annotated with its active project/department
 * role assignments — the Admin Setup "Users" tab list. Same "load
 * everything, filter/join client-side" pattern as listWorkItems etc. */
export async function listUsers(supabase: SupabaseClient): Promise<UserAccount[]> {
  const { data: users, error } = await supabase
    .from("users")
    .select(
      "user_id, user_mail, first_name, last_name, user_role, status, department_id, auth_user_id, departments(department_name)"
    )
    .order("user_mail", { ascending: true });

  if (error) throw new Error(`Failed to load users: ${error.message}`);

  const { data: roles, error: rolesError } = await supabase
    .from("user_project_roles")
    .select(
      "user_project_role_id, user_id, project_id, department_id, role, status, projects(project_name), departments(department_name)"
    )
    .eq("status", "Active");

  if (rolesError) throw new Error(`Failed to load user project roles: ${rolesError.message}`);

  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  const rolesByUser = new Map<string, UserProjectRoleAssignment[]>();
  for (const r of roles ?? []) {
    const list = rolesByUser.get(r.user_id) ?? [];
    list.push({
      userProjectRoleId: r.user_project_role_id,
      projectId: r.project_id,
      projectName:
        one(r.projects as { project_name: string } | { project_name: string }[] | null)
          ?.project_name ?? "(unknown)",
      departmentId: r.department_id,
      departmentName:
        one(r.departments as { department_name: string } | { department_name: string }[] | null)
          ?.department_name ?? "(unknown)",
      role: r.role,
      status: r.status,
    });
    rolesByUser.set(r.user_id, list);
  }

  return (users ?? []).map((u) => ({
    userId: u.user_id,
    email: u.user_mail,
    firstName: u.first_name,
    lastName: u.last_name,
    role: u.user_role,
    status: u.status,
    departmentId: u.department_id,
    departmentName:
      one(u.departments as { department_name: string } | { department_name: string }[] | null)
        ?.department_name ?? "(unknown)",
    projectRoles: rolesByUser.get(u.user_id) ?? [],
    isLinked: !!u.auth_user_id,
  }));
}

/**
 * Creates a user account and its project/department role assignment —
 * the two-table pattern every existing seeded workflow user already
 * follows (a users row for identity/default department/role, a
 * user_project_roles row for actual dashboard scoping; see
 * lib/workflow.ts getUserContext). Get-or-create by email like
 * bootstrapAdminUser, so re-submitting the form for an existing email
 * doesn't create a duplicate account — it just adds/reuses the role
 * assignment. No new tables: both tables already exist and are already
 * used this way for the 5 seeded users.
 */
export async function createUserWithRole(
  supabase: SupabaseClient,
  params: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    departmentId: string;
    projectId: string;
    role: string;
  }
): Promise<void> {
  const { data: existing, error: findError } = await supabase
    .from("users")
    .select("user_id")
    .eq("user_mail", params.email)
    .maybeSingle();

  if (findError) throw new Error(`Failed to look up user: ${findError.message}`);

  let userId: string;
  if (existing) {
    userId = existing.user_id;
  } else {
    const { data: created, error: createError } = await supabase
      .from("users")
      .insert({
        department_id: params.departmentId,
        user_mail: params.email,
        user_role: params.role,
        first_name: params.firstName ?? null,
        last_name: params.lastName ?? null,
        status: "Active",
      })
      .select("user_id")
      .single();

    if (createError || !created) {
      throw new Error(`Failed to create user: ${createError?.message ?? "no row returned"}`);
    }
    userId = created.user_id;
  }

  const { data: existingRole, error: roleFindError } = await supabase
    .from("user_project_roles")
    .select("user_project_role_id")
    .eq("user_id", userId)
    .eq("project_id", params.projectId)
    .eq("department_id", params.departmentId)
    .eq("role", params.role)
    .maybeSingle();

  if (roleFindError) {
    throw new Error(`Failed to look up existing role assignment: ${roleFindError.message}`);
  }
  if (existingRole) return; // already assigned — nothing to do

  const { error: roleInsertError } = await supabase.from("user_project_roles").insert({
    user_id: userId,
    project_id: params.projectId,
    department_id: params.departmentId,
    role: params.role,
    status: "Active",
  });

  if (roleInsertError) {
    throw new Error(`Failed to assign role: ${roleInsertError.message}`);
  }
}

/**
 * Deactivates one project/department/role assignment — corrects an
 * accidental Admin Setup assignment (e.g. a worker assigned to the
 * wrong department) without touching the user account itself or any
 * other assignment the same user holds. Soft-deactivate (status set away
 * from "Active"), matching every other status field in this schema
 * (users.status, work_items.status, departments.status), rather than a
 * hard delete — getUserContext/listSelectableUsers already filter
 * strictly on status = 'Active' (see lib/workflow.ts), so this takes
 * effect immediately without any change to those queries. No new table:
 * user_project_roles already exists for exactly this relationship.
 */
/** user_id -> {email, departmentId, isLinked} — the minimum needed to
 * authorize and perform account linking (see linkUserToAuthAccount and
 * app/api/admin/link-auth/route.ts, which resolves project scope from
 * departmentId via getDepartmentProjectId). */
export async function getUserLinkContext(
  supabase: SupabaseClient,
  userId: string
): Promise<{ email: string; departmentId: string; role: string; isLinked: boolean }> {
  const { data, error } = await supabase
    .from("users")
    .select("user_mail, department_id, user_role, auth_user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`User not found: ${error?.message ?? userId}`);
  }

  return {
    email: data.user_mail as string,
    departmentId: data.department_id as string,
    role: data.user_role as string,
    isLinked: !!data.auth_user_id,
  };
}

/**
 * Creates a Supabase Auth account for an EXISTING public.users row and
 * links it via auth_user_id — the only place that column is ever
 * written after the migration that added it. Deliberately NOT "find or
 * create an auth account by matching this email" — that would let a
 * caller silently take over a login for an email that already exists,
 * exactly the "email-only matching, no verification" risk this feature
 * must avoid. This only ever creates a brand-new Auth account tied to
 * one specific, Admin-chosen public.users.user_id; if an Auth account
 * for that email already exists, createUser fails and this throws
 * rather than guessing at what to link.
 *
 * `authAdminClient` must be the service-role client (see
 * lib/supabaseAdmin.ts) — creating an Auth account on someone else's
 * behalf is not something the anon key can do at all, regardless of
 * RLS. Authorization (who may call this, and for which target user) is
 * the caller's responsibility (see app/api/admin/link-auth/route.ts) —
 * this function only refuses an already-linked target, never re-checks
 * role/delegation itself.
 */
export async function linkUserToAuthAccount(
  supabase: SupabaseClient,
  authAdminClient: SupabaseClient,
  params: { targetUserId: string; password: string }
): Promise<void> {
  const target = await getUserLinkContext(supabase, params.targetUserId);
  if (target.isLinked) {
    throw new Error("This account is already linked to a login.");
  }

  const { data: created, error: createError } = await authAdminClient.auth.admin.createUser({
    email: target.email,
    password: params.password,
    email_confirm: true,
  });

  if (createError || !created?.user) {
    throw new Error(`Failed to create login: ${createError?.message ?? "unknown error"}`);
  }

  const { error: updateError } = await supabase
    .from("users")
    .update({ auth_user_id: created.user.id })
    .eq("user_id", params.targetUserId);

  if (updateError) {
    // The Auth account was created but the link failed — surface this
    // clearly rather than silently leaving an orphaned Auth account;
    // an Admin can link it manually (Supabase dashboard) or retry.
    throw new Error(
      `Login created but couldn't be linked to the user record: ${updateError.message}. ` +
        `The Auth account (${target.email}) may need manual linking.`
    );
  }
}

export type UserProjectRoleScope = {
  userId: string;
  projectId: string;
  departmentId: string;
  role: string;
};

/**
 * user_project_role_id -> {userId, projectId, departmentId, role} — the
 * scope a delegated USER_MANAGEMENT check resolves before touching an
 * existing assignment (see app/api/admin/users/route.ts DELETE), and
 * the guard that a delegate can never deactivate an ADMIN's assignment
 * (role is checked there, not here — this is a plain lookup).
 */
export async function getUserProjectRoleScope(
  supabase: SupabaseClient,
  userProjectRoleId: string
): Promise<UserProjectRoleScope> {
  const { data, error } = await supabase
    .from("user_project_roles")
    .select("user_id, project_id, department_id, role")
    .eq("user_project_role_id", userProjectRoleId)
    .single();
  if (error || !data) {
    throw new Error(`Assignment not found: ${error?.message ?? userProjectRoleId}`);
  }
  return {
    userId: data.user_id as string,
    projectId: data.project_id as string,
    departmentId: data.department_id as string,
    role: data.role as string,
  };
}

export async function deactivateUserProjectRole(
  supabase: SupabaseClient,
  userProjectRoleId: string
): Promise<void> {
  const { error } = await supabase
    .from("user_project_roles")
    .update({ status: "Removed" })
    .eq("user_project_role_id", userProjectRoleId);

  if (error) {
    throw new Error(`Failed to remove assignment: ${error.message}`);
  }
}
