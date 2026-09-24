import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserContext, isAdminUser, CONTRACTOR_ROLES } from "./authContext";
import { listDepartments } from "./admin";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";
import { humanizeRole } from "./format";
import {
  type DelegationPermission,
  DELEGATION_PERMISSIONS,
  ADMIN_DELEGATION_PERMISSIONS,
  type Delegation,
} from "./delegationTypes";

/**
 * Temporary Admin -> Contractor delegation (see
 * supabase/migrations/00000000000006_admin_delegations.sql for the
 * original schema rationale, and
 * supabase/migrations/00000000000008_delegation_scopes.sql for the
 * multi-project/multi-department scope this module now reads/writes).
 * Deliberately narrow: only these four capabilities are ever
 * delegatable, and only to a Contractor (SUPERVISOR/MANAGER). Company/
 * Project/Department/User administration stays Admin-only everywhere
 * in this app — never delegable, no matter what a caller asks for.
 *
 * DelegationPermission/DELEGATION_PERMISSIONS/Delegation live in
 * ./delegationTypes (no "server-only") so client components can import
 * them directly without pulling this server-only data-access module
 * into the browser bundle; re-exported here so every existing server-
 * side `from "./delegation"` import keeps working unchanged.
 */
export type { DelegationPermission, Delegation };
export { DELEGATION_PERMISSIONS };

function isCurrentlyActive(row: { status: string; starts_at: string; ends_at: string }): boolean {
  if (row.status !== "Active") return false;
  const now = Date.now();
  return now >= new Date(row.starts_at).getTime() && now < new Date(row.ends_at).getTime();
}

/**
 * Grants a new delegation, scoped to one or more projects, zero or more
 * departments (empty = every department of every selected project — see
 * lib/delegationTypes.ts), and one or more permissions. Verifies the
 * caller is an ADMIN, the delegate is a Contractor other than the
 * caller, and that every selected project/department actually exists
 * and that every department belongs to one of the selected projects
 * (never trusts ids from the client beyond existence/ownership) — a
 * caller can never grant access to a project/department that doesn't
 * exist or wasn't actually offered by crafting the request.
 */
