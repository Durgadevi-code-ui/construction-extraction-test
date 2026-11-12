import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { humanizeRole } from "./format";

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
  options?: { projectId?: string; departmentId?: string }
) {
  const { data, error } = await supabase
    .from("user_project_roles")
    .select(
      "user_id, role, project_id, department_id, projects(project_name), departments(department_name)"
    )
    .eq("user_id", userId)
    .eq("status", "Active")
    // Deterministic "first row" for users holding several assignments:
    // without an order Postgres may return them in any order, so the same
    // user could land on a different role's dashboard from one visit to
    // the next. Oldest assignment first matches the order rows were
    // observed in (2026-10-31), so today's routing is unchanged.
    .order("created_at", { ascending: true })
    .order("user_project_role_id", { ascending: true });

  if (error) {
    throw new Error(`Failed to look up project/department assignment for user ${userId}: ${error.message}`);
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    throw new Error(`No active project/department assignment found for user ${userId}: no matching row`);
  }

  // departmentId (optional, additive) narrows within the chosen project
  // for a user holding more than one department there; like projectId it
  // only ever picks among the caller's OWN Active rows and falls back
  // (to the project's first row, then the first row overall) rather than
  // failing — it can never select a row the user doesn't hold.
  const selected =
    (options?.projectId && options?.departmentId
      ? rows.find((row) => row.project_id === options.projectId && row.department_id === options.departmentId)
      : null) ??
    (options?.projectId ? rows.find((row) => row.project_id === options.projectId) : null) ??
    rows[0];

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
        /** This row's role — a user can hold different roles on different
         * projects/departments (additive field). */
        role: row.role as string,
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

/**
 * An ADMIN account's project authority (see
 * supabase/migrations/00000000000025_admin_scopes.sql):
 *   - "ALL"      -> a GLOBAL admin (no admin_scopes rows): the existing,
 *                  unchanged behavior — authority over every project/company.
 *   - Set<id>    -> a SCOPED admin: authority ONLY within those project ids.
 *                  Global/credential operations are still refused (see
 *                  isGlobalAdmin and the admin routes).
 *   - null       -> not an ADMIN.
 *
 * isAdminUser() above is deliberately left unchanged (it still answers "is the
 * role ADMIN", used for routing/labels and the many workflow checks that key
 * on it) — authorization that must respect scope uses the helpers below, never
 * isAdminUser alone. This is the one function that reads admin_scopes.
 */
export type AdminScope = "ALL" | Set<string>;

function isMissingAdminScopesTable(err: { code?: string; message?: string } | null): boolean {
  const s = `${err?.code ?? ""} ${err?.message ?? ""}`.toLowerCase();
  return (
    s.includes("42p01") ||
    s.includes("pgrst205") ||
    s.includes("does not exist") ||
    s.includes("could not find the table") ||
    s.includes("schema cache")
  );
}

export async function getAdminScope(supabase: SupabaseClient, userId: string): Promise<AdminScope | null> {
  const { data: adminRow, error: adminError } = await supabase
    .from("users")
    .select("user_id")
    .eq("user_id", userId)
    .eq("user_role", "ADMIN")
    .eq("status", "Active")
    .maybeSingle();
  if (adminError) throw new Error(`Failed to verify admin user: ${adminError.message}`);
  if (!adminRow) return null; // not an admin

  const { data: scopes, error: scopeError } = await supabase
    .from("admin_scopes")
    .select("project_id")
    .eq("user_id", userId);
  if (scopeError) {
    // Table not created yet (migration not applied) -> no scoped admins can
    // exist, so every ADMIN is a legacy GLOBAL admin (existing behavior).
    // Any OTHER error fails closed: an empty scope grants no project authority
    // and is not a global admin, so a transient lookup failure can never widen
    // a scoped admin into a global one.
    return isMissingAdminScopesTable(scopeError) ? "ALL" : new Set<string>();
  }
  const ids = (scopes ?? []).map((r) => r.project_id as string).filter(Boolean);
  return ids.length === 0 ? "ALL" : new Set(ids);
}

/** True only for a GLOBAL admin (ADMIN with no admin_scopes rows). Every
 * global/credential operation (company management, project creation,
 * delegation management, ADMIN creation/promotion) gates on THIS, never on
 * isAdminUser, so a scoped admin is denied them and fails closed. */
export async function isGlobalAdmin(supabase: SupabaseClient, userId: string): Promise<boolean> {
  return (await getAdminScope(supabase, userId)) === "ALL";
}

/** Whether an ADMIN may act on / see a specific project: global -> always;
 * scoped -> only if the project is in its scope; non-admin -> false. A
 * fail-closed drop-in for `isAdminUser` at every project-scoped admin check:
 * a global admin behaves exactly as before, a scoped admin is confined, and a
 * non-admin falls through to the existing role logic unchanged. */
export async function adminCanAccessProject(
  supabase: SupabaseClient,
  userId: string,
  projectId: string
): Promise<boolean> {
  const scope = await getAdminScope(supabase, userId);
  if (scope === null) return false;
  return scope === "ALL" || scope.has(projectId);
}

/** SUPERVISOR and MANAGER are the same Contractor-level role for
 * authorization purposes everywhere in this app. */
export const CONTRACTOR_ROLES = ["SUPERVISOR", "MANAGER"];

/** The dashboard page for a role — the same mapping app/workflow/page.tsx
 * routes a signed-in user by. Null for a role with no such page. */
export function roleHomePath(role: string): string | null {
  if (role === "WORKER") return "/workflow/worker";
  if (role === "FOREMAN") return "/workflow/foreman";
  if (CONTRACTOR_ROLES.includes(role)) return "/workflow/supervisor";
  return null;
}

/**
 * Options for the header Project dropdown (components/workflow/
 * ProjectSelect) — one per project + department the user holds an
 * Active role in (getUserContext's availableProjects), across ALL their
 * roles, each pointing at that role's page. A user who is e.g. a
 * Subcontractor on one project and a Contractor on another can then
 * always switch back, instead of each page listing only its own role's
 * single project (which hides the dropdown). Navigation only: the page
 * reached still resolves the pair with getUserContext among the user's
 * own roles and checks the role itself.
 */
export function projectSwitchOptions(
  availableProjects: { role: string; projectId: string; projectName: string; departmentId: string; departmentName: string }[]
): { projectId: string; projectName: string; departmentId: string; departmentName: string; path: string; roleLabel: string }[] {
  const options = new Map<string, ReturnType<typeof projectSwitchOptions>[number]>();
  for (const row of availableProjects) {
    const path = roleHomePath(row.role);
    if (!path) continue;
    const key = `${path}:${row.projectId}:${row.departmentId}`;
    if (!options.has(key)) {
      options.set(key, {
        projectId: row.projectId,
        projectName: row.projectName,
        departmentId: row.departmentId,
        departmentName: row.departmentName,
        path,
        roleLabel: humanizeRole(row.role),
      });
    }
  }
  return [...options.values()];
}

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
