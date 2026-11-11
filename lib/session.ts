import "server-only";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "./supabaseServer";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";
import { demoSessionAllowed } from "./demoAccess";
import { isDemoAccountEmail, isDemoReadOnlyMode } from "./demoEmail";

/**
 * Server-verified identity for the current request — the "DAL" Next.js
 * itself recommends for auth (see node_modules/next/dist/docs/01-app/
 * 02-guides/authentication.md "Creating a Data Access Layer"). Calls
 * supabase.auth.getUser(), never getSession(): getUser() revalidates
 * the JWT against Supabase Auth's server on every call, while
 * getSession() only reads the (spoofable) cookie value — the actual
 * "server-side identity verification, no trust in a client-supplied
 * value" requirement lives in this one distinction.
 *
 * Wired into every page/API route that used to trust a client-supplied
 * userId (Phase 2 cutover) — each of those call sites replaced
 * `searchParams.get("userId")` / `body?.actorUserId` with
 * `(await getCurrentUser())?.userId` (or `requireCurrentUser()` below)
 * and nothing else about that route's authorization logic changed:
 * getUserContext/isAdminUser/hasDelegatedPermission/etc. are all called
 * exactly as before, just with a server-verified id instead of a
 * request-supplied one.
 *
 * Returns null (never throws) when there's no session, or the session's
 * auth.users id has no linked public.users row yet (an unlinked demo
 * account, or someone who signed up without being provisioned — see the
 * auth_user_id migration) — callers decide what "not logged in" means
 * for them (redirect to /login, 401, etc.), this function only answers
 * "who, if anyone, is this."
 */
export type CurrentUser = {
  /** auth.users.id — Supabase Auth's own identity, verified server-side this call. */
  authUserId: string;
  /** public.users.user_id — the app's existing identity, unchanged by
   * this migration (see auth_user_id column doc). Every existing
   * authorization function (getUserContext, isAdminUser, ...) keys on
   * this, not authUserId. */
  userId: string;
  email: string;
  /** A shared Demo Login account (reserved @example.com domain, same rule
   * as proxy.ts): read-only everywhere — see lib/demoWriteGuard.ts. */
  isDemo: boolean;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user: authUser },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !authUser) return null;

  // Looked up with the service-role client, keyed on the id getUser()
  // just verified — so this keeps working once public.users has no
  // anon/authenticated policy (00000000000022).
  const admin = getSupabaseServiceRoleClient();
  const { data: profile, error: profileError } = await admin
    .from("users")
    .select("user_id, user_mail")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();

  if (profileError || !profile) return null;

  // A configured demo account (app/demo-login) is re-checked as isolated
  // on every request; any other account is unaffected (lib/demoAccess.ts).
  const allowed = await demoSessionAllowed(admin, {
    authUserId: authUser.id,
    authEmail: authUser.email ?? "",
    appEmail: profile.user_mail as string,
  });
  if (!allowed) return null;

  return {
    authUserId: authUser.id,
    userId: profile.user_id as string,
    email: profile.user_mail as string,
    isDemo: isDemoAccountEmail(authUser.email) || isDemoAccountEmail(profile.user_mail),
  };
}

/**
 * Whether this request's session is a demo account AND the
 * DEMO_LOGIN_READ_ONLY emergency switch is on — for the UI only (read-only
 * banner and disabled controls, app/workflow/layout.tsx and
 * app/admin/setup/layout.tsx). False by default, so demo sessions get the
 * exact same screens as everyone else. Reads the verified token claims, no
 * database query; authorization never depends on it (that is
 * getCurrentUser + lib/demoWriteGuard.ts + proxy.ts).
 */
export async function isDemoSession(): Promise<boolean> {
  if (!isDemoReadOnlyMode()) return false;
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getClaims();
    return isDemoAccountEmail(data?.claims?.email);
  } catch {
    return false;
  }
}

/**
 * Same as getCurrentUser(), but redirects to /login (preserving the
 * originally-requested path via ?next=) instead of returning null —
 * for Server Components that require a session to render at all
 * (nearly every page cut over in Phase 2). API routes use
 * getCurrentUser() directly instead and return 401 JSON, since
 * redirecting a fetch() caller to an HTML login page isn't useful.
 */
export async function requireCurrentUser(nextPath?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const loginUrl = nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login";
    redirect(loginUrl);
  }
  return user;
}
