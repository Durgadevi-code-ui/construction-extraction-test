import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import { getSubmissionHistory, getUserContext, withApproverNames } from "@/lib/workflow";
import { CONTRACTOR_ROLES } from "@/lib/authContext";
import { requireCurrentUser } from "@/lib/session";
import SubmissionHistoryTable, { submissionHistoryBounds } from "@/components/workflow/SubmissionHistoryTable";

export const dynamic = "force-dynamic";

/**
 * "View History" destination — older/previous submissions, separate
 * from Today's/Yesterday's on the main dashboard (see SupervisorPanel /
 * ForemanTabs). Reuses getSubmissionHistory (same department-scoped
 * query as Today's/Yesterday's, just a wider date range), so this is a
 * read-only view — no workflow, calculation, or permission changes.
 * Shared by both Contractor (SUPERVISOR/MANAGER) and Subcontractor
 * (FOREMAN) — getSubmissionHistory already scopes to the caller's own
 * ctx.departmentId, so a Subcontractor only ever sees their own
 * department's history here, same as their Today Reviews queue.
 */
export default async function SupervisorHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; departmentId?: string }>;
}) {
  const currentUser = await requireCurrentUser("/workflow/supervisor/history");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();

  // ?departmentId= (with ?projectId=) selects among the user's own
  // departments in that project, same as the dashboards.
  const { projectId: projectIdParam, departmentId: departmentIdParam } = await searchParams;
  const ctx = await getUserContext(
    supabase,
    userId,
    projectIdParam ? { projectId: projectIdParam, departmentId: departmentIdParam } : undefined
  );
  const isForeman = ctx.role === "FOREMAN";
  if (!CONTRACTOR_ROLES.includes(ctx.role) && !isForeman) {
    redirect("/workflow");
  }

  const items = await getSubmissionHistory(supabase, userId, submissionHistoryBounds(), ctx.projectId, ctx.departmentId).then((rows) => withApproverNames(supabase, rows));

  return (
    <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Submission History</h1>
          <Link
            // Explicit tab: both pages now open on Reviews by default.
            href={`${isForeman ? "/workflow/foreman" : "/workflow/supervisor"}?tab=dashboard&projectId=${ctx.projectId}&departmentId=${ctx.departmentId}`}
            className="text-sm text-brand transition-colors duration-150 hover:underline"
          >
            Back to Dashboard
          </Link>
        </div>

        <SubmissionHistoryTable items={items} />
      </div>
    </main>
  );
}
