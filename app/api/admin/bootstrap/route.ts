import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/apiErrors";
import { getSupabaseClient } from "@/lib/supabase";
import { bootstrapAdminUser } from "@/lib/admin";
import { RATE_LIMITS, clientIp, rateLimitResponse } from "@/lib/rateLimit";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Unauthenticated by necessity (no Admin exists yet), so capped per
  // client IP (lib/rateLimit.ts).
  const limited = await rateLimitResponse(RATE_LIMITS.bootstrap, clientIp(request.headers));
  if (limited) return limited;

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
    return jsonError(message, 500);
  }
}
