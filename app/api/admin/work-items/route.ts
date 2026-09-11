import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { createWorkItem, updateWorkItemValues } from "@/lib/admin";
import { assertAdminOrDelegated } from "@/lib/delegation";
import { getCurrentUser } from "@/lib/session";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/** department_id -> project_id — the scope a WORK_ITEM_MANAGEMENT
 * delegation is checked against (see assertAdminOrDelegated). */
async function getDepartmentProjectId(
  supabase: SupabaseClient,
  departmentId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("departments")
    .select("project_id")
    .eq("department_id", departmentId)
    .single();
  if (error || !data) {
    throw new Error(`Department not found: ${error?.message ?? departmentId}`);
  }
  return data.project_id as string;
}

/** work_item_id -> {project_id, department_id} — same purpose as
 * getDepartmentProjectId, for PATCH where only workItemId is given. */
async function getWorkItemScope(
  supabase: SupabaseClient,
  workItemId: string
): Promise<{ projectId: string; departmentId: string }> {
  const { data, error } = await supabase
    .from("work_items")
    .select("project_id, department_id")
    .eq("work_item_id", workItemId)
    .single();
  if (error || !data) {
    throw new Error(`Work item not found: ${error?.message ?? workItemId}`);
  }
  return { projectId: data.project_id as string, departmentId: data.department_id as string };
}

function toNullableNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const actorUserId = currentUser.userId;

  try {
    const body = await request.json();
    const departmentId: unknown = body?.departmentId;
    const lineItemNo: unknown = body?.lineItemNo;
    const descriptionOfWork: unknown = body?.descriptionOfWork;

    if (typeof departmentId !== "string" || !departmentId) {
      return NextResponse.json({ error: "departmentId is required." }, { status: 400 });
    }
    if (typeof lineItemNo !== "string" || !lineItemNo.trim()) {
      return NextResponse.json({ error: "lineItemNo is required." }, { status: 400 });
    }
    if (typeof descriptionOfWork !== "string" || !descriptionOfWork.trim()) {
      return NextResponse.json({ error: "descriptionOfWork is required." }, { status: 400 });
    }

    const projectId = await getDepartmentProjectId(supabase, departmentId);
    await assertAdminOrDelegated(supabase, {
      actorUserId,
      permission: "WORK_ITEM_MANAGEMENT",
      projectId,
      departmentId,
    });

    await createWorkItem(supabase, {
      departmentId,
      lineItemNo: lineItemNo.trim(),
      csiLineCode: typeof body?.csiLineCode === "string" ? body.csiLineCode.trim() : null,
      descriptionOfWork: descriptionOfWork.trim(),
      scheduledValue: toNullableNumber(body?.scheduledValue) ?? null,
      unitOfMeasure: typeof body?.unitOfMeasure === "string" ? body.unitOfMeasure.trim() : null,
      plannedQuantity: toNullableNumber(body?.plannedQuantity) ?? null,
      retainagePercent: toNullableNumber(body?.retainagePercent) ?? null,
      dependsOnWorkItemIds: toStringArray(body?.dependsOnWorkItemIds) ?? [],
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to create work item:", err);
    const message = err instanceof Error ? err.message : "Failed to create work item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

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

    if (typeof workItemId !== "string" || !workItemId) {
      return NextResponse.json({ error: "workItemId is required." }, { status: 400 });
    }

    const scope = await getWorkItemScope(supabase, workItemId);
    await assertAdminOrDelegated(supabase, {
      actorUserId,
      permission: "WORK_ITEM_MANAGEMENT",
      projectId: scope.projectId,
      departmentId: scope.departmentId,
    });

    const scheduledValue = toNullableNumber(body?.scheduledValue);
    const plannedQuantity = toNullableNumber(body?.plannedQuantity);
    const retainagePercent = toNullableNumber(body?.retainagePercent);
    const dependsOnWorkItemIds = toStringArray(body?.dependsOnWorkItemIds);

    await updateWorkItemValues(supabase, workItemId, {
      ...(scheduledValue !== undefined ? { scheduledValue } : {}),
      ...(plannedQuantity !== undefined ? { plannedQuantity } : {}),
      ...(retainagePercent !== undefined ? { retainagePercent } : {}),
      ...(typeof body?.unitOfMeasure === "string"
        ? { unitOfMeasure: body.unitOfMeasure.trim() || null }
        : {}),
      ...(typeof body?.csiLineCode === "string"
        ? { csiLineCode: body.csiLineCode.trim() || null }
        : {}),
      ...(dependsOnWorkItemIds !== undefined ? { dependsOnWorkItemIds } : {}),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to update work item:", err);
    const message = err instanceof Error ? err.message : "Failed to update work item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
