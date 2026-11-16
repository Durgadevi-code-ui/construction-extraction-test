import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/apiErrors";
import { getSupabaseClient } from "@/lib/supabase";
import {
  AccountInputError,
  createUserWithLogin,
  deactivateUserProjectRole,
  getDepartmentProjectId,
  getUserProjectRoleScope,
} from "@/lib/admin";
import { getSupabaseServiceRoleClient } from "@/lib/supabaseAdmin";
import { assertAdminOrDelegated } from "@/lib/delegation";
import { isAdminUser } from "@/lib/authContext";
import { getCurrentUser } from "@/lib/session";
import { APPROVED_ROLES, emailProblem, normalizeEmail } from "@/lib/authAccounts";

export const runtime = "nodejs";

const VALID_ROLES: readonly string[] = APPROVED_ROLES;

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
    // Lowercased like Supabase Auth stores it, so the same person can't
    // become two app users, and a malformed address is refused before a
    // login is ever created for it.
    const normalizedEmail = normalizeEmail(email);
    const emailError = emailProblem(normalizedEmail);
    if (emailError) {
      return NextResponse.json({ error: `${emailError}.` }, { status: 400 });
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

    // The department must belong to the project: role checks compare
    // department ids, so a mismatched pair would grant review/assignment
    // rights over another project's department — and a whole-project
    // delegation check above does not look at departmentId at all.
    if ((await getDepartmentProjectId(supabase, departmentId)) !== projectId) {
      return NextResponse.json(
        { error: "That department does not belong to the selected project." },
        { status: 400 }
      );
    }

    // A new user is created together with its login (the password is
    // required, checked, and never logged or returned); an existing user
    // only gains the role assignment. See lib/admin.ts createUserWithLogin.
    const result = await createUserWithLogin(supabase, getSupabaseServiceRoleClient(), {
      email: normalizedEmail,
      firstName: typeof body?.firstName === "string" ? body.firstName.trim() || null : null,
      lastName: typeof body?.lastName === "string" ? body.lastName.trim() || null : null,
      departmentId,
      projectId,
      role,
      password: typeof body?.password === "string" ? body.password : null,
    });

    return NextResponse.json({ ok: true, userCreated: result.userCreated, loginCreated: result.loginCreated });
  } catch (err) {
    if (err instanceof AccountInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Failed to create user:", err);
    const message = err instanceof Error ? err.message : "Failed to create user.";
    return jsonError(message, 500);
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
    return jsonError(message, 500);
  }
}
