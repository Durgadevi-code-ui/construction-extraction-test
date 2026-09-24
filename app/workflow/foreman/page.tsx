import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import {
  getCurrentWorkItemRecords,
  getForemanAssignmentBoard,
  getSubmissionHistory,
  withApproverNames,
  getUserContext,
  getUserDisplayName,
  listForemanQueue,
} from "@/lib/workflow";
import { requireCurrentUser } from "@/lib/session";
import ForemanTabs from "@/components/workflow/ForemanTabs";
import { submissionHistoryBounds } from "@/components/workflow/SubmissionHistoryTable";
import { calculateEstimatedAmount, calculateOverallProgress } from "@/lib/calculations";

export const dynamic = "force-dynamic";

/**
 * Subcontractor Dashboard — "work progress + payment/earnings"
 * (see project design brief's per-role reference). Order follows the
 * app's information hierarchy (overall result -> breakdown ->
 * actionable items -> details): KPI summary first, then the two
 * action queues (Worker Assignments the Subcontractor manages,
 * Pending Reviews they must act on), then Awaiting Contractor Review
 * for visibility only (no action available to them at that stage).
 */
export default async function ForemanPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const currentUser = await requireCurrentUser("/workflow/foreman");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();

  // Project context (?projectId=), same mechanism as the Contractor page —
  // only selects among this user's own Active roles, falls back safely.
  const { projectId: projectIdParam } = await searchParams;
  const ctx = await getUserContext(supabase, userId, projectIdParam ? { projectId: projectIdParam } : undefined);
  if (ctx.role !== "FOREMAN") {
    redirect("/workflow");
  }
  const projectId = ctx.projectId;
  // Current Project location (existing projects.project_location) —
  // display-only in the header, omitted when not set.
  const { data: projectRow } = await supabase
    .from("projects")
    .select("project_location")
    .eq("project_id", projectId)
    .maybeSingle();
  const projectLocation = (projectRow?.project_location as string | null) ?? null;
  const ownProjects = [
    ...new Map(ctx.availableProjects.filter((p) => p.role === "FOREMAN").map((p) => [p.projectId, p])).values(),
  ];
  const projectSwitcher =
    ownProjects.length > 1 ? (
      <div className="flex items-center gap-1 flex-wrap min-w-0 max-w-full">
        {ownProjects.map((p) => (
          <Link
            key={p.projectId}
            href={`/workflow/foreman?projectId=${p.projectId}`}
            className={
              p.projectId === projectId
                ? "rounded-lg bg-brand-soft px-2.5 py-1.5 text-xs font-semibold text-brand max-w-full truncate"
                : "rounded-lg px-2.5 py-1.5 text-xs font-medium text-foreground-secondary border border-line transition-colors duration-150 hover:bg-surface-hover hover:text-foreground max-w-full truncate"
            }
            title={`${p.projectName} — ${p.departmentName}`}
          >
            {p.projectName}
          </Link>
        ))}
      </div>
    ) : null;

  const queue = await listForemanQueue(supabase, userId, projectId);
  const board = await getForemanAssignmentBoard(supabase, userId, projectId).catch(() => null);
  const [history, displayName] = await Promise.all([
    getSubmissionHistory(supabase, userId, submissionHistoryBounds(), projectId).then((rows) => withApproverNames(supabase, rows)),
    getUserDisplayName(supabase, userId),
  ]);

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
        const avgProgress = calculateOverallProgress(items.map((w) => w.progressPercentage)) ?? 0;
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
    <main className="flex-1 flex flex-col">
      {/* key: remount on project switch — see ContractorTabs in the
          Contractor page (no state carried across projects). */}
      <ForemanTabs
          key={projectId}
          foremanUserId={userId}
          userEmail={currentUser.email}
          profile={{ displayName, email: currentUser.email }}
          projectName={ctx.projectName}
          departmentName={ctx.departmentName}
          history={history}
          projectId={projectId}
          projectLocation={projectLocation}
          projectSwitcher={projectSwitcher}
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
                    // Every task, Active and Inactive — this is the
                    // Subcontractor's own task management view (see
                    // WorkItemTaskManager), unlike the Worker Dashboard
                    // which only ever sees Active tasks.
                    tasks: w.tasks,
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
    </main>
  );
}
