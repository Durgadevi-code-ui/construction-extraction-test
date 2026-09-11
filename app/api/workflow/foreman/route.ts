import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import {
  foremanAddComment,
  foremanForwardSubmission,
  listForemanQueue,
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
    const queue = await listForemanQueue(supabase, currentUser.userId);
    return NextResponse.json({ queue });
  } catch (err) {
    console.error("Failed to load foreman queue:", err);
    const message = err instanceof Error ? err.message : "Failed to load queue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const foremanUserId = currentUser.userId;

  try {
    const body = await request.json();
    const action: unknown = body?.action;

    if (action === "submit") {
      const submissionId: unknown = body?.submissionId;
      const progressPercentage: unknown = body?.progressPercentage;
      const description: unknown = body?.description;
      const comment: unknown = body?.comment;

      if (typeof submissionId !== "string") {
        return NextResponse.json(
          { error: "submissionId is required." },
          { status: 400 }
        );
      }

      await foremanForwardSubmission(supabase, {
        submissionId,
        foremanUserId,
        progressPercentage:
          typeof progressPercentage === "number" ? progressPercentage : undefined,
        description: typeof description === "string" ? description : undefined,
        comment: typeof comment === "string" ? comment : undefined,
      });

      return NextResponse.json({ ok: true });
    }

    if (action === "comment") {
      const validationId: unknown = body?.validationId;
      const comment: unknown = body?.comment;

      if (typeof validationId !== "string" || typeof comment !== "string") {
        return NextResponse.json(
          { error: "validationId and comment are required." },
          { status: 400 }
        );
      }

      await foremanAddComment(supabase, { validationId, comment, foremanUserId });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    console.error("Foreman action failed:", err);
    const message = err instanceof Error ? err.message : "Action failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
