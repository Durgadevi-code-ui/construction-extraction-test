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
 *   - The Admin door signs in as the dedicated presentation-Admin demo
 *     account. That account uses the existing ADMIN role CONFINED to the
 *     presentation project(s) via admin_scopes (a SCOPED admin — see
 *     lib/authContext.ts getAdminScope and migration 25). It is NEVER a
 *     GLOBAL admin: checkDemoAccount refuses any user_role='ADMIN' account
 *     unless its admin_scopes are entirely within the configured demo
 *     projects. Company management, project creation, delegation management
 *     and ADMIN administration stay global-admin-only (isGlobalAdmin).
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
 *   2. if user_role='ADMIN': a SCOPED admin only — its admin_scopes must be
 *      non-empty and entirely within the configured demo projects (a GLOBAL
 *      admin, with no scope, is refused). The ADMIN branch returns here and
 *      skips the trade-role checks 3/4/6 (admin authority is admin_scopes,
 *      not user_project_roles);
 *   3. (non-admin) at least one Active project role, every one of them in a
 *      configured project — non-admin data access in this app is scoped by
 *      exactly these rows (lib/authContext.ts getUserContext);
 *   4. (non-admin) every Active admin delegation is confined entirely to the
 *      configured demo projects (a delegation reaching a real project, or
 *      with no project, is refused);
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
  /** Every demo email (slot accounts + the Admin-door account + DEMO_LOGIN_EMAILS). */
  emails: Set<string>;
  projectIds: Set<string>;
  /** Slot key -> its account. Server-only: holds passwords. */
  accounts: Map<string, { email: string; password: string }>;
  /** The dedicated presentation-Admin account (DEMO_LOGIN_ADMIN_DEMO_*),
   * used only by the Admin door. NEVER a real ADMIN: it is an ordinary
   * isolated @example.com demo account whose admin powers come solely from
   * an admin DELEGATION confined to the presentation project(s)
   * (checkDemoAccount allows exactly that, and nothing wider). Undefined
   * when no presentation-Admin account is configured. Server-only: holds a
   * password. */
  adminAccount?: { email: string; password: string };
  /** Whether a demo session is CONFINED to the configured demo project(s).
   * Default TRUE (DEMO_LOGIN_CONFINE_TO_PROJECTS unset or any value other
   * than "false") — the existing, unchanged behavior: a demo account may
   * only hold roles / admin scope within DEMO_PROJECT_IDS, and those
   * projects must contain demo (@example.com) members only, so the public
   * passwordless door never reaches real client data.
   *
   * Set DEMO_LOGIN_CONFINE_TO_PROJECTS=false to lift that confinement, so a
   * demo account is treated like any other account — it sees exactly the
   * projects it is ASSIGNED to (user_project_roles), by the same rules as
   * Normal Login. A GLOBAL admin is STILL refused for a demo session
   * regardless of this flag (the Admin door uses a scoped admin). This flag
   * is the single, explicit switch that opens Demo Login onto the existing
   * application's real projects; it is OFF by default and changes nothing
   * until deliberately enabled alongside the real-project assignments. */
  confineToProjects: boolean;
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
  // The Admin door's dedicated account (DEMO_LOGIN_ADMIN_DEMO_*): a demo
  // @example.com account like any other, held to the same isolation checks
  // on every request — never a real ADMIN, never passwordless.
  const adminEmail = normalizeEmail(env.DEMO_LOGIN_ADMIN_DEMO_EMAIL);
  const adminPassword = env.DEMO_LOGIN_ADMIN_DEMO_PASSWORD ?? "";
  const adminAccount =
    isDemoAccountEmail(adminEmail) && adminPassword ? { email: adminEmail, password: adminPassword } : undefined;

  const emails = new Set(
    [
      ...list(env.DEMO_LOGIN_EMAILS).map(normalizeEmail),
      ...[...accounts.values()].map((a) => a.email),
      ...(adminAccount ? [adminAccount.email] : []),
    ].filter(isDemoAccountEmail)
  );
  const projectIds = new Set(list(env.DEMO_PROJECT_IDS));
  return {
    enabled: env.DEMO_LOGIN_ENABLED === "true" && emails.size > 0 && projectIds.size > 0,
    emails,
    projectIds,
    accounts,
    adminAccount,
    // Default TRUE (confined) — only an explicit "false" lifts the confinement.
    confineToProjects: env.DEMO_LOGIN_CONFINE_TO_PROJECTS !== "false",
  };
}

export function demoSlot(key: unknown): DemoSlot | undefined {
  return typeof key === "string" ? DEMO_SLOTS.find((slot) => slot.key === key) : undefined;
}

/**
 * The Demo Login "Admin" door account. It is NOT the real ADMIN and NOT a
 * trade slot: it is the dedicated presentation-Admin demo account
 * (DEMO_LOGIN_ADMIN_DEMO_*), an ordinary isolated @example.com account
 * that signs in with its own password (never passwordless) and lands on
 * the normal, delegation-driven Admin Setup. Its Admin capabilities come
 * ENTIRELY from an admin delegation confined to the presentation
 * project(s) (checkDemoAccount's delegation rule) and are scoped and
 * enforced by the existing delegation system at every /api/admin/* route —
 * so project creation, company management, delegation management, ADMIN
 * administration and real-project access all stay real-Admin-only.
 * Returns undefined when no presentation-Admin account is configured.
 */
