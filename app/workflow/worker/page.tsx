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
import { logout } from "@/app/login/actions";
import WorkerTabs from "@/components/workflow/WorkerTabs";

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
  searchParams: Promise<{ workItemId?: string; projectId?: string }>;
}) {
  const currentUser = await requireCurrentUser("/workflow/worker");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();
  const { workItemId: workItemIdParam, projectId: projectIdParam } = await searchParams;

  // A worker with more than one active project assignment can switch
  // via ?projectId=; omitted (the common case), this behaves exactly as
  // before — the first (only) active assignment (see getUserContext).
  const ctx = await getUserContext(supabase, userId, { projectId: projectIdParam });
  // A logged-in Contractor/Subcontractor navigating straight to this
  // URL should see their own dashboard, not a Worker's — redirect to
  // the role router rather than rendering data that isn't theirs.
  if (ctx.role !== "WORKER") {
    redirect("/workflow");
  }

  const projectSwitcher =
    ctx.availableProjects.length > 1 ? (
      <div className="flex items-center gap-1 flex-wrap">
        {ctx.availableProjects.map((p) => (
          <Link
            key={p.projectId}
            href={`/workflow/worker?projectId=${p.projectId}`}
            className={
              p.projectId === ctx.projectId
                ? "rounded-lg bg-brand-soft px-2.5 py-1.5 text-xs font-semibold text-brand whitespace-nowrap"
                : "rounded-lg px-2.5 py-1.5 text-xs font-medium text-foreground-secondary border border-line transition-colors duration-150 hover:bg-surface-hover hover:text-foreground whitespace-nowrap"
            }
            title={`${p.projectName} — ${p.departmentName}`}
          >
            {p.projectName}
          </Link>
        ))}
      </div>
    ) : null;

  const workItems = await listAssignedWorkItemsForWorker(supabase, userId, ctx.departmentId);

  if (workItems.length === 0) {
    return (
      <main className="min-h-screen py-10 px-4">
        <div className="max-w-[1600px] mx-auto space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-foreground">Worker Dashboard</h1>
            <div className="flex items-center gap-3">
              {projectSwitcher}
              <SignOutLink />
            </div>
          </div>
          <p className="text-sm text-foreground-secondary">
            No work items are currently assigned to you in {ctx.projectName} — {ctx.departmentName}.
            {ctx.availableProjects.length > 1
              ? " Switch to another project above, or ask your Subcontractor/Contractor to assign one here."
              : " Ask your Subcontractor/Contractor to assign one."}
          </p>
        </div>
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
    getWorkerSubmissionHistory(supabase, userId),
    getWorkerApprovedWork(supabase, userId),
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
          projectName={dashboard.projectName}
          departmentName={dashboard.departmentName}
          activeWorkItem={dashboard.workItem}
          submittedQuantity={submittedQuantity}
          approvedQuantity={dashboard.overallApprovedQuantity}
          progressPercentage={dashboard.overallProgress}
          isCompleted={dashboard.isCompleted}
          todaysProgress={dashboard.todaysProgress}
          latestSubmissionStatusLabel={dashboard.latestSubmissionStatusLabel}
          latestSubmissionStatusCode={dashboard.latestSubmissionStatusCode}
          noEligibleWorkNote={noEligibleWorkNote}
          workItems={workItems.map((w) => ({
            workItemId: w.workItemId,
            code: w.code,
            description: w.description,
            isCompleted: w.isCompleted,
            isEligible: w.isEligible,
            // Only Active tasks are offered to a Worker — a Contractor/
            // Subcontractor-deactivated task (see
            // lib/workflow.ts WorkItemTask.status) is never shown here,
            // even though the Contractor/Subcontractor management view
            // still lists it (to allow reactivating).
            tasks: w.tasks.filter((t) => t.status === "Active"),
          }))}
          activeWorkItemId={activeWorkItemId}
          isAutoSuggested={isAutoSuggested}
          suggestionNote={suggestionNote}
          history={history}
          approvedWork={approvedWork}
          projects={[...new Map(ctx.availableProjects.map((p) => [p.projectId, p])).values()].map(
            (p) => ({ projectId: p.projectId, projectName: p.projectName })
          )}
          activeProjectId={ctx.projectId}
          taskContextEnabled={taskContextEnabled}
        />
    </main>
  );
}
