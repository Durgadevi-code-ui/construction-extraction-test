import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Account and login rules shared by the app (login, Admin user creation,
 * login linking), the account scripts (scripts/verify-auth-accounts.mjs,
 * scripts/manage-auth-accounts.mjs) and the tests — one definition of
 * "a valid account", so the app and the tools can't drift apart.
 *
 * Deliberately dependency-free (no "server-only", no "@/..." imports, only
 * erasable TypeScript): Node runs the .mjs scripts against this file
 * directly, without a build step.
 *
 * Why it exists: 90% of logins failed in a client presentation because
 * accounts were created and passwords changed by hand with nothing checking
 * the result — users were created without a login (Admin Setup made the
 * login a separate, optional step), and changed passwords were never
 * tried. Every operation here
 * therefore validates its input first, reads back what it wrote, and
 * reports a per-account outcome instead of throwing halfway through a
 * batch. Passwords never appear in any returned message.
 */

/** Roles an account may be created with (same set as Admin Setup → Users). */
export const APPROVED_ROLES = ["ADMIN", "SUPERVISOR", "FOREMAN", "WORKER"] as const;
/** Every role the app routes and authorizes (MANAGER is a Contractor like
 * SUPERVISOR — lib/authContext.ts CONTRACTOR_ROLES). Existing accounts with
 * any of these are valid and may be given a login. */
export const SUPPORTED_ROLES = [...APPROVED_ROLES, "MANAGER"] as const;
const isSupportedRole = (role: unknown) => typeof role === "string" && (SUPPORTED_ROLES as readonly string[]).includes(role);

// Format only. A "domain looks like a typo" rule was tried and removed:
// real, intended addresses use such domains (confirmed by the project
// owner), so guessing would block or flag valid accounts.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The internal app user that owns Extraction Test submissions
 * (lib/construction.ts). It is a record, not a person: it never signs in,
 * so it must have no login and is left out of the login audit.
 */
export function extractionTestWorkerEmail(env: Record<string, string | undefined>): string {
  return env.CONSTRUCTION_TEST_WORKER_EMAIL?.trim() || "extraction-test-worker@abc-construction.internal";
}

/** Supabase Auth stores emails lowercased; app records must match it exactly. */
export function normalizeEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

/** null when the email is acceptable for a new account, else the reason. */
export function emailProblem(email: string): string | null {
  if (!email) return "email is required";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return "email format is invalid";
  return null;
}

export function isApprovedRole(role: unknown): role is (typeof APPROVED_ROLES)[number] {
  return typeof role === "string" && (APPROVED_ROLES as readonly string[]).includes(role);
}

/** null when the password may be set, else the reason (never echoes it). */
export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== "string" || password.length === 0) return "password is required";
  if (password.length < 8) return "password must be at least 8 characters";
  // bcrypt (Supabase's password hash) ignores everything after 72 bytes.
  if (new TextEncoder().encode(password).length > 72) return "password must be at most 72 bytes";
  if (password !== password.trim()) return "password starts or ends with a space (usually a copy/paste mistake)";
  if (email && password.toLowerCase() === email.toLowerCase()) return "password must not be the email address";
  return null;
}

export type SignInFailureKind =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "rate_limited"
  | "unavailable"
  | "app_key_rejected"
  | "other";

/**
 * What a Supabase sign-in error actually means. Shapes confirmed against
 * the live Supabase API: wrong password and unknown email are both
 * 400 invalid_credentials; a rejected API key is 401 "Invalid API key";
 * an unreachable or non-existent project is AuthRetryableFetchError with
 * status 0.
 */
export function classifySignInError(error: { message?: string; status?: number; code?: string; name?: string }): SignInFailureKind {
  const code = error.code ?? "";
  const status = error.status;
  if (code === "invalid_credentials") return "invalid_credentials";
  if (code === "email_not_confirmed" || String(error.message ?? "").toLowerCase().includes("email not confirmed")) {
    return "email_not_confirmed";
  }
  if (status === 429 || code === "over_request_rate_limit") return "rate_limited";
  if (error.name === "AuthRetryableFetchError" || status === 0 || (status !== undefined && status >= 500)) return "unavailable";
  if (status === 401 || status === 403) return "app_key_rejected";
  return "other";
}

