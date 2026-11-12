import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import { getUserContext } from "@/lib/workflow";
import { isAdminUser, CONTRACTOR_ROLES } from "@/lib/authContext";
import { requireCurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Landing route for a logged-in user — routes to their own dashboard
 * based on their real role, resolved from the server-verified session
 * (requireCurrentUser(), never a client-supplied id). Replaces the old
 * "pick any user from a list" picker that existed only because this
 * app had no login — that picker was the actual security hole Phase 2
 * closes, not just a UI choice; removing it, not hiding it, is the fix.
 */
export default async function WorkflowHome() {
  const currentUser = await requireCurrentUser("/workflow");
  const supabase = getSupabaseClient();

  if (await isAdminUser(supabase, currentUser.userId)) {
    redirect("/admin/setup");
  }

  // getUserContext throws when there's no active user_project_roles row —
  // caught here to fall through to the safe onboarding message below
  // rather than assuming any role. The redirect() calls themselves MUST
  // stay outside this try block: redirect() throws its own internal
  // NEXT_REDIRECT error to perform the navigation, and a try/catch around
  // it would silently swallow that throw, breaking the redirect entirely
  // (see node_modules/next/dist/docs .../functions/redirect.md, "redirect
  // throws an error so it should be called outside the try block", and
  // .../functions/unstable_rethrow.md for the same pitfall with notFound()).
  let ctx;
  try {
    ctx = await getUserContext(supabase, currentUser.userId);
  } catch {
    ctx = null;
  }

  if (ctx) {
    if (ctx.role === "WORKER") redirect("/workflow/worker");
    if (ctx.role === "FOREMAN") redirect("/workflow/foreman");
    if (CONTRACTOR_ROLES.includes(ctx.role)) redirect("/workflow/supervisor");
  }

  return (
    <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
      <div className="max-w-[1600px] mx-auto space-y-4">
        <h1 className="text-2xl font-bold text-foreground">Welcome, {currentUser.email}</h1>
        <p className="text-sm text-foreground-secondary bg-white rounded-lg border border-line p-4">
          Your account isn&apos;t assigned to a project or department yet. Contact your
          Administrator to get access.
        </p>
        <Link href="/account" className="text-sm text-brand hover:underline">
          View account
        </Link>
      </div>
    </main>
  );
}
