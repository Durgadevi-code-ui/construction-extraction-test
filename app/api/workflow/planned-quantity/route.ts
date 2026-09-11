import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { updatePlannedQuantity } from "@/lib/workflow";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Simplified Planned Quantity editing (see lib/workflow.ts
 * updatePlannedQuantity): Admin, or the work item's own Subcontractor/
 * Contractor, can adjust it directly — no Admin approval needed for
 * this one routine field, per the mentor's simplification. Worker is
 * never authorized (enforced server-side in updatePlannedQuantity,
 * not just by this route existing outside the Worker UI).
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
    const workItemId: unknown = body?.workItemId;
    const plannedQuantity: unknown = body?.plannedQuantity;
    const unitOfMeasure: unknown = body?.unitOfMeasure;

    if (typeof workItemId !== "string" || !workItemId) {
      return NextResponse.json({ error: "workItemId is required." }, { status: 400 });
    }
    if (
      plannedQuantity !== null &&
      (typeof plannedQuantity !== "number" || Number.isNaN(plannedQuantity) || plannedQuantity < 0)
    ) {
      return NextResponse.json(
        { error: "plannedQuantity must be a non-negative number or null." },
        { status: 400 }
      );
    }
    if (unitOfMeasure !== undefined && unitOfMeasure !== null && typeof unitOfMeasure !== "string") {
      return NextResponse.json({ error: "unitOfMeasure must be a string." }, { status: 400 });
    }

    await updatePlannedQuantity(supabase, {
      actorUserId,
      workItemId,
      plannedQuantity,
      unitOfMeasure: unitOfMeasure === undefined ? undefined : unitOfMeasure,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to update planned quantity:", err);
    const message = err instanceof Error ? err.message : "Failed to update planned quantity.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
