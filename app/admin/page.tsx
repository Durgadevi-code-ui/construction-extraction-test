import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import { listAdminUsers, listDepartments } from "@/lib/admin";
import { isAdminUser } from "@/lib/authContext";
import { getCurrentUser } from "@/lib/session";
import BootstrapAdminForm from "@/components/admin/BootstrapAdminForm";

export const dynamic = "force-dynamic";

/**
 * Bootstrap entry point — deliberately NOT behind a login requirement
 * (see proxy.ts: only /admin/setup is protected, not bare /admin),
 * because creating the very first Admin account has no session to
 * check yet by definition. Self-gates instead: bootstrapAdminUser
 * (lib/admin.ts) refuses to run once any Admin already exists.
 *
 * Once at least one Admin exists (true for this app already), this
 * page no longer lists every Admin to "pick one" — that list was the
 * actual identity-impersonation hole Phase 2 closes. A logged-in Admin
 * is routed straight to /admin/setup from their own verified session;
 * anyone else is pointed at /login.
 */
export default async function AdminHome() {
  const supabase = getSupabaseClient();
  const adminUsers = await listAdminUsers(supabase);

  if (adminUsers.length === 0) {
    const departments = await listDepartments(supabase);
    return (
      <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
        <div className="max-w-[1600px] mx-auto space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Admin Setup</h1>
            <p className="text-foreground-secondary text-sm mt-1">
              No Admin account exists yet — create the first one below.
            </p>
          </div>
          <BootstrapAdminForm departments={departments} />
        </div>
      </main>
    );
  }

  const currentUser = await getCurrentUser();
  if (currentUser && (await isAdminUser(supabase, currentUser.userId))) {
    redirect("/admin/setup");
  }

  return (
    <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
      <div className="max-w-[1600px] mx-auto space-y-4">
        <h1 className="text-2xl font-bold text-foreground">Admin Setup</h1>
        <p className="text-sm text-foreground-secondary bg-white rounded-lg border border-line p-4">
          {currentUser
            ? "Your account doesn't have Admin access."
            : "Sign in with an Admin account to continue."}{" "}
          <Link href="/login" className="text-brand hover:underline">
            Sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