export const ADMIN_DOOR_KEY = "admin";
export function adminDoorAccount(
  config: DemoLoginConfig = demoLoginConfig()
): { email: string; password: string } | undefined {
  return config.adminAccount;
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
        | "delegation-outside-demo"
        | "wrong-role"
        | "project-not-isolated"
        | "admin-scope-outside-demo"
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
    const userId = profile.user_id as string;

    // ADMIN demo sessions: allowed ONLY for a SCOPED admin whose admin_scopes
    // are entirely within the configured (isolated) demo project(s) — never a
    // GLOBAL admin (no scope rows), which would be a public global admin over
    // all real data. This is what gives the Demo Login Admin door the real
    // ADMIN role confined to the presentation project. Fails closed: no scope,
    // a scope reaching any non-demo project, or a lookup failure all refuse.
    // Admin authority comes from admin_scopes, not user_project_roles, so the
    // trade-role checks below are skipped for an ADMIN account.
    if (profile.user_role === "ADMIN") {
      const { data: scopeRows, error: scopeError } = await admin
        .from("admin_scopes")
        .select("project_id")
        .eq("user_id", userId);
      const scopeIds = scopeError ? [] : (scopeRows ?? []).map((r) => r.project_id as string).filter(Boolean);
      // A GLOBAL admin (no scope) is refused for a demo session REGARDLESS of
      // the confinement flag — a public passwordless global admin is never
      // allowed; the Admin door is always a SCOPED admin.
      if (scopeIds.length === 0) return { ok: false, reason: "admin" };
      if (config.confineToProjects) {
        if (scopeIds.some((pid) => !config.projectIds.has(pid))) {
          return { ok: false, reason: "admin-scope-outside-demo" };
        }
        const adminIsolated = await demoProjectsIsolated(admin, config);
        if (adminIsolated === null) return { ok: false, reason: "lookup-failed" };
        if (!adminIsolated) return { ok: false, reason: "project-not-isolated" };
      }
      return { ok: true, userId };
    }

    const [{ data: roles, error: rolesError }, { data: delegations, error: delegationError }, isolated] = await Promise.all([
      admin.from("user_project_roles").select("project_id, role, departments(department_name)").eq("user_id", userId).eq("status", "Active"),
      admin.from("admin_delegations").select("delegation_id").eq("delegate_user_id", userId).eq("status", "Active"),
      config.confineToProjects ? demoProjectsIsolated(admin, config) : Promise.resolve(true),
    ]);
    if (rolesError) return { ok: false, reason: "lookup-failed" };
    // Always require at least one active role (an unprovisioned account is
    // never a valid session) — independent of the confinement flag.
    if (!roles || roles.length === 0) return { ok: false, reason: "no-demo-role" };

    // Project confinement (default). When DEMO_LOGIN_CONFINE_TO_PROJECTS=false,
    // a demo account is treated like any other account: it sees exactly the
    // projects it is assigned to, with no demo-project restriction and no
    // isolation requirement — so Demo Login enters the existing application
    // and data by the same rules as Normal Login.
    if (config.confineToProjects) {
      if (roles.some((row) => !config.projectIds.has(row.project_id as string))) {
        return { ok: false, reason: "role-outside-demo" };
      }
      if (isolated === null) return { ok: false, reason: "lookup-failed" };
      if (!isolated) return { ok: false, reason: "project-not-isolated" };
      if (delegationError) return { ok: false, reason: "lookup-failed" };
      // A demo session may hold an admin delegation ONLY if every one of its
      // active delegations is confined entirely to the configured demo
      // project(s): at least one project, all within config.projectIds (fails
      // closed otherwise). No demo account is ever a GLOBAL admin (refused
      // above). Re-checked on every request (demoSessionAllowed).
      const activeDelegations = delegations ?? [];
      if (activeDelegations.length > 0) {
        const { data: delegationProjects, error: delegationProjectsError } = await admin
          .from("delegation_projects")
          .select("delegation_id, project_id")
          .in(
            "delegation_id",
            activeDelegations.map((d) => d.delegation_id as string)
          );
        if (delegationProjectsError) return { ok: false, reason: "lookup-failed" };
        const projectsByDelegation = new Map<string, string[]>();
        for (const row of delegationProjects ?? []) {
          const existing = projectsByDelegation.get(row.delegation_id as string) ?? [];
          existing.push(row.project_id as string);
          projectsByDelegation.set(row.delegation_id as string, existing);
        }
        for (const delegation of activeDelegations) {
          const delegationProjectIds = projectsByDelegation.get(delegation.delegation_id as string) ?? [];
          if (
            delegationProjectIds.length === 0 ||
            delegationProjectIds.some((projectId) => !config.projectIds.has(projectId))
          ) {
            return { ok: false, reason: "delegation-outside-demo" };
          }
        }
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
 * A demo account's login stopped accepting its configured password — e.g.
 * a visitor, who holds a real session for this shared account, changed it
 * (or its email) through Supabase's API. The configured values are
 * authoritative for demo accounts, so they are put back, but only after
 * the account passes the isolation checks (for a trade slot, including its
 * role/team): a real user's login is never touched, whatever the
 * configuration says. Works for a trade slot (pass its `slot`) and for the
 * Admin-door account (pass `slot` as undefined — the isolation checks still
 * run, just without the per-slot role/team constraint). Never throws.
 */
export async function repairDemoLogin(
  admin: SupabaseClient,
  config: DemoLoginConfig,
  account: { email: string; password: string } | undefined,
  slot?: DemoSlot
): Promise<boolean> {
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
