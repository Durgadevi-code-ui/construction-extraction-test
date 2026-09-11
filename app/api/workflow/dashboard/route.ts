import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getDashboardData, type DashboardFilters } from "@/lib/dashboard";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

const VALID_STATUSES: DashboardFilters["status"][] = [
  "ALL",
  "COMPLETED",
  "IN_PROGRESS",
  "STUCK",
  "PENDING",
];

/**
 * Aggregate cross-department/cross-project Dashboard. Every filter
 * value is taken from the query string but re-verified server-side
 * against the caller's actual scope in lib/dashboard.ts
 * (resolveDashboardScope) — a projectId/departmentId outside what the
 * caller (server-verified session, never a request field) is
 * authorized for is silently ignored, never trusted to widen access
 * (see that module's doc for the full authorization rule, including
 * why a WORKER gets a 403 here).
 */
export async function GET(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const userId = currentUser.userId;

  const projectId = request.nextUrl.searchParams.get("projectId");
  const departmentId = request.nextUrl.searchParams.get("departmentId");
  const from = request.nextUrl.searchParams.get("from");
  const to = request.nextUrl.searchParams.get("to");
  const statusParam = request.nextUrl.searchParams.get("status");
  const status = VALID_STATUSES.includes(statusParam as DashboardFilters["status"])
    ? (statusParam as DashboardFilters["status"])
    : "ALL";

  try {
    const data = await getDashboardData(supabase, userId, {
      projectId,
      departmentId,
      from,
      to,
      status,
    });
    return NextResponse.json(data);
  } catch (err) {
    console.error("Failed to load dashboard:", err);
    const message = err instanceof Error ? err.message : "Failed to load dashboard.";
    const unauthorized = message.includes("not authorized");
    return NextResponse.json({ error: message }, { status: unauthorized ? 403 : 500 });
  }
}
