import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeEmail } from "./authAccounts";
import { isDemoAccountEmail } from "./demoEmail";

/**
 * Role-based one-click Demo Login (app/demo-login): pick a role and a
 * trade, click "Enter Demo Workspace", and the server signs in as that
 * role's dedicated demo account, which is a member of the EXISTING
 * project(s) (DEMO_PROJECT_IDS — owner's decision: New York City
 * Commercial Building and Test Project B). Nobody types an email or a
 * password.
 *
 * Same experience as the old picker (removed in 6edf342), different
 * accounts and a different sign-in:
 *   - The old picker logged in AS 16 real people (the real Admin included)
 *     by minting a magic-link session with the service-role key, so anyone
 *     who opened /login became that person. Every slot here is a dedicated
 *     demo account (its own identity, e.g. "Demo Worker Electrical") with
 *     an ordinary role in the existing project, confined to the configured
 *     project(s), verified on every sign-in and every request
 *     (checkDemoAccount below).
 *   - Sign-in is Supabase's own password sign-in (signInWithPassword) with
 *     the slot's password, which lives only in server-side configuration.
 *     The browser sends a slot KEY from the closed list below — never an
 *     email, a password or a user id. No magic link, no session minted
 *     with the service-role key.
 *   - "Admin" is not a real ADMIN (an Admin controls every company,
 *     project, user and password). It is a Contractor-role demo account
 *     holding an admin delegation scoped to the configured project(s),
 *     without user management (so visitors can't create logins or reset
 *     anyone's password).
 *
 * Configuration (server-only; off unless all of it is present):
 *   DEMO_LOGIN_ENABLED=true
 *   DEMO_PROJECT_IDS=<the existing project id[,…] demo accounts may work in>
 *   DEMO_LOGIN_<SLOT>_EMAIL / DEMO_LOGIN_<SLOT>_PASSWORD for each slot
 *     offered, e.g. DEMO_LOGIN_WORKER_ELECTRICAL_EMAIL. A slot without both
 *     values, or whose email is not @example.com, is not offered.
 *   DEMO_LOGIN_EMAILS (optional): further demo emails held to the same
 *     isolation rules.
 * New variable names, so the old demo-mode settings (which point at real
 * accounts) enable nothing.
 *
 * checkDemoAccount() — all must hold, or the session is refused:
 *   1. linked, Active app user with that same email;
 *   2. not an Admin;
 *   3. at least one Active project role, every one of them in a configured
 *      project — non-admin data access in this app is scoped by exactly
 *      these rows (lib/authContext.ts getUserContext);
 *   4. any Active admin delegation covers configured projects only and
 *      does not include USER_MANAGEMENT;
 *   5. at sign-in only: the account holds only the slot's role, in the
 *      slot's team, and only the Admin slot holds a delegation.
 * Demo sessions are read-only: proxy.ts refuses their non-GET /api
 * requests, so they see what the role sees but can't change project data.
 * Checks 1–4 run again on every request (demoSessionAllowed, from
 * lib/session.ts getCurrentUser), so a demo account that signed in on
 * /login, or whose roles changed afterwards, loses app access at once.
 */

export type DemoSlot = {
  key: string;
  /** Role group shown in the picker. */
  group: "Admin" | "Contractor" | "Subcontractor" | "Worker";
  /** Trade / team shown in the picker; also the account's department name. */
  team: string;
  /** The account's user_project_roles.role. */
  role: "SUPERVISOR" | "FOREMAN" | "WORKER";
  department: string;
  /** Holds an admin delegation scoped to the demo project (the Admin slot). */
  delegatedAdmin?: true;
};

// Fixed order: Admin, Contractors, Subcontractors, Workers (as the old
// picker). Departments are the existing project's own.
export const DEMO_SLOTS: readonly DemoSlot[] = [
  { key: "admin_demo", group: "Admin", team: "Project administration", role: "SUPERVISOR", department: "Electrical Department", delegatedAdmin: true },
  { key: "contractor_electrical", group: "Contractor", team: "Electrical", role: "SUPERVISOR", department: "Electrical Department" },
  { key: "contractor_plumbing", group: "Contractor", team: "Plumbing", role: "SUPERVISOR", department: "Plumbing Department" },
  { key: "contractor_concrete", group: "Contractor", team: "Concrete", role: "SUPERVISOR", department: "Concrete Department" },
  { key: "subcontractor_electrical", group: "Subcontractor", team: "Electrical", role: "FOREMAN", department: "Electrical Department" },
  { key: "subcontractor_plumbing", group: "Subcontractor", team: "Plumbing", role: "FOREMAN", department: "Plumbing Department" },
  { key: "subcontractor_concrete", group: "Subcontractor", team: "Concrete", role: "FOREMAN", department: "Concrete Department" },
  { key: "worker_electrical", group: "Worker", team: "Electrical", role: "WORKER", department: "Electrical Department" },
  { key: "worker_plumbing", group: "Worker", team: "Plumbing", role: "WORKER", department: "Plumbing Department" },
  { key: "worker_concrete", group: "Worker", team: "Concrete", role: "WORKER", department: "Concrete Department" },
];

