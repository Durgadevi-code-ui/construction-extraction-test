import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import {
  getCurrentWorkItemRecords,
  getForemanAssignmentBoard,
  getUserContext,
  listForemanQueue,
} from "@/lib/workflow";
import { requireCurrentUser } from "@/lib/session";
import { logout } from "@/app/login/actions";
import ForemanTabs from "@/components/workflow/ForemanTabs";
import NotificationBell from "@/components/workflow/NotificationBell";
import { calculateEstimatedAmount } from "@/lib/calculations";

export const dynamic = "force-dynamic";

function SignOutLink() {
  return (
    <form action={logout} className="inline">
      <button type="submit" className="text-sm text-brand hover:underline">
        Sign out
      </button>
    </form>
  );
}

/**
 * Subcontractor Dashboard — "work progress + payment/earnings"
 * (see project design brief's per-role reference). Order follows the
 * app's information hierarchy (overall result -> breakdown ->
 * actionable items -> details): KPI summary first, then the two
 * action queues (Worker Assignments the Subcontractor manages,
 * Pending Reviews they must act on), then Awaiting Contractor Review
 * for visibility only (no action available to them at that stage).
 */
export default async function ForemanPage() {
  const currentUser = await requireCurrentUser("/workflow/foreman");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();

  const ctx = await getUserContext(supabase, userId);
  if (ctx.role !== "FOREMAN") {
    redirect("/workflow");
  }

  const queue = await listForemanQueue(supabase, userId);
  const board = await getForemanAssignmentBoard(supabase, userId).catch(() => null);

  // Same underlying records the Contractor's own queue is built from
  // (getCurrentWorkItemRecords — see lib/workflow.ts listSupervisorQueue),
  // filtered to the one status a Subcontractor should see here: already
  // forwarded, not yet approved. No new query/calculation — this is the
  // Contractor's queue, reused read-only for visibility.
  const awaitingContractorReview = (
    await getCurrentWorkItemRecords(supabase, ctx.departmentId)
  ).filter((item) => item.reviewStatusCode === "AWAITING_SUPERVISOR_APPROVAL");

  // KPI summary — derived entirely from board.workItems (the same
  // listWorkItemsForDepartment data already loaded above), never a
  // second query, so these numbers can never disagree with the
  // work-item list rendered elsewhere on this page.
  const kpis = board
    ? (() => {
        const items = board.workItems;
        const completedCount = items.filter((w) => w.isCompleted).length;
        const totalEstimatedValue = items.reduce(
          (sum, w) => sum + (w.progressPercentage !== null && w.scheduledValue !== null
            ? calculateEstimatedAmount(w.scheduledValue, w.progressPercentage) ?? 0
            : 0),
          0
        );
        const avgProgress =
          items.length > 0
            ? Math.round(
                (items.reduce((sum, w) => sum + (w.progressPercentage ?? 0), 0) / items.length) * 10
              ) / 10
            : 0;
        return {
          totalWorkItems: items.length,
          completedCount,
          workLeftPercent: Math.max(0, Math.round((100 - avgProgress) * 10) / 10),
          overallProgressPercent: avgProgress,
          pendingReviews: queue.length,
          totalEstimatedValue,
        };
      })()
    : null;

  return (
    <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Subcontractor Dashboard</h1>
            <p className="text-sm text-foreground-secondary">
              My Department: <span className="font-medium text-foreground-secondary">{ctx.departmentName}</span>
            </p>
            <SignOutLink />
          </div>
          <NotificationBell userId={userId} />
        </div>

        <ForemanTabs
          foremanUserId={userId}
          kpis={kpis}
          board={
            board
              ? {
                  departmentName: board.departmentName,
                  workers: board.workers,
                  workItems: board.workItems.map((w) => ({
                    workItemId: w.workItemId,
                    code: w.code,
                    description: w.description,
                    plannedQuantity: w.plannedQuantity,
                    unitOfMeasure: w.unitOfMeasure,
                  })),
                  assignments: board.assignments,
                }
              : null
          }
          queue={queue}
          awaitingContractorReview={awaitingContractorReview.map((item) => ({
            submissionId: item.submissionId,
            workItemCode: item.workItemCode,
            workItemDescription: item.workItemDescription,
            workerName: item.workerName,
            correctedProgress: item.correctedProgress,
            submittedProgress: item.submittedProgress,
          }))}
        />
      </div>
    </main>
  );
}
