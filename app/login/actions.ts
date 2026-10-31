"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { safeNextPath } from "@/lib/safeRedirect";
import { getSupabaseServiceRoleClient } from "@/lib/supabaseAdmin";
import { RATE_LIMITS, checkRateLimit, clientIp, rateLimitMessage } from "@/lib/rateLimit";
import { randomUUID } from "node:crypto";
import { classifySignInError, normalizeEmail, passwordProblem, passwordResetOrigin } from "@/lib/authAccounts";

export type AuthFormState = { error?: string; message?: string } | undefined;

/**
 * Password login via Supabase Auth — Supabase stores/verifies the
 * password entirely itself (auth.users, internal to Supabase, never
 * touched by this app's own code or schema); nothing password-related
 * is ever written to public.users. A Server Action, not a client-side
 * fetch, so the credential exchange happens server-to-server (this
 * server to Supabase Auth) — the browser never sees anything but the
 * resulting session cookie, set via lib/supabaseServer.ts's cookie
 * adapter.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function login(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  // Same normalization as account creation (lib/authAccounts.ts), so the
  // email typed here is always the one stored with the account.
  const email = normalizeEmail(formData.get("email"));
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "").trim();
  const redirectTo = safeNextPath(next, "/workflow");

  // Format validation only — never used to tell an attacker whether an
  // email is registered (see the generic "Invalid email or password"
  // below, which is Supabase's own deliberate choice not to
  // distinguish "wrong password" from "no such account").
  if (!email || !EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (!password) {
    return { error: "Password is required." };
  }

  // Password guessing: capped per client IP and per target email before
  // Supabase Auth is contacted (lib/rateLimit.ts). Supabase's own auth
  // limits see this server's IP, not the user's, so they can't do this.
  const ip = clientIp(await headers());
  for (const [rule, identifier] of [
    [RATE_LIMITS.loginPerIp, ip],
    [RATE_LIMITS.loginPerEmail, email],
  ] as const) {
    const limit = await checkRateLimit(rule, identifier);
    if (!limit.allowed) return { error: rateLimitMessage(limit) };
  }

  const supabase = await createSupabaseServerClient();

  let signInResult;
  try {
    signInResult = await supabase.auth.signInWithPassword({ email, password });
  } catch {
    return { error: "Network error — check your connection and try again." };
  }

  const { data, error } = signInResult;

  if (error) {
    return { error: signInErrorMessage(error) };
  }

  // A Supabase Auth account with no linked public.users row (see
  // auth_user_id) has nothing this app can do with it yet — never
  // assign a default role or Admin access in that case (requirement:
  // safe onboarding, not silent privilege). Sign back out immediately
  // rather than leaving an authenticated-but-unusable session sitting
  // around, which would just bounce confusingly between pages.
  const { data: profile, error: profileError } = await getSupabaseServiceRoleClient()
    .from("users")
    .select("user_id")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();

  // The password was correct; a failed lookup is an infrastructure problem,
  // never "not linked" (which used to be shown, and the user signed out).
  if (profileError) {
    const ref = logRef();
    console.error("Profile lookup after sign-in failed", { ref, code: profileError.code });
    await supabase.auth.signOut({ scope: "local" });
    return { error: `The sign-in service is temporarily unavailable. Please try again shortly. (ref ${ref})` };
  }

  if (!profile) {
    await supabase.auth.signOut();
    return {
      error:
        "This login isn't linked to an application account yet. Contact your Administrator to get access.",
    };
  }

  redirect(redirectTo);
}

/**
 * Only Supabase's own "wrong email or password" answer is shown as
 * "Invalid email or password." Rate limiting, an unreachable Supabase or
 * a misconfigured key used to show that same message, which made those
 * failures indistinguishable from a wrong password. None of the other
 * messages reveal whether an account exists: Supabase answers
 * invalid_credentials for unknown emails and wrong passwords alike.
 * The log line carries Supabase's error code/status only — never the
 * email or password.
 */
function signInErrorMessage(error: { message: string; status?: number; code?: string; name?: string }): string {
  const kind = classifySignInError(error);
  if (kind === "invalid_credentials") return "Invalid email or password.";
  if (kind === "email_not_confirmed") return "Please confirm your email address before signing in.";

  // `ref` appears in the message and the server log, so a reported failure
  // can be found in the Vercel logs without logging who it was.
  const ref = logRef();
  console.error("Supabase sign-in failed", { ref, kind, name: error.name, status: error.status, code: error.code });

  if (kind === "rate_limited") return `Too many sign-in attempts. Please wait a few minutes and try again. (ref ${ref})`;
  if (kind === "unavailable") return `The sign-in service is temporarily unavailable. Please try again shortly. (ref ${ref})`;
  // Supabase rejected the app's own API key, not the user.
  if (kind === "app_key_rejected") return `Sign-in is not available right now. Please contact your Administrator. (ref ${ref})`;
  return "Invalid email or password.";
}

/** Short random id tying a user-visible failure to its server log line. */
function logRef(): string {
  return randomUUID().slice(0, 8);
}

export async function logout(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/** Sends Supabase's own hosted "reset your password" email — no custom
 * email sending or token handling in this app; Supabase generates and
 * verifies the link itself (landing on app/auth/confirm/route.ts, then
 * app/auth/update-password). Always returns a generic success message
 * regardless of whether the email exists, so this can't be used to
 * enumerate registered accounts. */
export async function requestPasswordReset(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { error: "Email is required." };
  }

  // Reset-email flooding: capped per client IP and per target email, the
  // same way as login above. Applies to every email alike, so it reveals
  // nothing about which accounts exist.
  const ip = clientIp(await headers());
  for (const [rule, identifier] of [
    [RATE_LIMITS.passwordResetPerIp, ip],
    [RATE_LIMITS.passwordResetPerEmail, email.toLowerCase()],
  ] as const) {
    const limit = await checkRateLimit(rule, identifier);
    if (!limit.allowed) return { error: rateLimitMessage(limit) };
  }

  const supabase = await createSupabaseServerClient();
  // Never localhost in a deployment, never the request's Host header (see lib/authAccounts.ts).
  const { origin } = passwordResetOrigin(process.env);

  await supabase.auth.resetPasswordForEmail(email, {
    // Supabase appends its own `token_hash`/`type=recovery` to this URL
    // when it builds the emailed link — `next` is the only param this
    // app adds, read back in app/auth/confirm/route.ts.
    redirectTo: `${origin}/auth/confirm?next=/auth/update-password`,
  });

  return { message: "If an account exists for that email, a reset link has been sent." };
}

/** Sets a new password for the CURRENT session — only reachable with a
 * valid session, which for this flow means having just landed here via
 * app/auth/confirm/route.ts's verifyOtp (a recovery-type link click
 * establishes a real, if short-lived-by-Supabase's-own-policy, session
 * the same way a password login does). Supabase stores the new
 * password itself; nothing password-related touches this app's schema. */
export async function updatePassword(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const problem = passwordProblem(password);
  if (problem) {
    return { error: `${problem.charAt(0).toUpperCase()}${problem.slice(1)}.` };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    return { error: "Couldn't update your password — the reset link may have expired. Request a new one." };
  }

  // Ends every other session of this user (e.g. one opened with the old
  // password); this browser stays signed in.
  const { error: revokeError } = await supabase.auth.signOut({ scope: "others" });
  if (revokeError) {
    console.error("Password updated but revoking other sessions failed", { status: revokeError.status, code: revokeError.code });
  }

  redirect("/account");
}