/** Delegated permissions that must never reach a demo account: they would
 * let a visitor create logins or reset other demo accounts' passwords. */
const FORBIDDEN_DEMO_PERMISSIONS = new Set(["USER_MANAGEMENT"]);

export type DemoLoginConfig = {
  enabled: boolean;
  /** Every demo email (slot accounts + DEMO_LOGIN_EMAILS). */
  emails: Set<string>;
  projectIds: Set<string>;
  /** Slot key -> its account. Server-only: holds passwords. */
  accounts: Map<string, { email: string; password: string }>;
};

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function demoLoginConfig(env: Record<string, string | undefined> = process.env): DemoLoginConfig {
  const accounts = new Map<string, { email: string; password: string }>();
  for (const slot of DEMO_SLOTS) {
    const prefix = `DEMO_LOGIN_${slot.key.toUpperCase()}`;
    const email = normalizeEmail(env[`${prefix}_EMAIL`]);
    const password = env[`${prefix}_PASSWORD`] ?? "";
    if (isDemoAccountEmail(email) && password) accounts.set(slot.key, { email, password });
  }
  const emails = new Set(
    [...list(env.DEMO_LOGIN_EMAILS).map(normalizeEmail), ...[...accounts.values()].map((a) => a.email)].filter(isDemoAccountEmail)
  );
  const projectIds = new Set(list(env.DEMO_PROJECT_IDS));
  return {
    enabled: env.DEMO_LOGIN_ENABLED === "true" && emails.size > 0 && projectIds.size > 0,
    emails,
    projectIds,
    accounts,
  };
}

export function demoSlot(key: unknown): DemoSlot | undefined {
  return typeof key === "string" ? DEMO_SLOTS.find((slot) => slot.key === key) : undefined;
}

export type DemoRoleOption = Pick<DemoSlot, "key" | "group" | "team">;

/** The slots this server can actually sign in as — no email, no password;
 * safe to hand to a Client Component. Empty when demo login is off. */
export function availableDemoRoles(config: DemoLoginConfig = demoLoginConfig()): DemoRoleOption[] {
  if (!config.enabled) return [];
  return DEMO_SLOTS.filter((slot) => config.accounts.has(slot.key)).map(({ key, group, team }) => ({ key, group, team }));
}

export type DemoAccountCheck =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason:
        | "not-demo-email"
        | "not-linked"
        | "email-mismatch"
        | "inactive"
        | "admin"
        | "no-demo-role"
        | "role-outside-demo"
        | "delegation"
        | "wrong-role"
        | "missing-delegation"
        | "lookup-failed";
    };

/** The checks listed in the module doc, against live data (service-role
 * client, server-side only). `slot` adds check 6. Never throws. */
