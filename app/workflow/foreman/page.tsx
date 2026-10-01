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
  getReviewFocusState,
} from "@/lib/workflow";
import { requireCurrentUser } from "@/lib/session";
import { projectSwitchOptions } from "@/lib/authContext";
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
  searchParams: Promise<{ projectId?: string; departmentId?: string; focus?: string }>;
}) {
  const currentUser = await requireCurrentUser("/workflow/foreman");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();

  // Project context (?projectId=), same mechanism as the Contractor page —
  // only selects among this user's own Active roles, falls back safely.
  // ?departmentId= (with ?projectId=) picks between departments held in
  // the SAME project, like the Worker and Contractor pages.
  const { projectId: projectIdParam, departmentId: departmentIdParam, focus: focusParam } = await searchParams;
  const ctx = await getUserContext(
    supabase,
    userId,
    projectIdParam ? { projectId: projectIdParam, departmentId: departmentIdParam } : undefined
  );
  if (ctx.role !== "FOREMAN") {
    redirect("/workflow");
  }
  const projectId = ctx.projectId;
  const departmentId = ctx.departmentId;
  // A notification's focused submission (?focus=), checked server-side
  // with the same authorization the review actions use — lets Reviews
  // say clearly when it was already handled, can't be found, or isn't
  // accessible, instead of just showing an unhighlighted queue.
  const reviewFocus = focusParam
    ? await getReviewFocusState(supabase, userId, focusParam, { projectId, departmentId, reviewer: "FOREMAN" })
    : null;
  // Current Project location (existing projects.project_location) —
  // display-only in the header, omitted when not set.
  const { data: projectRow } = await supabase
    .from("projects")
    .select("project_location")
    .eq("project_id", projectId)
    .maybeSingle();
  const projectLocation = (projectRow?.project_location as string | null) ?? null;
  // Options for the shared header Project dropdown (ProjectSelect) — one
  // per project + department this user holds an Active role in, across
  // all their roles (a project where they're e.g. Contractor opens that
  // role's page), so switching back is always possible. Only their own
  // role rows, never other projects — see projectSwitchOptions.
  const projectOptions = projectSwitchOptions(ctx.availableProjects);

  const queue = await listForemanQueue(supabase, userId, projectId, departmentId);
  // A failed board load leaves the rest of the page usable — the
  // Dashboard KPIs and Work Item Management then show an error with
  // Retry (see ForemanTabs) — and is logged here, never swallowed.
  const board = await getForemanAssignmentBoard(supabase, userId, projectId, departmentId).catch((err) => {
    console.error("Failed to load the Subcontractor assignment board:", err);
    return null;
  });
  const [history, displayName] = await Promise.all([
    getSubmissionHistory(supabase, userId, submissionHistoryBounds(), projectId, departmentId).then((rows) => withApproverNames(supabase, rows)),
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
          key={`${projectId}:${departmentId}`}
          foremanUserId={userId}
          userEmail={currentUser.email}
          profile={{ displayName, email: currentUser.email }}
          projectName={ctx.projectName}
          departmentName={ctx.departmentName}
          history={history}
          projectId={projectId}
          departmentId={departmentId}
          reviewFocus={reviewFocus}
          projectLocation={projectLocation}
          projectOptions={projectOptions}
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
                    // Shown in the shared Work Items list — the same
                    // progress/earned value the KPI cards above use.
                    progressPercentage: w.progressPercentage,
                    isCompleted: w.isCompleted,
                    earnedAmount: calculateEstimatedAmount(w.scheduledValue, w.progressPercentage),
                  })),
                  assignments: board.assignments,
                  inactiveWorkItems: board.inactiveWorkItems,
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
