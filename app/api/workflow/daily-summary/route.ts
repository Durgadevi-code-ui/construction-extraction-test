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
    const ctx = await getUserContext(supabase, currentUser.userId);
    if (![...CONTRACTOR_ROLES, "FOREMAN"].includes(ctx.role)) {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const requestedPeriod: unknown = body?.period;
    const period: ExecutiveSummaryPeriod = VALID_PERIODS.includes(requestedPeriod as ExecutiveSummaryPeriod)
      ? (requestedPeriod as ExecutiveSummaryPeriod)
      : "daily";

    const summary = await getExecutiveSummary(supabase, currentUser.userId, period);
    return NextResponse.json({ summary });
  } catch (err) {
    console.error("Executive summary failed:", err);
    return NextResponse.json(
      { error: "Could not generate the summary right now. Please try again." },
      { status: 502 }
    );
  }
}