export async function checkDemoAccount(
  admin: SupabaseClient,
  config: DemoLoginConfig,
  identity: { authUserId: string; email: string },
  slot?: DemoSlot
): Promise<DemoAccountCheck> {
  const email = normalizeEmail(identity.email);
  if (!isDemoAccountEmail(email) || !config.emails.has(email)) return { ok: false, reason: "not-demo-email" };

  try {
    // This runs on every request of a demo session, so independent lookups
    // go out together (2 round trips; 3 for a delegated account). The rules
    // are still applied one by one, in the order listed in the module doc.
    const { data: profile, error: profileError } = await admin
      .from("users")
      .select("user_id, user_mail, user_role, status")
      .eq("auth_user_id", identity.authUserId)
      .maybeSingle();
    if (profileError) return { ok: false, reason: "lookup-failed" };
    if (!profile) return { ok: false, reason: "not-linked" };
    if (normalizeEmail(profile.user_mail) !== email) return { ok: false, reason: "email-mismatch" };
    if (profile.status !== "Active") return { ok: false, reason: "inactive" };
    if (profile.user_role === "ADMIN") return { ok: false, reason: "admin" };
    const userId = profile.user_id as string;

    const [{ data: roles, error: rolesError }, { data: delegations, error: delegationError }] = await Promise.all([
      admin.from("user_project_roles").select("project_id, role, departments(department_name)").eq("user_id", userId).eq("status", "Active"),
      admin.from("admin_delegations").select("delegation_id").eq("delegate_user_id", userId).eq("status", "Active"),
    ]);
    if (rolesError) return { ok: false, reason: "lookup-failed" };
    if (!roles || roles.length === 0) return { ok: false, reason: "no-demo-role" };
    if (roles.some((row) => !config.projectIds.has(row.project_id as string))) {
      return { ok: false, reason: "role-outside-demo" };
    }

    if (delegationError) return { ok: false, reason: "lookup-failed" };
    const delegationIds = (delegations ?? []).map((row) => row.delegation_id as string);
    if (delegationIds.length > 0) {
      const [{ data: scopes, error: scopeError }, { data: permissions, error: permissionError }] = await Promise.all([
        admin.from("delegation_projects").select("delegation_id, project_id").in("delegation_id", delegationIds),
        admin.from("delegation_permissions").select("delegation_id, permission").in("delegation_id", delegationIds),
      ]);
      if (scopeError || permissionError) return { ok: false, reason: "lookup-failed" };
      // Every delegation must name demo projects only (a delegation with no
      // project row reaches nothing, but is refused too) and no forbidden permission.
      const outside = delegationIds.some((id) => {
        const projects = (scopes ?? []).filter((row) => row.delegation_id === id);
        return projects.length === 0 || projects.some((row) => !config.projectIds.has(row.project_id as string));
      });
      if (outside || (permissions ?? []).some((row) => FORBIDDEN_DEMO_PERMISSIONS.has(row.permission as string))) {
        return { ok: false, reason: "delegation" };
      }
    }

    if (slot) {
      // Only the slot's role, at least once in the slot's team (an account
      // may also hold the same role in another configured project).
      const inTeam = roles.some((row) => {
        const department = Array.isArray(row.departments) ? row.departments[0] : row.departments;
        return department?.department_name === slot.department;
      });
      if (!inTeam || roles.some((row) => row.role !== slot.role)) return { ok: false, reason: "wrong-role" };
      if (slot.delegatedAdmin && delegationIds.length === 0) return { ok: false, reason: "missing-delegation" };
      if (!slot.delegatedAdmin && delegationIds.length > 0) return { ok: false, reason: "wrong-role" };
    }

    return { ok: true, userId };
  } catch {
    return { ok: false, reason: "lookup-failed" };
  }
}

/**
 * A slot's login stopped accepting its configured password — e.g. a
 * visitor, who holds a real session for this shared account, changed it
 * (or its email) through Supabase's API. The configured values are
 * authoritative for demo accounts, so they are put back, but only after
 * the account passes the isolation checks for this slot: a real user's
 * login is never touched, whatever the configuration says. Never throws.
 */
export async function repairDemoLogin(
  admin: SupabaseClient,
  config: DemoLoginConfig,
  slot: DemoSlot
): Promise<boolean> {
  const account = config.accounts.get(slot.key);
  if (!account) return false;
  try {
    const { data: profile, error } = await admin
      .from("users")
      .select("auth_user_id")
      .eq("user_mail", account.email)
      .maybeSingle();
    if (error || !profile?.auth_user_id) return false;
    const check = await checkDemoAccount(admin, config, { authUserId: profile.auth_user_id as string, email: account.email }, slot);
    if (!check.ok) return false;
    const { error: updateError } = await admin.auth.admin.updateUserById(profile.auth_user_id as string, {
      email: account.email,
      password: account.password,
      email_confirm: true,
    });
    return !updateError;
  } catch {
    return false;
  }
}

/**
 * Per-request gate for an existing session (lib/session.ts). Any account
 * whose login or app email is a configured demo email is held to
 * checkDemoAccount on every request, wherever it signed in; with demo
 * login switched off it gets no app access at all. Every other account
 * passes after a Set lookup, with no query.
 */
export async function demoSessionAllowed(
  admin: SupabaseClient,
  identity: { authUserId: string; authEmail: string; appEmail: string },
  config: DemoLoginConfig = demoLoginConfig()
): Promise<boolean> {
  const isDemo = config.emails.has(normalizeEmail(identity.authEmail)) || config.emails.has(normalizeEmail(identity.appEmail));
  if (!isDemo) return true;
  const check: DemoAccountCheck = config.enabled
    ? await checkDemoAccount(admin, config, { authUserId: identity.authUserId, email: identity.authEmail })
    : { ok: false, reason: "not-demo-email" };
  if (!check.ok) {
    console.warn(`[demo-auth] ${JSON.stringify({ stage: "session", outcome: "refused", reason: config.enabled ? check.reason : "demo-disabled" })}`);
  }
  return check.ok;
}
