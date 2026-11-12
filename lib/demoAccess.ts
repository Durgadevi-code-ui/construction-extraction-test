import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeEmail } from "./authAccounts";
import { isDemoAccountEmail } from "./demoEmail";

/**
 * Role-based one-click Demo Login (app/demo-login): pick a role and a
 * trade, click "Sign In", and the server signs in as that
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
 *   - There is no demo Admin. The application has one Admin: the real
 *     ADMIN account, with the one Admin permission system — never a
 *     Contractor or a delegate standing in for an Admin. Choosing "Admin"
 *     on Demo Login leads to the normal email/password sign-in
 *     (/login?next=/admin/setup).
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
 *   4. no Active admin delegation at all (no demo account is an Admin or
 *      a delegated Admin);
 *   5. every configured project is presentation data: its Active members
 *      are demo (@example.com) accounts only, so a demo session (which can
 *      write) never reaches a project a real person works in;
 *   6. at sign-in only: the account holds only the slot's role, in the
 *      slot's team.
 * Demo sessions use the application exactly as their role allows
 * (DEMO_LOGIN_READ_ONLY=true is an emergency read-only switch,
 * lib/demoEmail.ts). Checks 1–4 run again on every request (demoSessionAllowed, from
 * lib/session.ts getCurrentUser), so a demo account that signed in on
 * /login, or whose roles changed afterwards, loses app access at once.
 */

export type DemoSlot = {
  key: string;
  /** Role group shown in the picker. */
  group: "Contractor" | "Subcontractor" | "Worker";
  /** Trade / team shown in the picker; also the account's department name. */
  team: string;
  /** The account's user_project_roles.role. */
  role: "SUPERVISOR" | "FOREMAN" | "WORKER";
  department: string;
};

// Fixed order: Contractors, Subcontractors, Workers. Departments are the
// presentation project's own. (Admin is not a demo slot: see above.)
export const DEMO_SLOTS: readonly DemoSlot[] = [
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

/**
 * The Demo Login "Admin" door. It is NOT a privileged account and never
 * signs in as the real ADMIN: it signs in as an ordinary isolated demo
 * account (the first configured slot) and lands on Admin Setup, which
 * renders a READ-ONLY, demo-scoped preview of the Admin dashboard
 * (app/admin/setup/page.tsx demoAdmin). It holds no admin role and no
 * delegation, so every /api/admin/* route still refuses it (isAdminUser)
 * — creating users, resetting passwords, changing roles and delegations
 * stay real-Admin-only. Returns the backing slot, or undefined when no
 * demo account is configured.
 */
export const ADMIN_DOOR_KEY = "admin";
export function adminDoorSlot(config: DemoLoginConfig = demoLoginConfig()): DemoSlot | undefined {
  return DEMO_SLOTS.find((slot) => config.accounts.has(slot.key));
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
        | "project-not-isolated"
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

    const [{ data: roles, error: rolesError }, { data: delegations, error: delegationError }, isolated] = await Promise.all([
      admin.from("user_project_roles").select("project_id, role, departments(department_name)").eq("user_id", userId).eq("status", "Active"),
      admin.from("admin_delegations").select("delegation_id").eq("delegate_user_id", userId).eq("status", "Active"),
      demoProjectsIsolated(admin, config),
    ]);
    if (rolesError) return { ok: false, reason: "lookup-failed" };
    if (!roles || roles.length === 0) return { ok: false, reason: "no-demo-role" };
    if (roles.some((row) => !config.projectIds.has(row.project_id as string))) {
      return { ok: false, reason: "role-outside-demo" };
    }

    if (isolated === null) return { ok: false, reason: "lookup-failed" };
    if (!isolated) return { ok: false, reason: "project-not-isolated" };

    if (delegationError) return { ok: false, reason: "lookup-failed" };
    // No demo account acts as an Admin of any kind: an active admin
    // delegation (any scope, any permission) is refused outright.
    if ((delegations ?? []).length > 0) return { ok: false, reason: "delegation" };

    if (slot) {
      // Only the slot's role, at least once in the slot's team (an account
      // may also hold the same role in another configured project).
      const inTeam = roles.some((row) => {
        const department = Array.isArray(row.departments) ? row.departments[0] : row.departments;
        return department?.department_name === slot.department;
      });
      if (!inTeam || roles.some((row) => row.role !== slot.role)) return { ok: false, reason: "wrong-role" };
    }

    return { ok: true, userId };
  } catch {
    return { ok: false, reason: "lookup-failed" };
  }
}

/**
 * Whether every configured project is presentation data: true when all of
 * its Active members are demo (@example.com) accounts, false as soon as one
 * real person is a member, null when the lookup fails. Demo sessions can
 * write, so this keeps them away from client projects whatever
 * DEMO_PROJECT_IDS says. (The real Admin is not a project member: an Admin
 * sees every project through users.user_role, not through these rows.)
 */
export async function demoProjectsIsolated(admin: SupabaseClient, config: DemoLoginConfig): Promise<boolean | null> {
  if (config.projectIds.size === 0) return false;
  try {
    const { data, error } = await admin
      .from("user_project_roles")
      .select("users(user_mail)")
      .in("project_id", [...config.projectIds])
      .eq("status", "Active");
    if (error || !data) return null;
    return data.every((row) => {
      const user = Array.isArray(row.users) ? row.users[0] : row.users;
      return isDemoAccountEmail((user as { user_mail?: unknown } | null)?.user_mail);
    });
  } catch {
    return null;
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
 * whose login or app email is a demo email — configured, or any address on
 * the reserved @example.com domain (so an account dropped from the
 * configuration, such as the former demo Admin, is refused rather than
 * becoming an ordinary account) — is held to checkDemoAccount on every
 * request, wherever it signed in; with demo login switched off it gets no
 * app access at all. Every other account passes with no query.
 */
export async function demoSessionAllowed(
  admin: SupabaseClient,
  identity: { authUserId: string; authEmail: string; appEmail: string },
  config: DemoLoginConfig = demoLoginConfig()
): Promise<boolean> {
  const isDemo =
    config.emails.has(normalizeEmail(identity.authEmail)) ||
    config.emails.has(normalizeEmail(identity.appEmail)) ||
    isDemoAccountEmail(identity.authEmail) ||
    isDemoAccountEmail(identity.appEmail);
  if (!isDemo) return true;
  const check: DemoAccountCheck = config.enabled
    ? await checkDemoAccount(admin, config, { authUserId: identity.authUserId, email: identity.authEmail })
    : { ok: false, reason: "not-demo-email" };
  if (!check.ok) {
    console.warn(`[demo-auth] ${JSON.stringify({ stage: "session", outcome: "refused", reason: config.enabled ? check.reason : "demo-disabled" })}`);
  }
  return check.ok;
}
