import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { createUserWithRole, deactivateUserProjectRole, getUserProjectRoleScope } from "@/lib/admin";
import { assertAdminOrDelegated } from "@/lib/delegation";
import { isAdminUser } from "@/lib/authContext";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

const VALID_ROLES = ["WORKER", "FOREMAN", "SUPERVISOR", "ADMIN"];

/**
 * User management can now be delegated (USER_MANAGEMENT — see
 * supabase/migrations/00000000000009_delegation_admin_permissions.sql),
 * but ONLY for operational roles (WORKER/FOREMAN/SUPERVISOR) — creating
 * or promoting to ADMIN stays strictly real-Admin-only, checked here
 * independently of the delegated-permission check below, so a
 * delegation can never be used to mint another unrestricted Admin no
 * matter what permissions it was granted (see
 * lib/delegationTypes.ts ADMIN_DELEGATION_PERMISSIONS doc, requirement:
 * "credentials/security administration must be controlled by an
 * existing higher authority, never self-service"). actorUserId is
 * always the caller's own verified session identity now, never a
 * request field — a Contractor can no longer claim to be Admin (or
 * claim to be a different, more-broadly-delegated Contractor) by
 * editing the request body.
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
    const email: unknown = body?.email;
    const departmentId: unknown = body?.departmentId;
    const projectId: unknown = body?.projectId;
    const role: unknown = body?.role;

    if (typeof email !== "string" || !email.trim()) {
      return NextResponse.json({ error: "email is required." }, { status: 400 });
    }
    if (typeof departmentId !== "string" || !departmentId) {
      return NextResponse.json({ error: "departmentId is required." }, { status: 400 });
    }
    if (typeof projectId !== "string" || !projectId) {
      return NextResponse.json({ error: "projectId is required." }, { status: 400 });
    }
    if (typeof role !== "string" || !VALID_ROLES.includes(role)) {
      return NextResponse.json(
        { error: `role must be one of: ${VALID_ROLES.join(", ")}.` },
        { status: 400 }
      );
    }

    const actorIsRealAdmin = await isAdminUser(supabase, actorUserId);

    if (role === "ADMIN" && !actorIsRealAdmin) {
      return NextResponse.json(
        { error: "Only an existing Admin may create or promote another Admin account." },
        { status: 403 }
      );
    }

    if (!actorIsRealAdmin) {
      await assertAdminOrDelegated(supabase, {
        actorUserId,
        permission: "USER_MANAGEMENT",
        projectId,
        departmentId,
      });
    }

    await createUserWithRole(supabase, {
      email: email.trim(),
      firstName: typeof body?.firstName === "string" ? body.firstName.trim() || null : null,
      lastName: typeof body?.lastName === "string" ? body.lastName.trim() || null : null,
      departmentId,
      projectId,
      role,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to create user:", err);
    const message = err instanceof Error ? err.message : "Failed to create user.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Removes one project/department/role assignment (see
 * deactivateUserProjectRole) — the user account and every other
 * assignment it holds are untouched. A delegated USER_MANAGEMENT
 * caller may deactivate only an assignment within their delegated
 * project/department scope, and can never touch an ADMIN-role
 * assignment (looked up server-side from the target row itself, not
 * trusted from the client) — the same "no delegation can remove or
 * demote an Admin" guarantee as the POST handler above.
 */
export async function DELETE(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const actorUserId = currentUser.userId;

  try {
    const body = await request.json();
    const userProjectRoleId: unknown = body?.userProjectRoleId;

    if (typeof userProjectRoleId !== "string" || !userProjectRoleId) {
      return NextResponse.json({ error: "userProjectRoleId is required." }, { status: 400 });
    }

    const actorIsRealAdmin = await isAdminUser(supabase, actorUserId);
    const target = await getUserProjectRoleScope(supabase, userProjectRoleId);

    if (target.role === "ADMIN" && !actorIsRealAdmin) {
      return NextResponse.json(
        { error: "Only an existing Admin may remove another Admin's assignment." },
        { status: 403 }
      );
    }

    if (!actorIsRealAdmin) {
      await assertAdminOrDelegated(supabase, {
        actorUserId,
        permission: "USER_MANAGEMENT",
        projectId: target.projectId,
        departmentId: target.departmentId,
      });
    }

    await deactivateUserProjectRole(supabase, userProjectRoleId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to remove assignment:", err);
    const message = err instanceof Error ? err.message : "Failed to remove assignment.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
