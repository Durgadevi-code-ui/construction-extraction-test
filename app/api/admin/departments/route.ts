import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { createDepartment, updateDepartment, getDepartmentProjectId } from "@/lib/admin";
import { assertAdminOrDelegated } from "@/lib/delegation";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Creates a department — Admin, or a Contractor holding a
 * DEPARTMENT_MANAGEMENT delegation for the WHOLE target project (no
 * departmentId passed to the check below): a brand-new department has
 * no existing department_id a department-restricted delegation could
 * be checked against, so only a whole-project grant can create one —
 * the one case in this app that has a natural, safe scope boundary for
 * creation (see lib/delegationTypes.ts ADMIN_DELEGATION_PERMISSIONS doc,
 * and contrast with Project creation, which has none and stays
 * Admin-only entirely).
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
    const projectId: unknown = body?.projectId;
    const departmentCode: unknown = body?.departmentCode;
    const departmentName: unknown = body?.departmentName;

    if (typeof projectId !== "string" || !projectId) {
      return NextResponse.json({ error: "projectId is required." }, { status: 400 });
    }
    if (typeof departmentCode !== "string" || !departmentCode.trim()) {
      return NextResponse.json({ error: "departmentCode is required." }, { status: 400 });
    }
    if (typeof departmentName !== "string" || !departmentName.trim()) {
      return NextResponse.json({ error: "departmentName is required." }, { status: 400 });
    }

    await assertAdminOrDelegated(supabase, {
      actorUserId,
      permission: "DEPARTMENT_MANAGEMENT",
      projectId,
    });

    await createDepartment(supabase, {
      projectId,
      departmentCode: departmentCode.trim(),
      departmentName: departmentName.trim(),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to create department:", err);
    const message = err instanceof Error ? err.message : "Failed to create department.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Edits an existing department's name — Admin, or a Contractor holding
 * an active DEPARTMENT_MANAGEMENT delegation covering this exact
 * department (or whole-project scope for its project).
 */
export async function PATCH(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const actorUserId = currentUser.userId;

  try {
    const body = await request.json();
    const departmentId: unknown = body?.departmentId;
    const departmentName: unknown = body?.departmentName;

    if (typeof departmentId !== "string" || !departmentId) {
      return NextResponse.json({ error: "departmentId is required." }, { status: 400 });
    }
    if (typeof departmentName !== "string" || !departmentName.trim()) {
      return NextResponse.json({ error: "departmentName is required." }, { status: 400 });
    }

    const projectId = await getDepartmentProjectId(supabase, departmentId);
    await assertAdminOrDelegated(supabase, {
      actorUserId,
      permission: "DEPARTMENT_MANAGEMENT",
      projectId,
      departmentId,
    });

    await updateDepartment(supabase, departmentId, { departmentName: departmentName.trim() });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to update department:", err);
    const message = err instanceof Error ? err.message : "Failed to update department.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