/**
 * The origin password-reset emails link back to. A reset link must never
 * point at localhost in a deployment (it did: NEXT_PUBLIC_SITE_URL was
 * unset in Vercel), and must never come from the request's Host header
 * (an attacker could make the emailed link point at their own site).
 * Order: NEXT_PUBLIC_SITE_URL, then Vercel's own system variables for the
 * production domain / this preview deployment, then localhost for local
 * development only.
 */
export function passwordResetOrigin(env: Record<string, string | undefined>): { origin: string; source: string } {
  const configured = (env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (configured) {
    return { origin: new URL(configured).origin, source: "NEXT_PUBLIC_SITE_URL" };
  }
  if (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) {
    return { origin: `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`, source: "VERCEL_PROJECT_PRODUCTION_URL" };
  }
  const previewHost = env.VERCEL_BRANCH_URL || env.VERCEL_URL;
  if (env.VERCEL === "1" && previewHost) {
    return { origin: `https://${previewHost}`, source: env.VERCEL_BRANCH_URL ? "VERCEL_BRANCH_URL" : "VERCEL_URL" };
  }
  return { origin: "http://localhost:3000", source: "local default" };
}

// ---------------------------------------------------------------- operations

export type AccountOpStatus = "created" | "updated" | "unchanged" | "failed";
export type AccountOpResult = { email: string; status: AccountOpStatus; detail: string };

const ok = (email: string, status: AccountOpStatus, detail: string): AccountOpResult => ({ email, status, detail });
const failed = (email: string, detail: string): AccountOpResult => ({ email, status: "failed", detail });

/** Every Supabase Auth user (listUsers is paged). */
export async function listAllAuthUsers(admin: SupabaseClient): Promise<User[]> {
  const all: User[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Could not list Auth users: ${error.message}`);
    all.push(...data.users);
    if (data.users.length < 1000) return all;
  }
}

type ProfileRow = { user_id: string; user_mail: string; user_role: string; status: string | null; auth_user_id: string | null };
const PROFILE_COLUMNS = "user_id, user_mail, user_role, status, auth_user_id";

/**
 * Creates the Supabase Auth login for one EXISTING app user (by user_id,
 * never by guessing from an email) and links it. Idempotent: a user that
 * is already correctly linked is reported "unchanged" and nothing is
 * written. Never links onto an Auth account that already exists for the
 * email — that would let whoever controls that login take over this
 * profile; it is reported for a human to resolve instead. If the link
 * cannot be written, the just-created login is deleted again so no
 * orphaned, unreachable login is left behind. Success is only reported
 * after reading the link back.
 */
export async function provisionLogin(
  admin: SupabaseClient,
  params: { userId: string; password: string }
): Promise<AccountOpResult> {
  const { data: profile, error: profileError } = await admin
    .from("users")
    .select(PROFILE_COLUMNS)
    .eq("user_id", params.userId)
    .maybeSingle<ProfileRow>();
  if (profileError) return failed(params.userId, `could not read the app user: ${profileError.message}`);
  if (!profile) return failed(params.userId, "no app user has this user_id");

  const email = normalizeEmail(profile.user_mail);
  if (profile.auth_user_id) {
    const { data: linked } = await admin.auth.admin.getUserById(profile.auth_user_id);
    if (linked?.user && normalizeEmail(linked.user.email) === email) {
      return ok(email, "unchanged", "already has a linked login");
    }
    return failed(email, "linked to a login that is missing or has a different email — fix the link by hand");
  }

  if (email === normalizeEmail(extractionTestWorkerEmail(globalThis.process?.env ?? {}))) {
    return failed(email, "this is the internal Extraction Test record — it must never have a login");
  }
  const problem = emailProblem(email) ?? (profile.user_mail !== email ? "app email is not trimmed/lowercase — correct the app user first" : null);
  if (problem) return failed(email, problem);
  if (!isSupportedRole(profile.user_role)) return failed(email, `role "${profile.user_role}" is not a role this app supports`);
  const pwProblem = passwordProblem(params.password, email);
  if (pwProblem) return failed(email, pwProblem);

  let authUsers: User[];
  try {
    authUsers = await listAllAuthUsers(admin);
  } catch (err) {
    return failed(email, err instanceof Error ? err.message : "could not list Auth users");
  }
  if (authUsers.some((u) => normalizeEmail(u.email) === email)) {
    return failed(email, "an Auth login already exists for this email but is not linked — verify who owns it, then link it by hand");
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: params.password,
    email_confirm: true,
  });
  if (createError || !created?.user) {
    return failed(email, `Supabase refused to create the login: ${createError?.message ?? "no user returned"}`);
  }
  const authUserId = created.user.id;

  // Only links a row that is still unlinked, so a concurrent link can't be overwritten.
  const { data: linkedRows, error: linkError } = await admin
    .from("users")
    .update({ auth_user_id: authUserId })
    .eq("user_id", profile.user_id)
    .is("auth_user_id", null)
    .select("user_id");
  if (linkError || !linkedRows || linkedRows.length !== 1) {
    const { error: rollbackError } = await admin.auth.admin.deleteUser(authUserId);
    const why = linkError?.message ?? "the app user was linked by someone else meanwhile";
    return failed(
      email,
      rollbackError
        ? `login created but NOT linked (${why}); removing it also failed (${rollbackError.message}) — delete the orphaned login in Supabase`
        : `login could not be linked (${why}); the new login was removed again`
    );
  }

  const { data: check } = await admin.from("users").select(PROFILE_COLUMNS).eq("user_id", profile.user_id).maybeSingle<ProfileRow>();
  const { data: authCheck } = await admin.auth.admin.getUserById(authUserId);
  if (check?.auth_user_id !== authUserId || normalizeEmail(authCheck?.user?.email) !== email || !authCheck?.user?.email_confirmed_at) {
    return failed(email, "login created and linked, but reading it back did not match — check this account by hand");
  }
  return ok(email, "created", `login created and linked (${profile.user_role})`);
}

/**
 * Sets one user's password through the Supabase Admin API, then proves it:
 * signs in with the new password and checks the session belongs to the
 * same Auth user the app profile is linked to. "updated" is only returned
 * after that sign-in works. Finally every session of the user (including
 * any opened with the old password, and the verification one) is revoked,
 * so the user has to sign in again with the new password.
 *
 * `signInClient` must be a fresh anon-key client — the same kind the login
 * page uses.
 */
export async function setPasswordVerified(
  admin: SupabaseClient,
  signInClient: () => SupabaseClient,
  params: { email: string; password: string }
): Promise<AccountOpResult> {
  const email = normalizeEmail(params.email);
  const formatProblem = emailProblem(email);
  if (formatProblem) return failed(email, formatProblem);

  const { data: rows, error } = await admin.from("users").select(PROFILE_COLUMNS).eq("user_mail", email);
  if (error) return failed(email, `could not read app users: ${error.message}`);
  const profiles = (rows ?? []) as ProfileRow[];
  if (profiles.length === 0) return failed(email, "no app user has this email");
  if (profiles.length > 1) return failed(email, "more than one app user has this email — resolve the duplicate first");
  const profile = profiles[0];
  if (!profile.auth_user_id) return failed(email, "this app user has no login yet — create it first (create-logins)");

  const { data: authData, error: authError } = await admin.auth.admin.getUserById(profile.auth_user_id);
  if (authError || !authData?.user) return failed(email, "the linked login no longer exists");
  if (normalizeEmail(authData.user.email) !== email) return failed(email, "the linked login has a different email — mapping is wrong, nothing changed");

  const pwProblem = passwordProblem(params.password, email);
  if (pwProblem) return failed(email, pwProblem);

  const { error: updateError } = await admin.auth.admin.updateUserById(profile.auth_user_id, { password: params.password });
  if (updateError) return failed(email, `Supabase refused the new password: ${updateError.message}`);

  const client = signInClient();
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password: params.password });
  if (signInError || !signIn?.user) {
    const kind = signInError ? classifySignInError(signInError) : "other";
    // Supabase accepted the change, so the OLD password no longer works —
    // but nothing proves the new one does. Never report that as success.
    return failed(
      email,
      `Supabase accepted the new password but signing in with it failed (${kind}) — UNVERIFIED: the old password no longer works; re-run set-passwords for this account with the same password${kind === "rate_limited" ? " in a few minutes" : ""}`
    );
  }
  if (signIn.user.id !== profile.auth_user_id) {
    await client.auth.signOut({ scope: "local" });
    return failed(email, "signed in as a different login than the app user is linked to — mapping is wrong");
  }
  const { error: revokeError } = await client.auth.signOut({ scope: "global" });
  return ok(
    email,
    "updated",
    revokeError ? "password updated and verified; revoking old sessions FAILED — sign the user out in Supabase" : "password updated, verified by signing in, all sessions revoked"
  );
}

/**
 * Rejects a whole batch before anything is written when it is ambiguous:
 * the same email twice, or the same password on two accounts (no shared
 * passwords). Returns one message per problem; empty means the batch may run.
 */
export function batchProblems(items: { email: string; password?: string }[]): string[] {
  const problems: string[] = [];
  const emails = new Map<string, number>();
  const passwords = new Map<string, string[]>();
  items.forEach((item, i) => {
    const email = normalizeEmail(item.email);
    if (emails.has(email)) problems.push(`entry ${i + 1}: email repeats entry ${emails.get(email)! + 1}`);
    else emails.set(email, i);
    if (typeof item.password === "string" && item.password) {
      passwords.set(item.password, [...(passwords.get(item.password) ?? []), email]);
    }
  });
  for (const owners of passwords.values()) {
    if (owners.length > 1) problems.push(`${owners.length} accounts share one password — every account needs its own`);
  }
  return problems;
}

/**
 * Runs `op` for every item, one at a time. Never stops early and never
 * throws: an exception becomes that item's "failed" result, so a batch
 * that fails halfway still says exactly which accounts succeeded.
 */
export async function runAccountBatch<T extends { email: string }>(
  items: T[],
  op: (item: T) => Promise<AccountOpResult>,
  options: { delayMs?: number } = {}
): Promise<{ results: AccountOpResult[]; succeeded: number; failed: number; complete: boolean }> {
  const results: AccountOpResult[] = [];
  for (const [i, item] of items.entries()) {
    try {
      results.push(await op(item));
    } catch (err) {
      results.push(failed(normalizeEmail(item.email), `unexpected error: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (options.delayMs && i < items.length - 1) await new Promise((r) => setTimeout(r, options.delayMs));
  }
  const failedCount = results.filter((r) => r.status === "failed").length;
  return { results, succeeded: results.length - failedCount, failed: failedCount, complete: failedCount === 0 };
}

// ---------------------------------------------------------------- audit

export type AccountAudit = {
  email: string;
  role: string;
  status: string | null;
  hasProfile: true;
  /** Internal record that never signs in (see extractionTestWorkerEmail). */
  system: boolean;
  hasLogin: boolean;
  mappingOk: boolean;
  emailConfirmed: boolean;
  activeAssignments: string[];
  problems: string[];
  warnings: string[];
};

/**
 * Read-only check of every app user against Supabase Auth: exactly one
 * login per user, linked by id, same email, confirmed, not banned, approved
 * role, and (except Admins) at least one active project/department role so
 * the dashboards have something to show. Also reports logins no app user
 * links to and duplicate emails.
 */
export async function auditAccounts(
  admin: SupabaseClient,
  options: { systemEmails?: string[] } = {}
): Promise<{ accounts: AccountAudit[]; globalProblems: string[] }> {
  const systemEmails = new Set((options.systemEmails ?? []).map(normalizeEmail));
  const authUsers = await listAllAuthUsers(admin);
  const { data: rows, error } = await admin.from("users").select(PROFILE_COLUMNS);
  if (error) throw new Error(`Could not read app users: ${error.message}`);
  const { data: roleRows, error: roleError } = await admin
    .from("user_project_roles")
    .select("user_id, role, status")
    .eq("status", "Active");
  if (roleError) throw new Error(`Could not read role assignments: ${roleError.message}`);

  const profiles = (rows ?? []) as ProfileRow[];
  const authById = new Map(authUsers.map((u) => [u.id, u]));
  const globalProblems: string[] = [];
  const countBy = (values: string[]) => values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>());
  for (const [e, n] of countBy(authUsers.map((u) => normalizeEmail(u.email)))) if (n > 1) globalProblems.push(`${e}: ${n} Auth logins share this email`);
  for (const [e, n] of countBy(profiles.map((p) => normalizeEmail(p.user_mail)))) if (n > 1) globalProblems.push(`${e}: ${n} app users share this email`);
  for (const [id, n] of countBy(profiles.map((p) => p.auth_user_id).filter((v): v is string => !!v))) {
    if (n > 1) globalProblems.push(`${normalizeEmail(authById.get(id)?.email)}: one login is linked to ${n} app users`);
  }
  const linkedIds = new Set(profiles.map((p) => p.auth_user_id).filter(Boolean));
  for (const u of authUsers) {
    if (!linkedIds.has(u.id)) globalProblems.push(`${normalizeEmail(u.email)}: Auth login is not linked to any app user (login is refused)`);
  }

  const accounts = profiles.map((p): AccountAudit => {
    const email = normalizeEmail(p.user_mail);
    const auth = p.auth_user_id ? authById.get(p.auth_user_id) : undefined;
    const problems: string[] = [];
    const warnings: string[] = [];
    if (systemEmails.has(email)) {
      if (p.auth_user_id) problems.push("internal system account must not have a login");
      return { email, role: p.user_role, status: p.status, hasProfile: true, system: true, hasLogin: !!auth, mappingOk: false, emailConfirmed: false, activeAssignments: [], problems, warnings };
    }
    if (!p.auth_user_id) {
      problems.push(authUsers.some((u) => normalizeEmail(u.email) === email) ? "a login exists for this email but is NOT linked" : "MISSING LOGIN — this user cannot sign in");
    } else if (!auth) {
      problems.push("linked login no longer exists");
    } else {
      if (normalizeEmail(auth.email) !== email) problems.push("login email differs from app email");
      if (!auth.email_confirmed_at) problems.push("email not confirmed");
      if (auth.banned_until && new Date(auth.banned_until) > new Date()) problems.push("login is banned");
    }
    const emailIssue = p.user_mail !== email ? "app email is not trimmed/lowercase" : emailProblem(email);
    if (emailIssue) problems.push(emailIssue);
    if (!isSupportedRole(p.user_role)) problems.push(`role "${p.user_role}" is not a role this app supports`);
    if (p.status !== "Active") warnings.push(`app user status is "${p.status}"`);
    const activeAssignments = (roleRows ?? []).filter((r) => r.user_id === p.user_id).map((r) => String(r.role));
    if (p.user_role !== "ADMIN") {
      if (activeAssignments.length === 0) problems.push("no active project/department role — dashboard will be empty");
      else if (!activeAssignments.includes(p.user_role)) warnings.push(`user role ${p.user_role} but active assignments are ${activeAssignments.join(", ")}`);
    }
    return {
      email,
      role: p.user_role,
      status: p.status,
      hasProfile: true,
      system: false,
      hasLogin: !!auth,
      mappingOk: !!auth && normalizeEmail(auth.email) === email,
      emailConfirmed: !!auth?.email_confirmed_at,
      activeAssignments,
      problems,
      warnings,
    };
  });
  return { accounts, globalProblems };
}
