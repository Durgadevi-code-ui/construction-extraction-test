import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getWorkerDashboard, submitWorkerProgress } from "@/lib/workflow";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const workItemId = request.nextUrl.searchParams.get("workItemId");

  try {
    const dashboard = await getWorkerDashboard(supabase, currentUser.userId, workItemId);
    return NextResponse.json(dashboard);
  } catch (err) {
    console.error("Failed to load worker dashboard:", err);
    const message = err instanceof Error ? err.message : "Failed to load dashboard.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * A worker must never be able to submit progress as another user —
 * workerId always comes from the verified session, never the request
 * body (a `workerId` field in the body, if a caller still sends one,
 * is ignored).
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
    const completedQuantity: unknown = body?.completedQuantity;
    const progressPercentage: unknown = body?.progressPercentage;
    const description: unknown = body?.description;

    if (workItemId !== undefined && workItemId !== null && typeof workItemId !== "string") {
      return NextResponse.json({ error: "workItemId must be a string." }, { status: 400 });
    }
    if (
      completedQuantity !== undefined &&
      completedQuantity !== null &&
      (typeof completedQuantity !== "number" ||
        Number.isNaN(completedQuantity) ||
        completedQuantity < 0)
    ) {
      return NextResponse.json(
        { error: "completedQuantity must be a non-negative number." },
        { status: 400 }
      );
    }
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
    if (typeof description !== "string" || !description.trim()) {
      return NextResponse.json({ error: "description is required." }, { status: 400 });
    }

    await submitWorkerProgress(supabase, {
      workerId: currentUser.userId,
      workItemId: typeof workItemId === "string" ? workItemId : undefined,
      completedQuantity: typeof completedQuantity === "number" ? completedQuantity : undefined,
      progressPercentage,
      description: description.trim(),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to submit progress:", err);
    const message = err instanceof Error ? err.message : "Failed to submit progress.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
