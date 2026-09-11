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
 * KNOWN LIMITATION (documented, not fixed, as of this writing — see the
 * P0 security review): `.single()` below assumes exactly one Active
 * user_project_roles row per user, and THROWS if a user has more than
 * one. There is no multi-project-selection flow anywhere in this app
 * (no "pick a project after login" screen) — every Worker/Foreman/
 * Supervisor/Manager is assumed to hold exactly one active role in
 * exactly one project+department at a time. The schema itself does not
 * prevent a second Active row (nothing stops an Admin from granting a
 * user two), so doing so today would break every page/route that calls
 * this function for that user, not just silently pick one. This is left
 * as-is because: (a) nothing currently in this app creates or requires
 * a multi-project user — Admin Setup's user creation flow does not
 * offer "add a second role," and (b) supporting it correctly needs an
 * actual UI (project selection after login) and a decision about how
 * delegation/notifications/dashboards behave per-project, not just a
 * relaxed query here. If multi-project support becomes an actual
 * requirement, the smallest safe fix is: change this query to return
 * all Active rows, add a project-selection step (e.g. a `?projectId=`
 * param or a cookie) for any caller with more than one, and keep
 * returning a single resolved context exactly as today for the
 * (still-common) single-role case — not a broader redesign.
 */
export async function getUserContext(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from("user_project_roles")
    .select(
      "user_id, role, project_id, department_id, projects(project_name), departments(department_name)"
    )
    .eq("user_id", userId)
    .eq("status", "Active")
    .single();

  if (error || !data) {
    throw new Error(
      `No active project/department assignment found for user ${userId}: ${
        error?.message ?? "no matching row"
      }`
    );
  }

  const projects = Array.isArray(data.projects)
    ? data.projects[0]
    : data.projects;
  const departments = Array.isArray(data.departments)
    ? data.departments[0]
    : data.departments;

  return {
    userId: data.user_id as string,
    role: data.role as string,
    projectId: data.project_id as string,
    projectName: (projects?.project_name as string) ?? "(unknown project)",
    departmentId: data.department_id as string,
    departmentName:
      (departments?.department_name as string) ?? "(unknown department)",
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
