"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { getSupabaseServiceRoleClient } from "@/lib/supabaseAdmin";
import { RATE_LIMITS, checkRateLimit, clientIp, rateLimitMessage } from "@/lib/rateLimit";
import { classifySignInError } from "@/lib/authAccounts";
import { checkDemoAccount, demoLoginConfig, demoSlot, repairDemoLogin } from "@/lib/demoAccess";

export type DemoLoginState = { error?: string } | undefined;

/**
 * One-click demo entry: the form sends only a slot key (lib/demoAccess.ts
 * DEMO_SLOTS); the server signs in as that slot's dedicated demo account
 * with Supabase's password sign-in, using the password from server-side
 * configuration, then keeps the session only if the account is isolated
 * and really has the slot's role and team. The original login action is
 * not used or changed by this.
 */
export async function enterDemoWorkspace(_prevState: DemoLoginState, formData: FormData): Promise<DemoLoginState> {
  const config = demoLoginConfig();
  if (!config.enabled) {
    return { error: "Demo login is not enabled in this environment." };
  }

  const slot = demoSlot(formData.get("role"));
  const account = slot ? config.accounts.get(slot.key) : undefined;
  if (!slot || !account) {
    return { error: "Choose one of the listed demo roles." };
  }

  // Per client IP, sharing the login counter. No per-account limit: the
  // demo accounts are shared, so one visitor could otherwise lock a role
  // out for everyone.
  const limit = await checkRateLimit(RATE_LIMITS.loginPerIp, clientIp(await headers()));
  if (!limit.allowed) return { error: rateLimitMessage(limit) };

  const supabase = await createSupabaseServerClient();
  const admin = getSupabaseServiceRoleClient();
  const signIn = async () => {
    try {
      return await supabase.auth.signInWithPassword({ email: account.email, password: account.password });
    } catch {
      return null;
    }
  };

  let result = await signIn();
  if (result?.error && classifySignInError(result.error) === "invalid_credentials" && (await repairDemoLogin(admin, config, slot))) {
    logDemo(logRef(), slot.key, "repair", "restored-configured-login", {});
    result = await signIn();
  }
  if (!result) {
    return { error: "Network error — check your connection and try again." };
  }

  const { data, error } = result;
  if (error) {
    const ref = logRef();
    const kind = classifySignInError(error);
    logDemo(ref, slot.key, "sign-in", "rejected", { kind, status: error.status, code: error.code });
    if (kind === "rate_limited") return { error: `Too many sign-in attempts. Please wait a few minutes and try again. (ref ${ref})` };
    if (kind === "unavailable") return { error: `The sign-in service is temporarily unavailable. Please try again shortly. (ref ${ref})` };
    return { error: `This demo role isn't available right now. Contact your Administrator. (ref ${ref})` };
  }

  const check = await checkDemoAccount(admin, config, { authUserId: data.user.id, email: data.user.email ?? "" }, slot);
  if (!check.ok) {
    const ref = logRef();
    logDemo(ref, slot.key, "isolation", "refused", { reason: check.reason });
    // Only this browser's new session; other sessions of the account stay.
    await supabase.auth.signOut({ scope: "local" });
    if (check.reason === "lookup-failed") {
      return { error: `The sign-in service is temporarily unavailable. Please try again shortly. (ref ${ref})` };
    }
    return { error: `This demo role is not set up as an isolated demo account, so demo access was refused. Contact your Administrator. (ref ${ref})` };
  }

  logDemo(logRef(), slot.key, "session", "signed-in", { user: check.userId.slice(0, 8) });
  // The Admin slot opens Admin Setup (scoped to the demo project); every
  // other role goes to /workflow, which routes to its own dashboard.
  redirect(slot.delegatedAdmin ? "/admin/setup" : "/workflow");
}

/** One structured server log line per demo attempt: the slot key, never
 * an email, password, token or cookie. */
function logDemo(ref: string, slot: string, stage: string, outcome: string, details: Record<string, unknown>): void {
  const line = JSON.stringify({ ref, slot, stage, outcome, ...details });
  if (outcome === "signed-in") console.info(`[demo-auth] ${line}`);
  else console.warn(`[demo-auth] ${line}`);
}

function logRef(): string {
  return randomUUID().slice(0, 8);
}
