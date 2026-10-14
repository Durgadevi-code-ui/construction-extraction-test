"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { safeNextPath } from "@/lib/safeRedirect";
import { getSupabaseServiceRoleClient } from "@/lib/supabaseAdmin";
import { RATE_LIMITS, checkRateLimit, clientIp, rateLimitMessage } from "@/lib/rateLimit";

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
  const email = String(formData.get("email") ?? "").trim();
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
    [RATE_LIMITS.loginPerEmail, email.toLowerCase()],
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
    if (error.message.toLowerCase().includes("email not confirmed")) {
      return { error: "Please confirm your email address before signing in." };
    }
    return { error: "Invalid email or password." };
  }

  // A Supabase Auth account with no linked public.users row (see
  // auth_user_id) has nothing this app can do with it yet — never
  // assign a default role or Admin access in that case (requirement:
  // safe onboarding, not silent privilege). Sign back out immediately
  // rather than leaving an authenticated-but-unusable session sitting
  // around, which would just bounce confusingly between pages.
  const { data: profile } = await getSupabaseServiceRoleClient()
    .from("users")
    .select("user_id")
    .eq("auth_user_id", data.user.id)
    .maybeSingle();

  if (!profile) {
    await supabase.auth.signOut();
    return {
      error:
        "This login isn't linked to an application account yet. Contact your Administrator to get access.",
    };
  }

  redirect(redirectTo);
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
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

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

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords do not match." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    return { error: "Couldn't update your password — the reset link may have expired. Request a new one." };
  }

  redirect("/account");
}
