import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { createProject, updateProject } from "@/lib/admin";
import { assertAdminRole, assertAdminOrDelegated } from "@/lib/delegation";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Creating a brand-new project stays Admin-only, even under a
 * PROJECT_MANAGEMENT delegation: unlike editing (PATCH below), a
 * project that doesn't exist yet has no project/department scope this
 * app's delegation model could bound it to — the same reasoning
 * Company management is never delegable at all (see
 * supabase/migrations/00000000000009_delegation_admin_permissions.sql).
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
    const companyId: unknown = body?.companyId;
    const projectCode: unknown = body?.projectCode;
    const projectName: unknown = body?.projectName;
    const projectLocation: unknown = body?.projectLocation;

    if (typeof companyId !== "string" || !companyId) {
      return NextResponse.json({ error: "companyId is required." }, { status: 400 });
    }
    if (typeof projectCode !== "string" || !projectCode.trim()) {
      return NextResponse.json({ error: "projectCode is required." }, { status: 400 });
    }
    if (typeof projectName !== "string" || !projectName.trim()) {
      return NextResponse.json({ error: "projectName is required." }, { status: 400 });
    }

    await assertAdminRole(supabase, actorUserId);

    await createProject(supabase, {
      companyId,
      projectCode: projectCode.trim(),
      projectName: projectName.trim(),
      projectLocation:
        typeof projectLocation === "string" && projectLocation.trim()
          ? projectLocation.trim()
          : null,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to create project:", err);
    const message = err instanceof Error ? err.message : "Failed to create project.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Edits an existing project's name/location — Admin, or a Contractor
 * holding an active PROJECT_MANAGEMENT delegation covering this exact
 * project (assertAdminOrDelegated resolves and checks that server-side;
 * a projectId outside the delegate's scope, however supplied, is
 * rejected — never trusted from the client).
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
    const projectId: unknown = body?.projectId;
    const projectName: unknown = body?.projectName;
    const projectLocation: unknown = body?.projectLocation;

    if (typeof projectId !== "string" || !projectId) {
      return NextResponse.json({ error: "projectId is required." }, { status: 400 });
    }

    await assertAdminOrDelegated(supabase, {
      actorUserId,
      permission: "PROJECT_MANAGEMENT",
      projectId,
    });

    await updateProject(supabase, projectId, {
      ...(typeof projectName === "string" && projectName.trim()
        ? { projectName: projectName.trim() }
        : {}),
      ...(projectLocation !== undefined
        ? { projectLocation: typeof projectLocation === "string" ? projectLocation.trim() || null : null }
        : {}),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to update project:", err);
    const message = err instanceof Error ? err.message : "Failed to update project.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
