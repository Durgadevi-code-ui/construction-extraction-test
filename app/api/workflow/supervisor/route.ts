import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import {
  getMTDProgress,
  getTodaysProgress,
  getWorkSummary,
  getUserContext,
  getYesterdaysProgress,
  listSupervisorQueue,
  supervisorAddComment,
  supervisorApprove,
  supervisorEditSubmission,
  supervisorRollback,
} from "@/lib/workflow";
import { CONTRACTOR_ROLES } from "@/lib/authContext";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const userId = currentUser.userId;

  try {
    // Contractor review queue — Contractor roles only, same check as the
    // Contractor page guard (app/workflow/supervisor/page.tsx) and the
    // daily-summary route; a Worker/Subcontractor gets 403, not their
    // department's queue.
    const ctx = await getUserContext(supabase, userId);
    if (!CONTRACTOR_ROLES.includes(ctx.role)) {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }

    const [queue, todaysProgress, yesterdaysProgress, mtdProgress, workSummary] =
      await Promise.all([
        listSupervisorQueue(supabase, userId),
        getTodaysProgress(supabase, userId),
        getYesterdaysProgress(supabase, userId),
        getMTDProgress(supabase, userId),
        getWorkSummary(supabase, userId),
      ]);

    return NextResponse.json({
      queue,
      todaysProgress,
      yesterdaysProgress,
      mtdProgress,
      workSummary,
    });
  } catch (err) {
    console.error("Failed to load supervisor dashboard:", err);
    const message = err instanceof Error ? err.message : "Failed to load dashboard.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * A reviewer must never be able to approve/edit/rollback progress
 * without the required permission — supervisorUserId always comes from
 * the verified session (own department or an active delegation, both
 * checked inside supervisorApprove/supervisorEditSubmission/etc. via
 * assertCanReviewProgress, unchanged), never the request body.
 */
export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const supervisorUserId = currentUser.userId;

  try {
    const body = await request.json();
    const action: unknown = body?.action;
    const validationId: unknown = body?.validationId;

    if (typeof validationId !== "string") {
      return NextResponse.json(
        { error: "validationId is required." },
        { status: 400 }
      );
    }

    if (action === "approve") {
      const comment: unknown = body?.comment;
      await supervisorApprove(supabase, {
        validationId,
        supervisorUserId,
        comment: typeof comment === "string" ? comment : undefined,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "edit") {
      const progressPercentage: unknown = body?.progressPercentage;
      const description: unknown = body?.description;
      const comment: unknown = body?.comment;

      if (typeof progressPercentage !== "number" || Number.isNaN(progressPercentage)) {
        return NextResponse.json(
          { error: "progressPercentage must be a number." },
          { status: 400 }
        );
      }
      if (progressPercentage < 0 || progressPercentage > 100) {
        return NextResponse.json(
          { error: "progressPercentage must be between 0 and 100." },
          { status: 400 }
        );
      }

      await supervisorEditSubmission(supabase, {
        validationId,
        progressPercentage,
        description: typeof description === "string" ? description : undefined,
        comment: typeof comment === "string" ? comment : undefined,
        supervisorUserId,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "comment") {
      const comment: unknown = body?.comment;
      if (typeof comment !== "string" || !comment.trim()) {
        return NextResponse.json({ error: "comment is required." }, { status: 400 });
      }
      await supervisorAddComment(supabase, { validationId, comment, supervisorUserId });
      return NextResponse.json({ ok: true });
    }

    if (action === "rollback") {
      await supervisorRollback(supabase, { validationId, supervisorUserId });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    console.error("Supervisor action failed:", err);
    const message = err instanceof Error ? err.message : "Action failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
