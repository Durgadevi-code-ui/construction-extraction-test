import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/apiErrors";
import { getSupabaseClient } from "@/lib/supabase";
import { createPasswordCheckClient, getSupabaseServiceRoleClient } from "@/lib/supabaseAdmin";
import { getDepartmentProjectId, getUserLinkContext } from "@/lib/admin";
import { assertAdminOrDelegated } from "@/lib/delegation";
import { isAdminUser } from "@/lib/authContext";
import { getCurrentUser } from "@/lib/session";
import { passwordProblem, setPasswordVerified } from "@/lib/authAccounts";

export const runtime = "nodejs";

/**
 * Admin Setup → Users → Reset Password: sets a new password for a user who
 * already has a login. The supported replacement for editing passwords by
 * hand in the Supabase dashboard (how the accounts that "stopped working"
 * got out of sync) — and the only recovery path for accounts whose email
 * address cannot receive Supabase's reset email.
 *
 * Same authorization as Link Login (app/api/admin/link-auth/route.ts): a
 * real Admin for anyone; a Contractor with an active USER_MANAGEMENT
 * delegation only inside its project/department, never for an Admin; and
 * never for the caller's own account (that is /reset-password).
 *
 * setPasswordVerified checks profile ↔ login ↔ email first, sets the
 * password through the Supabase Admin API, proves it by signing in with it,
 * then revokes every session of that user. Only a verified change is
 * reported as success. The password is never logged or returned.
 */
export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const targetUserId: unknown = body?.targetUserId;
    const password: unknown = body?.password;

    if (typeof targetUserId !== "string" || !targetUserId) {
      return NextResponse.json({ error: "targetUserId is required." }, { status: 400 });
    }
    if (targetUserId === currentUser.userId) {
      return NextResponse.json({ error: "Change your own password from your account page." }, { status: 400 });
    }
    const problem = passwordProblem(password);
    if (problem) {
      return NextResponse.json({ error: `${problem.charAt(0).toUpperCase()}${problem.slice(1)}.` }, { status: 400 });
    }

    const target = await getUserLinkContext(supabase, targetUserId);
    const actorIsRealAdmin = await isAdminUser(supabase, currentUser.userId);

    if (target.role === "ADMIN" && !actorIsRealAdmin) {
      return NextResponse.json({ error: "Only an existing Admin may reset an Admin's password." }, { status: 403 });
    }
    if (!actorIsRealAdmin) {
      const projectId = await getDepartmentProjectId(supabase, target.departmentId);
      await assertAdminOrDelegated(supabase, {
        actorUserId: currentUser.userId,
        permission: "USER_MANAGEMENT",
        projectId,
        departmentId: target.departmentId,
      });
    }
    if (!target.isLinked) {
      return NextResponse.json({ error: "This user has no login yet — use Link Login instead." }, { status: 400 });
    }

    const result = await setPasswordVerified(getSupabaseServiceRoleClient(), createPasswordCheckClient, {
      email: target.email,
      password: password as string,
    });
    if (result.status !== "updated") {
      return jsonError(`The password was not confirmed: ${result.detail}`, 500);
    }
    return NextResponse.json({ ok: true, detail: result.detail });
  } catch (err) {
    // No raw error logging: it could carry the target's email/context.
    const message = err instanceof Error ? err.message : "Failed to reset the password.";
    return jsonError(message, 500);
  }
}
