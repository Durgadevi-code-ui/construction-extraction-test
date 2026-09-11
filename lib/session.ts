import "server-only";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "./supabaseServer";

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
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user: authUser },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !authUser) return null;

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("user_id, user_mail")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();

  if (profileError || !profile) return null;

  return {
    authUserId: authUser.id,
    userId: profile.user_id as string,
    email: profile.user_mail as string,
  };
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
