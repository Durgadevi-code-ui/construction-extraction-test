import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import {
  getUserContext,
  getWorkerApprovedWork,
  getWorkerDashboard,
  getWorkerSubmissionHistory,
  listAssignedWorkItemsForWorker,
  suggestNextWorkItem,
} from "@/lib/workflow";
import { getProjectTaskContextEnabled } from "@/lib/admin";
import { requireCurrentUser } from "@/lib/session";
import { formatUserDisplayName } from "@/lib/format";
import { logout } from "@/app/login/actions";
import WorkerTabs from "@/components/workflow/WorkerTabs";
import ProjectSelect from "@/components/workflow/ProjectSelect";

export const dynamic = "force-dynamic";

function SignOutLink() {
  return (
    <form action={logout} className="inline">
      <button type="submit" className="text-sm text-foreground-muted hover:text-foreground hover:underline">
        Sign out
      </button>
    </form>
  );
}

export default async function WorkerPage({
  searchParams,
}: {
  searchParams: Promise<{ workItemId?: string; projectId?: string; departmentId?: string }>;
}) {
  const currentUser = await requireCurrentUser("/workflow/worker");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();
  const {
    workItemId: workItemIdParam,
    projectId: projectIdParam,
    departmentId: departmentIdParam,
  } = await searchParams;

  // A worker with more than one active project assignment can switch
  // via ?projectId=; omitted (the common case), this behaves exactly as
  // before — the first (only) active assignment (see getUserContext).
  // ?departmentId= (with ?projectId=) picks between two departments the
  // worker holds in the SAME project; like projectId it only selects
  // among this worker's own Active roles and falls back safely.
  // A work item picked without an explicit department (the work item /
  // project selectors only carry projectId + workItemId) opens in that
  // work item's own project/department — otherwise a worker with two
  // departments in one project would land on the other department's list.
  let contextProjectId = projectIdParam;
  let contextDepartmentId = departmentIdParam;
  if (workItemIdParam && !departmentIdParam) {
    const { data: workItemScope } = await supabase
      .from("work_items")
      .select("project_id, department_id")
      .eq("work_item_id", workItemIdParam)
      .maybeSingle();
    if (workItemScope && (!projectIdParam || workItemScope.project_id === projectIdParam)) {
      contextProjectId = workItemScope.project_id as string;
      contextDepartmentId = workItemScope.department_id as string;
    }
  }
  const ctx = await getUserContext(supabase, userId, {
    projectId: contextProjectId,
    departmentId: contextDepartmentId,
  });
  // A logged-in Contractor/Subcontractor navigating straight to this
  // URL should see their own dashboard, not a Worker's — redirect to
  // the role router rather than rendering data that isn't theirs.
  if (ctx.role !== "WORKER") {
    redirect("/workflow");
  }

  // One entry per role the worker holds (project + department) — a second
  // department in the same project is its own entry, labelled with the
  // department so the two are distinguishable.
  const workerRoles = ctx.availableProjects.filter((p) => p.role === "WORKER");
  // With more than one Worker role, History follows the selected
  // project/department (server-side filter); a single-role worker keeps
  // seeing all of their own submissions exactly as before.
  const historyScope =
    workerRoles.length > 1 ? { projectId: ctx.projectId, departmentId: ctx.departmentId } : undefined;
  // The shared header Project control (same ProjectSelect as the
  // Contractor/Subcontractor pages) — one option per Worker role, each
  // opening ?projectId=&departmentId= (resolved by getUserContext among
  // this worker's own roles only); read-only with a single project.
  const projectSwitcher = (
    <ProjectSelect
      basePath="/workflow/worker"
      options={workerRoles.map((p) => ({
        projectId: p.projectId,
        projectName: p.projectName,
        departmentId: p.departmentId,
        departmentName: p.departmentName,
      }))}
      projectId={ctx.projectId}
      departmentId={ctx.departmentId}
    />
  );

  const workItems = await listAssignedWorkItemsForWorker(supabase, userId, ctx.departmentId);

  // The worker's own users row, for the Profile tab only — same table/
  // columns getUserDisplayName (lib/workflow.ts) already reads; never
  // anyone else's record, never role/admin fields beyond what's shown.
  const { data: userRow } = await supabase
    .from("users")
    .select("first_name, last_name, user_mail")
    .eq("user_id", userId)
    .maybeSingle();
  const profile = {
    displayName: formatUserDisplayName({
      firstName: userRow?.first_name ?? null,
      lastName: userRow?.last_name ?? null,
      email: userRow?.user_mail ?? currentUser.email,
    }),
    email: userRow?.user_mail ?? currentUser.email,
  };
  // Current Project location — existing projects.project_location (set in
  // Admin → Projects), display-only; omitted when not set.
  const { data: projectRow } = await supabase
    .from("projects")
    .select("project_location")
    .eq("project_id", ctx.projectId)
    .maybeSingle();
  const projectLocation = (projectRow?.project_location as string | null) ?? null;

  // No Active assignment in this project/department: still the normal
  // Worker screen (History, Profile, Communication and Sign out stay
  // reachable — past submissions don't disappear just because an
  // assignment was removed), with an empty state instead of the
  // current-work panels.
  if (workItems.length === 0) {
    const [history, approvedWork] = await Promise.all([
      getWorkerSubmissionHistory(supabase, userId, historyScope),
      getWorkerApprovedWork(supabase, userId, historyScope),
    ]);
    return (
      <main className="flex-1 flex flex-col">
        <WorkerTabs
          workerId={userId}
          userEmail={currentUser.email}
          profile={profile}
          projectLocation={projectLocation}
          projectName={ctx.projectName}
          departmentName={ctx.departmentName}
          current={null}
          workItems={[]}
          history={history}
          approvedWork={approvedWork}
          projectSwitcher={projectSwitcher}
          activeProjectId={ctx.projectId}
          taskContextEnabled={false}
        />
      </main>
    );
  }

  // A workItemId in the URL that isn't one of this worker's own assigned
  // work items (wrong department, unassigned, or someone else's) is
  // denied here rather than passed through to getWorkerDashboard —
  // resolveWorkItemForWorker would reject it too, but checking against
  // the list already loaded for this page avoids a second round trip
  // and lets this page show a clean message instead of an error page.
  if (workItemIdParam && !workItems.some((w) => w.workItemId === workItemIdParam)) {
    return (
      <main className="min-h-screen py-10 px-4">
        <div className="max-w-[1600px] mx-auto space-y-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Worker Dashboard</h1>
            <SignOutLink />
          </div>
          <p className="text-sm text-foreground-secondary">
            That work item is not assigned to you.{" "}
            <Link href="/workflow/worker" className="text-brand hover:underline">
              Back to your work items
            </Link>
            .
          </p>
        </div>
      </main>
    );
  }

  // Default: the first currently-eligible work item (not completed, and
  // every configured prerequisite — if any — already complete; see
  // work_item_dependencies / suggestNextWorkItem), falling back to the
  // old "first incomplete in line_item_no order" when nothing is
  // eligible yet (e.g. everything remaining is waiting on a
  // prerequisite) or every item is complete. The worker can always
  // override via the dropdown.
  const eligibleWorkItems = suggestNextWorkItem(workItems);
  const firstIncomplete = workItems.find((w) => !w.isCompleted);
  const defaultWorkItem = eligibleWorkItems[0] ?? firstIncomplete ?? workItems[workItems.length - 1];
  const activeWorkItemId = workItemIdParam ?? defaultWorkItem.workItemId;
  const isAutoSuggested = !workItemIdParam;

  const activeWorkItem =
    workItems.find((w) => w.workItemId === activeWorkItemId) ?? defaultWorkItem;

  const [dashboard, history, approvedWork, taskContextEnabled] = await Promise.all([
    getWorkerDashboard(supabase, userId, activeWorkItemId),
    getWorkerSubmissionHistory(supabase, userId, historyScope),
    getWorkerApprovedWork(supabase, userId, historyScope),
    getProjectTaskContextEnabled(supabase, ctx.projectId),
  ]);

  // Sum of as-submitted quantity across every one of this worker's own
  // submissions for the ACTIVE work item (approved or still pending
  // review) — reused from `history` above (already fetched, already
  // scoped to this worker) rather than a new query. Null in
  // percentage-only legacy mode (no planned_quantity), same convention
  // as dashboard.overallApprovedQuantity, so "Submitted/Estimated" and
  // "Approved/Completed" on the Worker Dashboard stay consistent about
  // when a quantity figure is meaningful at all.
  const submittedQuantity =
    dashboard.workItem.plannedQuantity !== null
      ? history
          .filter((item) => item.workItemCode === dashboard.workItem.code)
          .reduce((sum, item) => sum + (item.submittedQuantity ?? 0), 0)
      : null;
  // The Worker-side submission the "Submitted / Estimated" card shows for
  // the same active work item — kept separate from approved progress
  // (dashboard.overallProgress, Contractor-approved only): this worker's
  // MOST RECENT submission of the work item, whatever its review state
  // (pending included), with that state so the card can say Pending
  // approval / Approved / Returned for correction. `history` is already
  // newest-first. Null only when they haven't submitted it yet.
  const shownSubmission = history.find((item) => item.workItemCode === dashboard.workItem.code);
  const latestSubmission = shownSubmission
    ? {
        submittedProgress: shownSubmission.submittedProgress,
        correctedProgress: shownSubmission.correctedProgress,
        reviewStatusCode: shownSubmission.reviewStatusCode,
      }
    : null;

  const suggestionNote = (() => {
    if (!isAutoSuggested) return null;
    const dependencyCodes = activeWorkItem.dependsOnWorkItemIds
      .map((id) => workItems.find((w) => w.workItemId === id)?.code)
      .filter((code): code is string => !!code);
    const otherEligibleCount = eligibleWorkItems.filter(
      (w) => w.workItemId !== activeWorkItemId
    ).length;
    const otherEligibleNote =
      otherEligibleCount > 0
        ? ` ${otherEligibleCount} other work item${
            otherEligibleCount === 1 ? "" : "s"
          } ${otherEligibleCount === 1 ? "is" : "are"} also ready — pick from the dropdown if needed.`
        : " Pick a different one above if needed.";

    if (dependencyCodes.length > 0) {
      return `Automatically suggested — prerequisite${
        dependencyCodes.length === 1 ? "" : "s"
      } ${dependencyCodes.join(", ")} ${
        dependencyCodes.length === 1 ? "is" : "are"
      } complete.${otherEligibleNote}`;
    }
    return `Default work item.${otherEligibleNote}`;
  })();

  const noEligibleWorkNote =
    dashboard.isCompleted && eligibleWorkItems.length === 0
      ? `This work item is complete and no other work item in ${dashboard.departmentName} is currently eligible (either none remain, or the rest are waiting on other prerequisites).`
      : null;

  return (
    <main className="flex-1 flex flex-col">
      <WorkerTabs
        workerId={userId}
        userEmail={currentUser.email}
        profile={profile}
        projectLocation={projectLocation}
        projectName={dashboard.projectName}
        departmentName={dashboard.departmentName}
        current={{
          activeWorkItem: dashboard.workItem,
          activeWorkItemId,
          isAutoSuggested,
          suggestionNote,
          noEligibleWorkNote,
          submittedQuantity,
          latestSubmission,
          approvedQuantity: dashboard.overallApprovedQuantity,
          progressPercentage: dashboard.overallProgress,
          isCompleted: dashboard.isCompleted,
          todaysProgress: dashboard.todaysProgress,
          latestSubmissionStatusLabel: dashboard.latestSubmissionStatusLabel,
          latestSubmissionStatusCode: dashboard.latestSubmissionStatusCode,
        }}
        workItems={workItems.map((w) => ({
          workItemId: w.workItemId,
          code: w.code,
          description: w.description,
          isCompleted: w.isCompleted,
          isEligible: w.isEligible,
          // Same cumulative approved progress the rest of the app shows
          // (WorkItemOption.progressPercentage, getWorkItemCurrentStatus).
          progressPercentage: w.progressPercentage,
          // Only Active tasks are offered to a Worker — a Contractor/
          // Subcontractor-deactivated task (see
          // lib/workflow.ts WorkItemTask.status) is never shown here,
          // even though the Contractor/Subcontractor management view
          // still lists it (to allow reactivating).
          tasks: w.tasks
            .filter((t) => t.status === "Active")
            .map((t) => ({
              id: t.id,
              label: t.label,
              conditional: t.conditional,
              // Task Update Access + latest task update (display fields
              // only — the updater's internal user id is not sent).
              updateAccess: t.updateAccess,
              progress: t.progress
                ? {
                    percent: t.progress.percent,
                    completed: t.progress.completed,
                    note: t.progress.note,
                    updatedAt: t.progress.updatedAt,
                    updatedByName: t.progress.updatedByName,
                  }
                : null,
            })),
        }))}
        history={history}
        approvedWork={approvedWork}
        projectSwitcher={projectSwitcher}
        activeProjectId={ctx.projectId}
        taskContextEnabled={taskContextEnabled}
      />
    </main>
  );
}
