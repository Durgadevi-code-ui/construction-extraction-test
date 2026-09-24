import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import {
  assignWorkItemToWorker,
  getForemanAssignmentBoard,
  removeWorkItemAssignment,
} from "@/lib/workflow";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const board = await getForemanAssignmentBoard(supabase, currentUser.userId);
    return NextResponse.json(board);
  } catch (err) {
    console.error("Failed to load assignment board:", err);
    const message = err instanceof Error ? err.message : "Failed to load assignment board.";
    // Role/scope rejection (assertRole: board is Subcontractor-only) is a
    // 403, not a server error — same mapping as app/api/workflow/dashboard.
    const unauthorized = message.includes("not authorized");
    return NextResponse.json({ error: message }, { status: unauthorized ? 403 : 500 });
  }
}

export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const subcontractorUserId = currentUser.userId;

  try {
    const body = await request.json();
    const action: unknown = body?.action;
    const workItemId: unknown = body?.workItemId;
    const workerUserId: unknown = body?.workerUserId;

    if (typeof workItemId !== "string" || typeof workerUserId !== "string") {
      return NextResponse.json(
        { error: "workItemId and workerUserId are required." },
        { status: 400 }
      );
    }

    if (action === "assign") {
      await assignWorkItemToWorker(supabase, { subcontractorUserId, workItemId, workerUserId });
      return NextResponse.json({ ok: true });
    }

    if (action === "remove") {
      await removeWorkItemAssignment(supabase, { subcontractorUserId, workItemId, workerUserId });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    console.error("Assignment action failed:", err);
    const message = err instanceof Error ? err.message : "Action failed.";
    // Caller not allowed to manage this assignment (assertCanManageAssignments)
    // is a 403, not a server error — same mapping as app/api/workflow/dashboard.
    const unauthorized = message.includes("not authorized");
    return NextResponse.json({ error: message }, { status: unauthorized ? 403 : 500 });
  }
}
