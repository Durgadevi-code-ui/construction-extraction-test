import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import { getSubmissionHistory, getUserContext } from "@/lib/workflow";
import { CONTRACTOR_ROLES } from "@/lib/authContext";
import { requireCurrentUser } from "@/lib/session";
import { formatDateUS } from "@/lib/format";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import { History } from "lucide-react";

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
          <Link href="/workflow/supervisor" className="text-sm text-brand transition-colors duration-150 hover:underline">
            Back to Dashboard
          </Link>
        </div>

        <Card className="!p-0 overflow-hidden">
          {items.length === 0 ? (
            <EmptyState icon={History} title="No older submissions found" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-soft text-[11px] uppercase tracking-wide text-foreground-muted">
                  <tr>
                    <th className="text-left px-5 py-2.5 font-medium">Date</th>
                    <th className="text-left px-5 py-2.5 font-medium">Worker</th>
                    <th className="text-left px-5 py-2.5 font-medium">Work Item</th>
                    <th className="text-right px-5 py-2.5 font-medium">Submitted</th>
                    <th className="text-left px-5 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {items.map((item) => (
                    <tr key={item.submissionId} className="transition-colors duration-150 hover:bg-surface-hover">
                      <td className="px-5 py-3 whitespace-nowrap text-foreground-secondary tabular-nums">
                        {formatDateUS(item.submittedAt)}
                      </td>
                      <td className="px-5 py-3">
                        <span className="font-medium">{item.workerName}</span>{" "}
                        <span className="text-foreground-muted">({item.departmentName})</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
                        {item.workItemDescription}
                      </td>
                      <td className="px-5 py-3 text-right font-medium tabular-nums whitespace-nowrap">
                        {item.submittedQuantity !== null
                          ? `${item.submittedQuantity} ${item.unit ?? ""}`.trim()
                          : `${item.submittedProgress}%`}
                      </td>
                      <td className="px-5 py-3">{item.reviewStatusLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
