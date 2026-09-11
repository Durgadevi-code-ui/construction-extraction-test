import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getSupabaseServiceRoleClient } from "@/lib/supabaseAdmin";
import { getUserLinkContext, getDepartmentProjectId, linkUserToAuthAccount } from "@/lib/admin";
import { assertAdminOrDelegated } from "@/lib/delegation";
import { isAdminUser } from "@/lib/authContext";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Links an existing public.users row to a brand-new Supabase Auth
 * account (Phase 4 — see lib/admin.ts linkUserToAuthAccount for why
 * this never matches-by-email onto an existing Auth account). Same
 * authorization shape as creating/removing a user: real Admin
 * unconditionally, or a Contractor holding an active USER_MANAGEMENT
 * delegation for the target's project/department — but never for a
 * target whose role is ADMIN, matching the same "no delegation can
 * mint or touch an Admin" guarantee as app/api/admin/users/route.ts.
 */
export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const actorUserId = currentUser.userId;

  try {
    const body = await request.json();
    const targetUserId: unknown = body?.targetUserId;
    const password: unknown = body?.password;

    if (typeof targetUserId !== "string" || !targetUserId) {
      return NextResponse.json({ error: "targetUserId is required." }, { status: 400 });
    }
    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "password is required and must be at least 8 characters." },
        { status: 400 }
      );
    }

    const target = await getUserLinkContext(supabase, targetUserId);
    const actorIsRealAdmin = await isAdminUser(supabase, actorUserId);

    if (target.role === "ADMIN" && !actorIsRealAdmin) {
      return NextResponse.json(
        { error: "Only an existing Admin may link another Admin's login." },
        { status: 403 }
      );
    }

    if (!actorIsRealAdmin) {
      const projectId = await getDepartmentProjectId(supabase, target.departmentId);
      await assertAdminOrDelegated(supabase, {
        actorUserId,
        permission: "USER_MANAGEMENT",
        projectId,
        departmentId: target.departmentId,
      });
    }

    const authAdminClient = getSupabaseServiceRoleClient();
    await linkUserToAuthAccount(supabase, authAdminClient, { targetUserId, password });

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Deliberately no console.error of the raw error here — it could
    // contain the email/context of the account being linked. Client
    // gets a safe, actionable message; nothing password-related is
    // ever logged (the password itself never appears in any error path
    // above).
    const message = err instanceof Error ? err.message : "Failed to link login.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
