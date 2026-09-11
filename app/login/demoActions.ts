"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { getSupabaseServiceRoleClient } from "@/lib/supabaseAdmin";
import { getSupabaseClient } from "@/lib/supabase";
import { DEMO_MODE_ENABLED, isDemoRoleKey, resolveDemoEmail } from "@/lib/demoAuth";

export type DemoLoginState = { error?: string } | undefined;

/**
 * Establishes a REAL Supabase Auth session for a predefined demo
 * identity — no password, but also no fake/client-side auth state:
 * this uses Supabase's own admin.generateLink("magiclink") + verifyOtp
 * flow (the exact same session-establishment mechanism
 * app/auth/confirm/route.ts already uses for password-reset links) to
 * mint a genuine session cookie via the cookie-aware server client.
 * Everything downstream (getCurrentUser, getUserContext, role/
 * department scoping) runs completely unmodified after this — a demo
 * login is indistinguishable, from that point on, from a real password
 * login by the same account.
 *
 * `role` is validated against the closed DemoRoleKey enum before
 * anything else runs — there is no path from this form to an arbitrary
 * email or user id (see lib/demoAuth.ts doc).
 */
export async function demoLogin(
  _prevState: DemoLoginState,
  formData: FormData
): Promise<DemoLoginState> {
  if (!DEMO_MODE_ENABLED) {
    return { error: "Demo mode is not enabled in this environment." };
  }

  const role = formData.get("role");
  if (!isDemoRoleKey(role)) {
    return { error: "Unknown demo identity." };
  }

  const email = resolveDemoEmail(role);
  if (!email) {
    return { error: "This demo identity isn't configured on the server." };
  }

  // Refuse unless this email is already a REAL, provisioned account
  // (public.users.auth_user_id set — see supabase/migrations/
  // 00000000000010_users_auth_link.sql) before ever calling
  // admin.generateLink below. Supabase's generateLink(magiclink) will
  // silently CREATE a brand-new, unlinked Auth account for an email
  // that doesn't exist yet — without this check, a misconfigured/
  // typo'd DEMO_USER_*_EMAIL would spin up a stray Auth user with no
  // application identity behind it instead of failing loudly, which
  // would also violate the "demo mode only ever selects among real,
  // already-provisioned accounts" guarantee documented in
  // lib/demoAuth.ts.
  const anonSupabase = getSupabaseClient();
  const { data: linkedProfile } = await anonSupabase
    .from("users")
    .select("user_id")
    .eq("user_mail", email)
    .not("auth_user_id", "is", null)
    .maybeSingle();

  if (!linkedProfile) {
    console.error(`Demo login: configured email for role "${role}" has no linked app account.`);
    return {
      error:
        "This demo identity isn't linked to an application account yet. An Admin needs to link it first (Admin Setup -> Users -> Link Login).",
    };
  }

  const authAdmin = getSupabaseServiceRoleClient();
  const { data: linkData, error: linkError } = await authAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });

  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    console.error("Demo login: failed to generate link", linkError?.message);
    return {
      error:
        "Could not start the demo session — this demo account may not exist yet in Supabase Auth.",
    };
  }

  const supabase = await createSupabaseServerClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });

  if (verifyError) {
    console.error("Demo login: failed to verify link", verifyError.message);
    return { error: "Could not start the demo session." };
  }

  redirect("/workflow");
}
