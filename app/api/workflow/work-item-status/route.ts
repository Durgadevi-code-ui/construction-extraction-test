import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { setWorkItemActive } from "@/lib/workflow";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Activate / deactivate one work item — a soft status change on the
 * existing work_items row (see lib/workflow.ts setWorkItemActive), never
 * a delete. Authorization is checked server-side there, with the same
 * rule as task and Planned Quantity configuration (Admin, the work
 * item's own Subcontractor/Contractor, or a delegated
 * WORK_ITEM_MANAGEMENT Contractor). Worker is never authorized.
 */
export async function PATCH(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const workItemId: unknown = body?.workItemId;
    const active: unknown = body?.active;

    if (typeof workItemId !== "string" || !workItemId) {
      return NextResponse.json({ error: "workItemId is required." }, { status: 400 });
    }
    if (typeof active !== "boolean") {
      return NextResponse.json({ error: "active must be true or false." }, { status: 400 });
    }

    await setWorkItemActive(supabase, { actorUserId: currentUser.userId, workItemId, active });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to change work item status:", err);
    const message = err instanceof Error ? err.message : "Failed to change work item status.";
    const forbidden = message.includes("is not authorized");
    return NextResponse.json({ error: message }, { status: forbidden ? 403 : 500 });
  }
}
