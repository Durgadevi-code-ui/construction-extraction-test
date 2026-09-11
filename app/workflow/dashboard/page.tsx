import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import { getDashboardData } from "@/lib/dashboard";
import { requireCurrentUser } from "@/lib/session";
import { logout } from "@/app/login/actions";
import DashboardPanel from "@/components/workflow/DashboardPanel";

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
 * Cross-department/cross-project Dashboard entry point — the aggregate
 * view (see lib/dashboard.ts), distinct from each role's own single-
 * department dashboard (Worker/Foreman/Supervisor pages). Identity is
 * the logged-in session's own user — getDashboardData's own
 * resolveDashboardScope decides Admin vs. Contractor/Subcontractor vs.
 * (rejected) Worker access, unchanged from before this migration.
 */
export default async function DashboardPage() {
  const currentUser = await requireCurrentUser("/workflow/dashboard");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();

  let data: Awaited<ReturnType<typeof getDashboardData>> | null = null;
  let errorMessage: string | null = null;
  try {
    data = await getDashboardData(supabase, userId, { status: "ALL" });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Failed to load the dashboard.";
  }

  if (!data) {
    const isWorker = (errorMessage ?? "").includes("Workers are not authorized");
    return (
      <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
        <div className="max-w-[1600px] mx-auto space-y-3">
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-sm text-foreground-secondary bg-white rounded-lg border border-line p-4">
            {isWorker ? (
              <>
                The aggregate Dashboard isn&apos;t available to Workers.{" "}
                <Link href="/workflow/worker" className="text-brand hover:underline">
                  Go to your Worker Dashboard
                </Link>{" "}
                instead.
              </>
            ) : (
              errorMessage
            )}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <SignOutLink />
        </div>

        <DashboardPanel userId={userId} initialData={data} />
      </div>
    </main>
  );
}
