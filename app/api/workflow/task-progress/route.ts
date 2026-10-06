import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { updateTaskProgressAsWorker } from "@/lib/workflow";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * A Worker's task-level update (see lib/workflow.ts
 * updateTaskProgressAsWorker): progress %, done flag and a short note on
 * one task of a work item assigned to them, allowed only while that
 * task's Task Update Access is on. The worker is always the verified
 * session user, never a body field; assignment, task ownership and the
 * access flag are all checked server-side there. Additive — Work
 * Item-level progress (/api/workflow/worker) is unchanged.
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
    const taskId: unknown = body?.taskId;
    const percent: unknown = body?.percent;
    const completed: unknown = body?.completed;
    const note: unknown = body?.note;

    if (typeof workItemId !== "string" || !workItemId) {
      return NextResponse.json({ error: "workItemId is required." }, { status: 400 });
    }
    if (typeof taskId !== "string" || !taskId) {
      return NextResponse.json({ error: "taskId is required." }, { status: 400 });
    }
    if (percent !== null && percent !== undefined && (typeof percent !== "number" || Number.isNaN(percent))) {
      return NextResponse.json({ error: "percent must be a number." }, { status: 400 });
    }
    if (note !== null && note !== undefined && typeof note !== "string") {
      return NextResponse.json({ error: "note must be text." }, { status: 400 });
    }

    const progress = await updateTaskProgressAsWorker(supabase, {
      workerId: currentUser.userId,
      workItemId,
      taskId,
      percent: typeof percent === "number" ? percent : null,
      completed: completed === true,
      note: typeof note === "string" ? note : null,
    });

    return NextResponse.json({ progress });
  } catch (err) {
    console.error("Failed to save task update:", err);
    const message = err instanceof Error ? err.message : "Failed to save task update.";
    const forbidden =
      message.includes("is not authorized") ||
      message.includes("is not assigned") ||
      message.includes("not enabled") ||
      message.includes("does not belong");
    return NextResponse.json({ error: message }, { status: forbidden ? 403 : 500 });
  }
}
