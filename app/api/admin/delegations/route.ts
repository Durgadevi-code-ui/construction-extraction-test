import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import {
  createDelegation,
  listDelegations,
  revokeDelegation,
  DELEGATION_PERMISSIONS,
  type DelegationPermission,
} from "@/lib/delegation";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Delegation management (create/list/revoke) is Admin-only and never
 * itself delegable — granting the ability to grant delegations would
 * be a privilege-escalation path. Every handler below still calls
 * createDelegation/listDelegations/revokeDelegation, which each
 * independently re-verify isAdminUser server-side (unchanged) — the
 * adminUserId they check is now always the caller's own verified
 * session, never a request field, so a non-Admin can no longer even
 * attempt this by claiming a different (Admin) id.
 */
export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const delegations = await listDelegations(supabase, currentUser.userId);
    return NextResponse.json({ delegations });
  } catch (err) {
    console.error("Failed to load delegations:", err);
    const message = err instanceof Error ? err.message : "Failed to load delegations.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function toPermissionArray(value: unknown): DelegationPermission[] | null {
  if (!Array.isArray(value)) return null;
  const permissions = value.filter(
    (v): v is DelegationPermission =>
      typeof v === "string" && (DELEGATION_PERMISSIONS as string[]).includes(v)
  );
  return permissions;
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "string" && v)) return null;
  return value as string[];
}

export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const delegateUserId: unknown = body?.delegateUserId;
    const projectIds = toStringArray(body?.projectIds);
    const departmentIds = toStringArray(body?.departmentIds) ?? [];
    const permissions = toPermissionArray(body?.permissions);
    const startsAt: unknown = body?.startsAt;
    const endsAt: unknown = body?.endsAt;
    const reason: unknown = body?.reason;

    if (typeof delegateUserId !== "string" || !delegateUserId) {
      return NextResponse.json({ error: "delegateUserId is required." }, { status: 400 });
    }
    if (!projectIds || projectIds.length === 0) {
      return NextResponse.json({ error: "At least one project must be selected." }, { status: 400 });
    }
    if (!permissions || permissions.length === 0) {
      return NextResponse.json(
        { error: `permissions must include at least one of: ${DELEGATION_PERMISSIONS.join(", ")}.` },
        { status: 400 }
      );
    }
    if (typeof startsAt !== "string" || typeof endsAt !== "string") {
      return NextResponse.json({ error: "startsAt and endsAt are required." }, { status: 400 });
    }

    await createDelegation(supabase, {
      adminUserId: currentUser.userId,
      delegateUserId,
      projectIds,
      departmentIds,
      permissions,
      startsAt,
      endsAt,
      reason: typeof reason === "string" ? reason : null,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to create delegation:", err);
    const message = err instanceof Error ? err.message : "Failed to create delegation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const delegationId: unknown = body?.delegationId;

    if (typeof delegationId !== "string" || !delegationId) {
      return NextResponse.json({ error: "delegationId is required." }, { status: 400 });
    }

    await revokeDelegation(supabase, { adminUserId: currentUser.userId, delegationId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to revoke delegation:", err);
    const message = err instanceof Error ? err.message : "Failed to revoke delegation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
