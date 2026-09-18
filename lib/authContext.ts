import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The role/project/department context a caller acts under — shared by
 * lib/workflow.ts (Worker/Foreman/Supervisor actions) and
 * lib/delegation.ts (Admin delegation checks), both of which need it
 * and would otherwise import each other (workflow -> delegation for
 * delegated-permission checks, delegation -> workflow for this).
 * Extracted here instead so both import one shared root, no cycle.
 *
 * Identity comes from the server-verified session (lib/session.ts
 * getCurrentUser()), never a client-supplied id — this is the one place
 * that turns that id into "who are you, and what are you allowed to
 * touch", looked up from user_project_roles.
 *
 * MULTI-PROJECT: a user can hold more than one Active user_project_roles
 * row (nothing in the schema prevents it — see prior version of this
 * comment/the P0 security review). This function used to call
 * `.single()`, which THROWS the moment a second Active row exists for
 * anyone. It no longer does: it fetches every Active row and resolves
 * ONE of them exactly as before —
 *   - `options.projectId` given -> the row for that project (falls back
 *     to the first row if the user has no Active row in that project,
 *     same as never having asked, rather than a hard error — a stale or
 *     tampered `?projectId=` should degrade gracefully, not crash the
 *     page).
 *   - not given (the default, and every existing call site) -> the
 *     first row, i.e. identical behavior to the single-role case this
 *     app has always run on. A user with one Active row is completely
 *     unaffected by this change.
 * The returned `availableProjects` list is additive (new field, nothing
 * removed) — it's what lets a specific page build a "switch project"
 * control when a user actually has more than one, without every one of
 * this function's ~20 existing call sites needing to change at all.
 */
export async function getUserContext(
  supabase: SupabaseClient,
  userId: string,
  options?: { projectId?: string }
) {
  const { data, error } = await supabase
    .from("user_project_roles")
    .select(
      "user_id, role, project_id, department_id, projects(project_name), departments(department_name)"
    )
    .eq("user_id", userId)
    .eq("status", "Active");

  if (error) {
    throw new Error(`Failed to look up project/department assignment for user ${userId}: ${error.message}`);
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    throw new Error(`No active project/department assignment found for user ${userId}: no matching row`);
  }

  const selected = (options?.projectId ? rows.find((row) => row.project_id === options.projectId) : null) ?? rows[0];

  const projects = Array.isArray(selected.projects) ? selected.projects[0] : selected.projects;
  const departments = Array.isArray(selected.departments) ? selected.departments[0] : selected.departments;

  return {
    userId: selected.user_id as string,
    role: selected.role as string,
    projectId: selected.project_id as string,
    projectName: (projects?.project_name as string) ?? "(unknown project)",
    departmentId: selected.department_id as string,
    departmentName:
      (departments?.department_name as string) ?? "(unknown department)",
    /** Every Active project/department this user holds (length 1 for
     * the still-common single-role case) — for building a project
     * switcher. Not sorted/deduped beyond what the query already
     * returns. */
    availableProjects: rows.map((row) => {
      const p = Array.isArray(row.projects) ? row.projects[0] : row.projects;
      const d = Array.isArray(row.departments) ? row.departments[0] : row.departments;
      return {
        projectId: row.project_id as string,
        projectName: (p?.project_name as string) ?? "(unknown project)",
        departmentId: row.department_id as string,
        departmentName: (d?.department_name as string) ?? "(unknown department)",
      };
    }),
  };
}

/**
 * Whether `userId` is an Active ADMIN — checked directly against
 * users.user_role, deliberately NOT via getUserContext/
 * user_project_roles. Admin is not scoped to one project/department
 * the way Worker/Foreman/Supervisor are (see lib/admin.ts module doc:
 * "a user with users.user_role = 'ADMIN' is 'the admin'... enforced in
 * app/admin/* pages"), and critically, an Admin created through the
 * original bootstrap flow (bootstrapAdminUser) never gets a
 * user_project_roles row at all — only Admins created later via Admin
 * Setup -> Users happen to get one (createUserWithRole always adds
 * both). Calling getUserContext for an Admin check would throw for the
 * bootstrap case ("no active project/department assignment"), which is
 * exactly the account this app's first real Admin usually is — so every
 * Admin-authorization check in this app must go through this function,
 * never getUserContext.
 */
export async function isAdminUser(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("users")
    .select("user_id")
    .eq("user_id", userId)
    .eq("user_role", "ADMIN")
    .eq("status", "Active")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify admin user: ${error.message}`);
  }
  return !!data;
}

/** SUPERVISOR and MANAGER are the same Contractor-level role for
 * authorization purposes everywhere in this app. */
export const CONTRACTOR_ROLES = ["SUPERVISOR", "MANAGER"];

/**
 * The role an actor is currently acting under, for display purposes
 * (e.g. notification text: "reviewed by Contractor Ravi") — checks
 * isAdminUser first for the same reason every other Admin-aware check
 * in this app does (a bootstrap-created Admin has no user_project_roles
 * row, so getUserContext would throw for exactly that account; see
 * isAdminUser's doc above).
 */
export async function resolveActorRole(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  if (await isAdminUser(supabase, userId)) return "ADMIN";
  const ctx = await getUserContext(supabase, userId);
  return ctx.role;
}

/** Role check shared by every write action across this app — department
 * ownership alone isn't enough, since department is per-user, not
 * per-role: a WORKER and a FOREMAN can share the same department, and
 * only the role should decide whether an action is permitted at all. */
export function assertRole(role: string, allowed: string[]): void {
  if (!allowed.includes(role)) {
    throw new Error(`Role ${role} is not authorized for this action`);
  }
}