export async function createDelegation(
  supabase: SupabaseClient,
  params: {
    adminUserId: string;
    delegateUserId: string;
    projectIds: string[];
    /** Empty/omitted = whole project(s) — see Delegation.departments doc. */
    departmentIds?: string[];
    permissions: DelegationPermission[];
    startsAt: string;
    endsAt: string;
    reason?: string | null;
  }
): Promise<void> {
  if (!(await isAdminUser(supabase, params.adminUserId))) {
    throw new Error(`User ${params.adminUserId} is not authorized to create a delegation.`);
  }

  if (params.adminUserId === params.delegateUserId) {
    throw new Error("Cannot delegate to yourself.");
  }

  const delegateCtx = await getUserContext(supabase, params.delegateUserId);
  if (!CONTRACTOR_ROLES.includes(delegateCtx.role)) {
    throw new Error(
      `Delegation is only supported to a Contractor; ${params.delegateUserId} has role ${humanizeRole(delegateCtx.role)}.`
    );
  }

  const permissions = [...new Set(params.permissions)];
  if (permissions.length === 0) {
    throw new Error("At least one permission must be delegated.");
  }
  const invalidPermissions = permissions.filter((p) => !DELEGATION_PERMISSIONS.includes(p));
  if (invalidPermissions.length > 0) {
    throw new Error(`Unknown permission(s): ${invalidPermissions.join(", ")}`);
  }

  const projectIds = [...new Set(params.projectIds)];
  if (projectIds.length === 0) {
    throw new Error("At least one project must be selected.");
  }

  const departmentIds = [...new Set(params.departmentIds ?? [])];

  const startsAt = new Date(params.startsAt);
  const endsAt = new Date(params.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new Error("startsAt/endsAt must be valid dates.");
  }
  if (endsAt <= startsAt) {
    throw new Error("endsAt must be after startsAt.");
  }

  const { data: projectRows, error: projectError } = await supabase
    .from("projects")
    .select("project_id")
    .in("project_id", projectIds);
  if (projectError) throw new Error(`Failed to verify projects: ${projectError.message}`);
  if ((projectRows ?? []).length !== projectIds.length) {
    throw new Error("One or more selected projects were not found.");
  }

  if (departmentIds.length > 0) {
    const { data: departmentRows, error: departmentError } = await supabase
      .from("departments")
      .select("department_id, project_id")
      .in("department_id", departmentIds);
    if (departmentError) throw new Error(`Failed to verify departments: ${departmentError.message}`);
    if ((departmentRows ?? []).length !== departmentIds.length) {
      throw new Error("One or more selected departments were not found.");
    }
    const projectIdSet = new Set(projectIds);
    const invalidDepartment = (departmentRows ?? []).find((d) => !projectIdSet.has(d.project_id));
    if (invalidDepartment) {
      throw new Error(
        `Department ${invalidDepartment.department_id} does not belong to any of the selected projects.`
      );
    }
  }

  // From here on, every write is to admin_delegations/delegation_* —
  // the 8 tables being prepared for service-role-only RLS (see the P0
  // audit) — so this uses a dedicated service-role client, while the
  // existence checks above (projects/departments, not in that set) keep
  // using the caller-supplied `supabase` unchanged.
  const serviceSupabase = getSupabaseServiceRoleClient();

  const { data: created, error } = await serviceSupabase
    .from("admin_delegations")
    .insert({
      admin_user_id: params.adminUserId,
      delegate_user_id: params.delegateUserId,
      status: "Active",
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      reason: params.reason?.trim() || null,
    })
    .select("delegation_id")
    .single();

  if (error || !created) {
    throw new Error(`Failed to create delegation: ${error?.message ?? "no row returned"}`);
  }

  const delegationId = created.delegation_id as string;

  const { error: projectsInsertError } = await serviceSupabase
    .from("delegation_projects")
    .insert(projectIds.map((projectId) => ({ delegation_id: delegationId, project_id: projectId })));
  if (projectsInsertError) {
    throw new Error(`Failed to save delegated projects: ${projectsInsertError.message}`);
  }

  const { error: permissionsInsertError } = await serviceSupabase
    .from("delegation_permissions")
    .insert(permissions.map((permission) => ({ delegation_id: delegationId, permission })));
  if (permissionsInsertError) {
    throw new Error(`Failed to save delegated permissions: ${permissionsInsertError.message}`);
  }

  if (departmentIds.length > 0) {
    const { error: departmentsInsertError } = await serviceSupabase
      .from("delegation_departments")
      .insert(
        departmentIds.map((departmentId) => ({ delegation_id: delegationId, department_id: departmentId }))
      );
    if (departmentsInsertError) {
      throw new Error(`Failed to save delegated departments: ${departmentsInsertError.message}`);
    }
  }
}

const DELEGATION_SELECT =
  "delegation_id, admin_user_id, delegate_user_id, status, starts_at, ends_at, reason, " +
  "admin:users!admin_delegations_admin_user_id_fkey(user_mail), " +
  "delegate:users!admin_delegations_delegate_user_id_fkey(user_mail), " +
  "delegation_projects(project_id, projects(project_name)), " +
  "delegation_departments(department_id, departments(department_name, project_id)), " +
  "delegation_permissions(permission)";

