import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeEmail } from "./authAccounts";

/**
 * TEMPORARY — development/demo stage only. MUST BE REMOVED before real
 * client data or sensitive business information is stored in this
 * application (owner's decision, 2026-11-09; see
 * CONSTRUCTION_DEMO_LOGIN_IMPLEMENTATION_REPORT.md §17).
 *
 * The alternate sign-in (/demo-login → Admin → Sign In) opens the SAME,
 * one and only Admin: it signs this browser in as the existing ADMIN
 * account (users.user_role = 'ADMIN'), without its password, by issuing a
 * one-time sign-in token server-side (service role, generateLink) and
 * redeeming it with verifyOtp — the same mechanism app/auth/confirm uses
 * for emailed links. The session is an ordinary session of that account,
 * so every page and API applies the existing Admin authorization
 * (isAdminUser, resolveAdminSetupAccess) unchanged. The account's
 * password, role and email are never changed.
 *
 * Off unless TEMP_ALTERNATE_ADMIN_LOGIN=true (and Demo Login is enabled).
 * TEMP_ALTERNATE_ADMIN_EMAIL picks the Admin account; when unset, the
 * single Active ADMIN is used, and nothing happens if there isn't exactly
 * one. To remove the entry: unset TEMP_ALTERNATE_ADMIN_LOGIN (immediate),
 * then delete this file and its callers (app/demo-login/actions.ts
 * enterAsAdmin, app/demo-login/page.tsx, components/auth/DemoLoginForm.tsx,
 * app/login/actions.ts ALTERNATE_ADMIN_COOKIE checks).
 */
export function alternateAdminEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TEMP_ALTERNATE_ADMIN_LOGIN?.trim().toLowerCase() === "true" && env.DEMO_LOGIN_ENABLED === "true";
}

/** Marks a browser whose session came through the alternate Admin entry
 * (httpOnly; set by enterAsAdmin). Logout then ends only this browser's
 * session (never the real Admin's other sessions), and the Admin's own
 * password can't be changed from here (so normal login keeps working). */
export const ALTERNATE_ADMIN_COOKIE = "alt_admin_entry";

export type AlternateAdminAccount = { userId: string; authUserId: string; email: string };

/** The existing ADMIN account the alternate entry signs in as, or null. */
export async function resolveAlternateAdmin(
  admin: SupabaseClient,
  env: Record<string, string | undefined> = process.env
): Promise<AlternateAdminAccount | null> {
  const { data, error } = await admin
    .from("users")
    .select("user_id, user_mail, auth_user_id, user_role, status")
    .eq("user_role", "ADMIN")
    .eq("status", "Active");
  if (error || !data) return null;
  const wanted = normalizeEmail(env.TEMP_ALTERNATE_ADMIN_EMAIL);
  const candidates = data.filter(
    (row) => row.auth_user_id && (!wanted || normalizeEmail(row.user_mail as string) === wanted)
  );
  if (candidates.length !== 1) return null;
  const row = candidates[0];
  return { userId: row.user_id as string, authUserId: row.auth_user_id as string, email: normalizeEmail(row.user_mail as string) };
}
