import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import {
  getMTDProgress,
  getSubmissionHistory,
  withApproverNames,
  getTodaysProgress,
  getUserContext,
  getUserDisplayName,
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
import { submissionHistoryBounds } from "@/components/workflow/SubmissionHistoryTable";
import { type DelegatedDepartmentScope } from "@/components/workflow/DelegatedAdminPanel";
import { formatDateUS } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SupervisorPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const currentUser = await requireCurrentUser("/workflow/supervisor");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();

  // Project context: ?projectId= for a Contractor holding roles on more
  // than one project (same mechanism as the Worker page). getUserContext
  // only ever picks among this user's own Active roles and falls back to
  // the first — a stale/tampered id can't widen anything. Every section
  // below is then scoped to ctx.projectId.
  const { projectId: projectIdParam } = await searchParams;
  const ctx = await getUserContext(supabase, userId, projectIdParam ? { projectId: projectIdParam } : undefined);
  if (!CONTRACTOR_ROLES.includes(ctx.role)) {
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
  const contractorProjects = [
    ...new Map(
      ctx.availableProjects.filter((p) => CONTRACTOR_ROLES.includes(p.role)).map((p) => [p.projectId, p])
    ).values(),
  ];
  const projectSwitcher =
    contractorProjects.length > 1 ? (
      <div className="flex items-center gap-1 flex-wrap min-w-0 max-w-full">
        {contractorProjects.map((p) => (
          <Link
            key={p.projectId}
            href={`/workflow/supervisor?projectId=${p.projectId}`}
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

  const [queue, todaysProgress, yesterdaysProgress, mtdProgress, workSummary, activeDelegations, dashboardData, history, displayName] =
    await Promise.all([
      listSupervisorQueue(supabase, userId, projectId),
      getTodaysProgress(supabase, userId, projectId),
      getYesterdaysProgress(supabase, userId, projectId),
      getMTDProgress(supabase, userId, projectId),
      getWorkSummary(supabase, userId, projectId),
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
      // Scoped to the selected project on the server, not only in the UI.
      getDashboardData(supabase, userId, { status: "ALL", projectId }),
      getSubmissionHistory(supabase, userId, submissionHistoryBounds(), projectId).then((rows) => withApproverNames(supabase, rows)),
      getUserDisplayName(supabase, userId),
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
          <div className="bg-warning-soft border border-warning-border rounded-lg p-3 text-xs text-warning space-y-1">
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

        {/* key: a project switch (client-side Link navigation to this same
            route) remounts the tabs, so no component keeps the previous
            project's state (filters, loaded summary). */}
        <ContractorTabs
          key={projectId}
          userId={userId}
          userEmail={currentUser.email}
          profile={{ displayName, email: currentUser.email }}
          projectName={ctx.projectName}
          departmentName={ctx.departmentName}
          history={history}
          projectId={projectId}
          projectLocation={projectLocation}
          projectSwitcher={projectSwitcher}
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
