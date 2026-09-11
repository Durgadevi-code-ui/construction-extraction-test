import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { bootstrapAdminUser } from "@/lib/admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const email: unknown = body?.email;
    const departmentId: unknown = body?.departmentId;

    if (typeof email !== "string" || !email.trim()) {
      return NextResponse.json({ error: "email is required." }, { status: 400 });
    }
    if (typeof departmentId !== "string" || !departmentId) {
      return NextResponse.json({ error: "departmentId is required." }, { status: 400 });
    }

    const userId = await bootstrapAdminUser(supabase, { email: email.trim(), departmentId });
    return NextResponse.json({ ok: true, userId });
  } catch (err) {
    console.error("Failed to bootstrap admin user:", err);
    const message = err instanceof Error ? err.message : "Failed to create admin user.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
