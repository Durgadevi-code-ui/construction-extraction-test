import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { createCompany } from "@/lib/admin";
import { assertAdminRole } from "@/lib/delegation";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

/**
 * Company management is intentionally never delegable (see
 * supabase/migrations/00000000000009_delegation_admin_permissions.sql
 * module doc): a Company is the root of this schema's hierarchy —
 * projects belong to a company, not the reverse — and this app's
 * delegation scope is project/department-based, which gives no safe
 * way to bound "which companies" a delegate could touch. Strict
 * assertAdminRole, unchanged.
 */
export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const actorUserId = currentUser.userId;

  try {
    const body = await request.json();
    const name: unknown = body?.name;
    const code: unknown = body?.code;
    const address: unknown = body?.address;

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required." }, { status: 400 });
    }
    if (typeof code !== "string" || !code.trim()) {
      return NextResponse.json({ error: "code is required." }, { status: 400 });
    }

    await assertAdminRole(supabase, actorUserId);

    await createCompany(supabase, {
      name: name.trim(),
      code: code.trim(),
      address: typeof address === "string" && address.trim() ? address.trim() : null,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to create company:", err);
    const message = err instanceof Error ? err.message : "Failed to create company.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
