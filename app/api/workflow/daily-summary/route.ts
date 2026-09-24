import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getExecutiveSummary, getUserContext, type ExecutiveSummaryPeriod } from "@/lib/workflow";
import { CONTRACTOR_ROLES } from "@/lib/authContext";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

const VALID_PERIODS: ExecutiveSummaryPeriod[] = ["daily", "weekly", "monthly"];

/**
 * Executive Summary — structured, computed-from-real-data KPIs (see
 * lib/workflow.ts getExecutiveSummary), replacing the old single AI-
 * generated paragraph: a CEO/PM should read this in a few seconds, not
 * parse prose. `period` (daily/weekly/monthly, default daily) selects
 * the date window; the calculation engine itself is the same one for
 * all three. Identity and scope come only from the verified session.
 */
export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const body = await request.json().catch(() => ({}));
    // Optional project context (Contractor with roles on several
    // projects) — only selects among the caller's own Active roles; the
    // role check below still applies to whichever role that resolves to.
    const projectId: string | undefined = typeof body?.projectId === "string" && body.projectId ? body.projectId : undefined;
    const ctx = await getUserContext(supabase, currentUser.userId, projectId ? { projectId } : undefined);
    if (![...CONTRACTOR_ROLES, "FOREMAN"].includes(ctx.role)) {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }

    const requestedPeriod: unknown = body?.period;
    const period: ExecutiveSummaryPeriod = VALID_PERIODS.includes(requestedPeriod as ExecutiveSummaryPeriod)
      ? (requestedPeriod as ExecutiveSummaryPeriod)
      : "daily";

    const summary = await getExecutiveSummary(supabase, currentUser.userId, period, ctx.projectId);
    return NextResponse.json({ summary });
  } catch (err) {
    console.error("Executive summary failed:", err);
    return NextResponse.json(
      { error: "Could not generate the summary right now. Please try again." },
      { status: 502 }
    );
  }
}
