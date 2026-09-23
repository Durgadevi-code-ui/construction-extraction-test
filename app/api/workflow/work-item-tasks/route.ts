import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { createWorkItemTask, updateWorkItemTask } from "@/lib/workflow";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Task configuration under an existing Work Item — Contractor/
 * Supervisor/Manager or Subcontractor/Foreman (their own department),
 * Admin, or a delegated Contractor (WORK_ITEM_MANAGEMENT), same
 * authorization model as /api/workflow/planned-quantity (see
 * lib/workflow.ts assertCanManageWorkItemTasks, checked server-side
 * inside createWorkItemTask/updateWorkItemTask — never only a hidden
 * button). Worker is never authorized, enforced there, not just by this
 * route being outside the Worker UI.
 *
 * Reuses the existing work_items.additional_fields.__tasks
 * representation — no new table, no second task storage.
 */
export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const workItemId: unknown = body?.workItemId;
    const label: unknown = body?.label;
    const conditional: unknown = body?.conditional;

    if (typeof workItemId !== "string" || !workItemId) {
      return NextResponse.json({ error: "workItemId is required." }, { status: 400 });
    }
    if (typeof label !== "string" || !label.trim()) {
      return NextResponse.json({ error: "Task name is required." }, { status: 400 });
    }

    const task = await createWorkItemTask(supabase, {
      actorUserId: currentUser.userId,
      workItemId,
      label,
      conditional: conditional === true,
    });

    return NextResponse.json({ task });
  } catch (err) {
    console.error("Failed to create task:", err);
    const message = err instanceof Error ? err.message : "Failed to create task.";
    const forbidden = message.includes("is not authorized");
    return NextResponse.json({ error: message }, { status: forbidden ? 403 : 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const workItemId: unknown = body?.workItemId;
    const taskId: unknown = body?.taskId;
    const label: unknown = body?.label;
    const conditional: unknown = body?.conditional;
    const status: unknown = body?.status;

    if (typeof workItemId !== "string" || !workItemId) {
      return NextResponse.json({ error: "workItemId is required." }, { status: 400 });
    }
    if (typeof taskId !== "string" || !taskId) {
      return NextResponse.json({ error: "taskId is required." }, { status: 400 });
    }
    if (status !== undefined && status !== "Active" && status !== "Inactive") {
      return NextResponse.json({ error: 'status must be "Active" or "Inactive".' }, { status: 400 });
    }

    await updateWorkItemTask(supabase, {
      actorUserId: currentUser.userId,
      workItemId,
      taskId,
      ...(typeof label === "string" ? { label } : {}),
      ...(typeof conditional === "boolean" ? { conditional } : {}),
      ...(status === "Active" || status === "Inactive" ? { status } : {}),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to update task:", err);
    const message = err instanceof Error ? err.message : "Failed to update task.";
    const forbidden = message.includes("is not authorized");
    return NextResponse.json({ error: message }, { status: forbidden ? 403 : 500 });
  }
}
