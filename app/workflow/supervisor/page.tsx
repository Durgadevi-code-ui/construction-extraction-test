import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import {
  getMTDProgress,
  getTodaysProgress,
  getUserContext,
  getWorkSummary,
  getYesterdaysProgress,
  listSupervisorQueue,
  listWorkItemsForDepartment,
  getDelegatedAssignmentBoard,
  getDelegatedProgressReviewQueue,
} from "@/lib/workflow";
import { CONTRACTOR_ROLES } from "@/lib/authContext";
import { getActiveDelegationsForUser } from "@/lib/delegation";
import { listDepartments } from "@/lib/admin";
import { getDashboardData } from "@/lib/dashboard";
import { requireCurrentUser } from "@/lib/session";
import ContractorTabs from "@/components/workflow/ContractorTabs";
import { type DelegatedDepartmentScope } from "@/components/workflow/DelegatedAdminPanel";
import { formatDateUS } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SupervisorPage() {
  const currentUser = await requireCurrentUser("/workflow/supervisor");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();

  const ctx = await getUserContext(supabase, userId);
  if (!CONTRACTOR_ROLES.includes(ctx.role)) {
    redirect("/workflow");
  }

  const [queue, todaysProgress, yesterdaysProgress, mtdProgress, workSummary, activeDelegations, dashboardData] =
    await Promise.all([
      listSupervisorQueue(supabase, userId),
      getTodaysProgress(supabase, userId),
      getYesterdaysProgress(supabase, userId),
      getMTDProgress(supabase, userId),
      getWorkSummary(supabase, userId),
      // Best-effort: delegation is an optional add-on to this dashboard,
      // not something its core Progress/Review functionality depends
      // on — same tolerance as getForemanAssignmentBoard's .catch(() =>
      // null) below. Falls back to "no active delegations" rather than
      // failing the whole dashboard if the feature's own table/data
      // isn't reachable for any reason.
      getActiveDelegationsForUser(supabase, userId).catch(() => []),
      // Same cross-department aggregate view the standalone Dashboard
      // page already uses (see lib/dashboard.ts) — reused unchanged for
      // this page's own Department Progress / Work Items tabs (see
      // ContractorTabs), never a second/duplicated calculation.
      getDashboardData(supabase, userId, { status: "ALL" }),
    ]);

  // Build one DelegatedDepartmentScope per department actually covered
  // by an active delegation — for each project a delegation includes,
  // its own delegation_departments rows restrict to just those
  // departments; having none for that project (whole-project scope)
  // expands to every department in it. Never a single "all departments"
  // blob: each department's data stays independently fetched/scoped
  // exactly like a real single-department delegation would be. A
  // delegation covering several projects/departments contributes one
  // entry per (project, department) pair it actually grants.
  const allDepartments = activeDelegations.length > 0 ? await listDepartments(supabase) : [];

  const scopeDepartmentIds = new Map<
    string,
    { projectId: string; canManageWorkItems: boolean; canManageAssignments: boolean; canReviewProgress: boolean }
  >();
  for (const delegation of activeDelegations) {
    for (const project of delegation.projects) {
      const departmentsForProject = delegation.departments.filter((d) => d.projectId === project.projectId);
      const departmentIds =
        departmentsForProject.length > 0
          ? departmentsForProject.map((d) => d.departmentId)
          : allDepartments.filter((d) => d.projectId === project.projectId).map((d) => d.departmentId);

      for (const departmentId of departmentIds) {
        const existing = scopeDepartmentIds.get(departmentId) ?? {
          projectId: project.projectId,
          canManageWorkItems: false,
          canManageAssignments: false,
          canReviewProgress: false,
        };
        existing.canManageWorkItems ||= delegation.permissions.includes("WORK_ITEM_MANAGEMENT");
        existing.canManageAssignments ||= delegation.permissions.includes("WORKER_ASSIGNMENT");
        existing.canReviewProgress ||= delegation.permissions.includes("PROGRESS_REVIEW");
        scopeDepartmentIds.set(departmentId, existing);
      }
    }
  }

  const delegatedScopes: DelegatedDepartmentScope[] = await Promise.all(
    Array.from(scopeDepartmentIds.entries()).map(async ([departmentId, grant]) => {
      const workItemOptions = await listWorkItemsForDepartment(supabase, departmentId);
      const departmentName =
        allDepartments.find((d) => d.departmentId === departmentId)?.departmentName ?? "(unknown)";

      const board = grant.canManageAssignments
        ? await getDelegatedAssignmentBoard(supabase, {
            contractorUserId: userId,
            projectId: grant.projectId,
            departmentId,
          })
        : null;

      const reviewQueue = grant.canReviewProgress
        ? await getDelegatedProgressReviewQueue(supabase, {
            contractorUserId: userId,
            projectId: grant.projectId,
            departmentId,
          })
        : [];

      return {
        departmentId,
        departmentName,
        canManageWorkItems: grant.canManageWorkItems,
        canManageAssignments: grant.canManageAssignments,
        canReviewProgress: grant.canReviewProgress,
        workItems: workItemOptions.map((w) => ({
          workItemId: w.workItemId,
          code: w.code,
          description: w.description,
          scheduledValue: w.scheduledValue,
          plannedQuantity: w.plannedQuantity,
          unitOfMeasure: w.unitOfMeasure,
        })),
        assignmentWorkers: board?.workers ?? [],
        assignmentWorkItems:
          board?.workItems.map((w) => ({
            workItemId: w.workItemId,
            code: w.code,
            description: w.description,
            plannedQuantity: w.plannedQuantity,
            unitOfMeasure: w.unitOfMeasure,
          })) ?? [],
        assignments: board?.assignments ?? [],
        progressReviewQueue: reviewQueue.map((q) => ({
          submissionId: q.submissionId,
          workerName: q.workerName,
          workItemCode: q.workItemCode,
          workItemDescription: q.workItemDescription,
          submittedProgress: q.submittedProgress,
          description: q.description,
          validationId: q.validationId,
          correctedProgress: q.correctedProgress,
          approvalStatus: q.approvalStatus,
          scheduledValue: q.scheduledValue,
          estimatedAmount: q.estimatedAmount,
          isCompleted: q.isCompleted,
        })),
      };
    })
  );

  return (
    <main className="flex-1 flex flex-col space-y-6">
        {activeDelegations.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
            <p className="font-medium">Active delegated Admin access:</p>
            {activeDelegations.map((d) => (
              <p key={d.delegationId}>
                {d.permissions.join(", ")} —{" "}
                {d.projects.map((p) => p.projectName).join(", ")}
                {d.departments.length > 0
                  ? ` / ${d.departments.map((dep) => dep.departmentName).join(", ")}`
                  : " (whole project)"}{" "}
                — until {formatDateUS(d.endsAt)}
              </p>
            ))}
          </div>
        )}

        <ContractorTabs
          userId={userId}
          dashboardData={dashboardData}
          queue={queue}
          todaysProgress={todaysProgress}
          yesterdaysProgress={yesterdaysProgress}
          mtdProgress={mtdProgress}
          workSummary={workSummary}
          delegatedScopes={delegatedScopes}
        />
    </main>
  );
}
