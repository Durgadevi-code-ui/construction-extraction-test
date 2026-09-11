import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import { getSubmissionHistory, getUserContext } from "@/lib/workflow";
import { CONTRACTOR_ROLES } from "@/lib/authContext";
import { requireCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Contractor's "View History" destination — older/previous submissions,
 * separate from Today's/Yesterday's on the main dashboard (see
 * SupervisorPanel). Reuses getSubmissionHistory (same department-scoped
 * query as Today's/Yesterday's, just a wider date range), so this is a
 * read-only view — no workflow, calculation, or permission changes.
 */
export default async function SupervisorHistoryPage() {
  const currentUser = await requireCurrentUser("/workflow/supervisor/history");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();

  const ctx = await getUserContext(supabase, userId);
  if (!CONTRACTOR_ROLES.includes(ctx.role)) {
    redirect("/workflow");
  }

  // Everything before yesterday (Today's/Yesterday's already have their
  // own sections on the dashboard) back to a year ago, which comfortably
  // covers this project's full history.
  const to = isoDateOffset(-2);
  const from = isoDateOffset(-365);
  const items = await getSubmissionHistory(supabase, userId, { from, to });

  return (
    <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Submission History</h1>
          <Link href="/workflow/supervisor" className="text-sm text-brand hover:underline">
            Back to Dashboard
          </Link>
        </div>

        <section className="bg-white rounded-lg border border-line p-4 space-y-3 text-sm">
          {items.length === 0 ? (
            <p className="text-foreground-muted">No older submissions found.</p>
          ) : (
            <div className="space-y-3">
              {items.map((item) => (
                <div
                  key={item.submissionId}
                  className="border border-line rounded p-2 space-y-0.5"
                >
                  <p>
                    <span className="text-foreground-secondary">Worker:</span>{" "}
                    <span className="font-medium">{item.workerName}</span>{" "}
                    <span className="text-foreground-muted">({item.departmentName})</span>
                  </p>
                  <p>
                    <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
                    <span>{item.workItemDescription}</span>
                  </p>
                  <p>
                    <span className="text-foreground-secondary">Submitted:</span>{" "}
                    <span className="font-medium">
                      {item.submittedQuantity !== null
                        ? `${item.submittedQuantity} ${item.unit ?? ""}`.trim()
                        : `${item.submittedProgress}%`}
                    </span>
                  </p>
                  <p>
                    <span className="text-foreground-secondary">Status:</span>{" "}
                    <span className="font-medium">{item.reviewStatusLabel}</span>
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