type DelegationRow = {
  delegation_id: string;
  admin_user_id: string;
  delegate_user_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  admin: { user_mail: string } | { user_mail: string }[] | null;
  delegate: { user_mail: string } | { user_mail: string }[] | null;
  delegation_projects:
    | { project_id: string; projects: { project_name: string } | { project_name: string }[] | null }[]
    | null;
  delegation_departments:
    | {
        department_id: string;
        departments:
          | { department_name: string; project_id: string }
          | { department_name: string; project_id: string }[]
          | null;
      }[]
    | null;
  delegation_permissions: { permission: string }[] | null;
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

function toDelegation(row: DelegationRow): Delegation {
  const projects = (row.delegation_projects ?? []).map((dp) => ({
    projectId: dp.project_id,
    projectName: one(dp.projects)?.project_name ?? "(unknown)",
  }));

  const departments = (row.delegation_departments ?? []).map((dd) => {
    const dept = one(dd.departments);
    return {
      departmentId: dd.department_id,
      departmentName: dept?.department_name ?? "(unknown)",
      projectId: dept?.project_id ?? "",
    };
  });

  return {
    delegationId: row.delegation_id,
    adminUserId: row.admin_user_id,
    adminEmail: one(row.admin)?.user_mail ?? "(unknown)",
    delegateUserId: row.delegate_user_id,
    delegateEmail: one(row.delegate)?.user_mail ?? "(unknown)",
    projects,
    departments,
    permissions: (row.delegation_permissions ?? []).map((p) => p.permission) as DelegationPermission[],
    status: row.status as "Active" | "Revoked",
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reason: row.reason,
    isCurrentlyActive: isCurrentlyActive(row),
  };
}

/** Every delegation ever created — the Admin's management list. Admin
 * has project-wide visibility everywhere else in this app; this is no
 * different. ADMIN-only, same as every other write/read in this file. */
export async function listDelegations(
  supabase: SupabaseClient,
  adminUserId: string
): Promise<Delegation[]> {
  if (!(await isAdminUser(supabase, adminUserId))) {
    throw new Error(`User ${adminUserId} is not authorized to list delegations.`);
  }

  // admin_delegations (+ its embedded users/projects/departments joins in
  // DELEGATION_SELECT) is one of the 8 tables being prepared for
  // service-role-only RLS — see the P0 audit.
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("admin_delegations")
    .select(DELEGATION_SELECT)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load delegations: ${error.message}`);
  }

  return ((data ?? []) as unknown as DelegationRow[]).map(toDelegation);
}

/** Ends a delegation immediately, regardless of ends_at — the Admin
 * taking back a capability early (e.g. Admin is back sooner than
 * planned). ADMIN-only; a Contractor can never revoke their own or
 * anyone else's delegation. The delegation row (and its
 * delegation_projects/delegation_departments/delegation_permissions
 * children) is kept, not deleted, so it still shows up in
 * listDelegations as history — only status/revoked_at change. */
export async function revokeDelegation(
  supabase: SupabaseClient,
  params: { adminUserId: string; delegationId: string }
): Promise<void> {
  if (!(await isAdminUser(supabase, params.adminUserId))) {
    throw new Error(`User ${params.adminUserId} is not authorized to revoke delegations.`);
  }

  const { error } = await getSupabaseServiceRoleClient()
    .from("admin_delegations")
    .update({ status: "Revoked", revoked_at: new Date().toISOString() })
    .eq("delegation_id", params.delegationId);

  if (error) {
    throw new Error(`Failed to revoke delegation: ${error.message}`);
  }
}

type ActiveDelegationRow = {
  delegation_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  delegation_projects: { project_id: string }[] | null;
  delegation_departments: { department_id: string; departments: { project_id: string } | { project_id: string }[] | null }[] | null;
  delegation_permissions: { permission: string }[] | null;
};

/** Every Active admin_delegations row for `userId`, with just enough
 * nested shape (project ids, department ids + their own project id,
 * permission codes) to evaluate hasDelegatedPermission — shared by
 * hasDelegatedPermission and nothing else, kept separate from
 * DELEGATION_SELECT (which additionally joins names/emails for display,
 * unneeded for an authorization check). */
async function getActiveDelegationRowsForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<ActiveDelegationRow[]> {
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("admin_delegations")
    .select(
      "delegation_id, status, starts_at, ends_at, delegation_projects(project_id), delegation_departments(department_id, departments(project_id)), delegation_permissions(permission)"
    )
    .eq("delegate_user_id", userId)
    .eq("status", "Active");

  if (error) {
    throw new Error(`Failed to check delegation: ${error.message}`);
  }
  return (data ?? []) as unknown as ActiveDelegationRow[];
}

/**
 * Whether `userId` currently holds `permission` scoped to `scope` —
 * the check every delegation-aware server action runs before allowing
 * a Contractor to do something that would normally require Admin.
 * "Currently" is evaluated at call time (status = 'Active' AND now
 * within [starts_at, ends_at)), so an expired or revoked delegation
 * stops granting access on its very next check — no cleanup job, no
 * stale grant.
 *
 * A delegation matches `scope.projectId` only if it actually includes
 * that project (delegation_projects). Within a matching project, if the
 * delegation has zero delegation_departments rows belonging to that
 * SAME project, it's whole-project scope for that project (matches any
 * department); if it has one or more, only those exact departments
 * match — evaluated per-project so one delegation can be whole-project
 * for Project A and department-restricted for Project B at the same
 * time (see lib/delegationTypes.ts Delegation.departments doc).
 *
 * PROJECT_MANAGEMENT is the one exception to department narrowing: a
 * project's own details (name/location) aren't "inside" any one
 * department, so a delegation combining PROJECT_MANAGEMENT with
 * department-restricted DEPARTMENT_MANAGEMENT/WORK_ITEM_MANAGEMENT/etc.
 * (a very plausible "broader admin" grant) must not have those same
 * department restrictions incorrectly block editing the project itself
 * — see PROJECT_LEVEL_ONLY_PERMISSIONS below.
 */
const PROJECT_LEVEL_ONLY_PERMISSIONS: DelegationPermission[] = ["PROJECT_MANAGEMENT"];

export async function hasDelegatedPermission(
  supabase: SupabaseClient,
  userId: string,
  permission: DelegationPermission,
  scope: { projectId: string; departmentId?: string | null }
): Promise<boolean> {
  const rows = await getActiveDelegationRowsForUser(supabase, userId);

  return rows.some((row) => {
    if (!isCurrentlyActive(row)) return false;

    const permissions = (row.delegation_permissions ?? []).map((p) => p.permission);
    if (!permissions.includes(permission)) return false;

    const projectIds = (row.delegation_projects ?? []).map((p) => p.project_id);
    if (!projectIds.includes(scope.projectId)) return false;

    if (PROJECT_LEVEL_ONLY_PERMISSIONS.includes(permission)) return true;

    const departmentsForThisProject = (row.delegation_departments ?? []).filter(
      (d) => one(d.departments)?.project_id === scope.projectId
    );
    if (departmentsForThisProject.length === 0) return true; // whole-project scope
    return (
      scope.departmentId != null &&
      departmentsForThisProject.some((d) => d.department_id === scope.departmentId)
    );
  });
}

/** Every currently-active delegation grant held by `userId` — used to
 * decide which delegated-admin UI sections to show on the Contractor
 * dashboard (see app/workflow/supervisor/page.tsx). */
export async function getActiveDelegationsForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<Delegation[]> {
  const { data, error } = await getSupabaseServiceRoleClient()
    .from("admin_delegations")
    .select(DELEGATION_SELECT)
    .eq("delegate_user_id", userId)
    .eq("status", "Active");

  if (error) {
    throw new Error(`Failed to load delegations: ${error.message}`);
  }

  return ((data ?? []) as unknown as DelegationRow[])
    .map(toDelegation)
    .filter((d) => d.isCurrentlyActive);
}

/**
 * Strict Admin-only gate — for the master-data admin actions that are
 * deliberately never delegable (Companies, Projects, Departments,
 * Users; see the migration doc for admin_delegations). Every
 * /api/admin/* route must call one of the two functions in this
 * section before doing anything, exactly like every Worker/Foreman/
 * Supervisor route already calls assertRole — an admin route with no
 * check at all is the one gap this pair closes.
 */
export async function assertAdminRole(
  supabase: SupabaseClient,
  actorUserId: string
): Promise<void> {
  if (!(await isAdminUser(supabase, actorUserId))) {
    throw new Error(`User ${actorUserId} is not authorized for this action (Admin required).`);
  }
}

/**
 * Admin-or-delegated gate — for the subset of admin actions that CAN
 * be temporarily handed to a Contractor (Work Item Management right
 * now; see DelegationPermission). Passes for a plain ADMIN
 * unconditionally, or for a Contractor holding an active, correctly
 * scoped delegation for `permission`. Throws otherwise.
 */
export async function assertAdminOrDelegated(
  supabase: SupabaseClient,
  params: {
    actorUserId: string;
    permission: DelegationPermission;
    projectId: string;
    departmentId?: string | null;
  }
): Promise<void> {
  if (await isAdminUser(supabase, params.actorUserId)) return;

  const ctx = await getUserContext(supabase, params.actorUserId);
  if (CONTRACTOR_ROLES.includes(ctx.role)) {
    const ok = await hasDelegatedPermission(supabase, params.actorUserId, params.permission, {
      projectId: params.projectId,
      departmentId: params.departmentId,
    });
    if (ok) return;
  }

  throw new Error(
    `${ctx.role} ${params.actorUserId} is not authorized for this action (requires Admin or an active ${params.permission} delegation).`
  );
}

export type AdminSetupAccess = {
  isRealAdmin: boolean;
  /** Whether this caller may reach Admin Setup at all — true for a
   * real Admin, or a Contractor holding at least one currently-active
   * delegation for an administrative permission (see
   * ADMIN_DELEGATION_PERMISSIONS). A Contractor's own home department
   * grants nothing here by default — unlike the workflow dashboards,
   * Admin Setup access has always been Admin-only unless explicitly
   * delegated (see app/admin/setup/page.tsx). */
  canEnter: boolean;
  /** "ALL" for a real Admin; otherwise every project covered by an
   * active administrative delegation. */
  projectIds: Set<string> | "ALL";
  /** Same, for departments — a project with no specific
   * delegation_departments rows expands to every department in it
   * (whole-project), same semantics as hasDelegatedPermission. */
  departmentIds: Set<string> | "ALL";
  /** Union of every administrative permission currently granted by an
   * active delegation — which Admin Setup tabs/actions to show. Empty
   * for a real Admin (irrelevant: they can do everything regardless). */
  permissions: Set<DelegationPermission>;
};

/**
 * Resolves whether/how much of Admin Setup a caller may reach —
 * gates app/admin/setup/page.tsx itself (previously strict Admin-only
 * at the page level, which made every delegation-aware API check in
 * this module unreachable from the UI for a delegated Contractor) and
 * tells that page which projects/departments/permissions to filter
 * every tab's data down to, so a delegated Contractor is never even
 * shown data outside their scope, not just blocked from writing to it.
 */
export async function resolveAdminSetupAccess(
  supabase: SupabaseClient,
  userId: string
): Promise<AdminSetupAccess> {
  if (await isAdminUser(supabase, userId)) {
    return {
      isRealAdmin: true,
      canEnter: true,
      projectIds: "ALL",
      departmentIds: "ALL",
      permissions: new Set(DELEGATION_PERMISSIONS),
    };
  }

  const projectIds = new Set<string>();
  const departmentIds = new Set<string>();
  const permissions = new Set<DelegationPermission>();

  const activeDelegations = await getActiveDelegationsForUser(supabase, userId).catch(() => []);
  if (activeDelegations.length > 0) {
    const allDepartments = await listDepartments(supabase);
    for (const delegation of activeDelegations) {
      const adminPermissions = delegation.permissions.filter((p) =>
        (ADMIN_DELEGATION_PERMISSIONS as string[]).includes(p)
      );
      if (adminPermissions.length === 0) continue;

      for (const permission of adminPermissions) permissions.add(permission);

      for (const project of delegation.projects) {
        projectIds.add(project.projectId);
        const departmentsForProject = delegation.departments.filter(
          (d) => d.projectId === project.projectId
        );
        const ids =
          departmentsForProject.length > 0
            ? departmentsForProject.map((d) => d.departmentId)
            : allDepartments.filter((d) => d.projectId === project.projectId).map((d) => d.departmentId);
        ids.forEach((id) => departmentIds.add(id));
      }
    }
  }

  return {
    isRealAdmin: false,
    canEnter: projectIds.size > 0,
    projectIds,
    departmentIds,
    permissions,
  };
}
