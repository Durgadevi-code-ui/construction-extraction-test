import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase";
import {
  listCompanies,
  listDepartments,
  listProjects,
  listStandardDepartments,
  listUsers,
  listWorkItemDependencies,
  listWorkItems,
} from "@/lib/admin";
import { listDelegations, resolveAdminSetupAccess } from "@/lib/delegation";
import { listSelectableUsers } from "@/lib/workflow";
import { requireCurrentUser } from "@/lib/session";
import { logout } from "@/app/login/actions";
import AdminSetupPanel from "@/components/admin/AdminSetupPanel";

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

export default async function AdminSetupPage() {
  const currentUser = await requireCurrentUser("/admin/setup");
  const userId = currentUser.userId;
  const supabase = getSupabaseClient();

  // Admin Setup used to be strictly Admin-only at the page level, which
  // made every delegation-aware check further down (assertAdminOrDelegated)
  // unreachable from the UI for a delegated Contractor — resolveAdminSetupAccess
  // is the single source of truth for both "may this caller enter at all"
  // and "which projects/departments/permissions should every tab below be
  // filtered to" (see lib/delegation.ts).
  const access = await resolveAdminSetupAccess(supabase, userId).catch(() => null);

  if (!access || !access.canEnter) {
    return (
      <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
        <div className="max-w-[1600px] mx-auto">
          <p className="text-sm text-foreground-secondary">
            Your account doesn&apos;t have Admin access, and no active administrative delegation
            was found.{" "}
            <Link href="/workflow" className="text-brand hover:underline">
              Go to your dashboard
            </Link>
            .
          </p>
        </div>
      </main>
    );
  }

  const [
    companies,
    projects,
    departments,
    workItems,
    workItemDependencies,
    users,
    delegations,
    selectableUsers,
    standardDepartments,
  ] = await Promise.all([
      listCompanies(supabase),
      listProjects(supabase),
      listDepartments(supabase),
      listWorkItems(supabase),
      listWorkItemDependencies(supabase),
      listUsers(supabase),
      // Best-effort, same as the Contractor dashboard's delegation
      // lookup: the Delegations tab is additive to Admin Setup, not a
      // dependency of its core tabs, so a failure here (e.g. the
      // admin_delegations migration not applied yet) degrades to an
      // empty list rather than failing the whole page. ADMIN-only
      // regardless (see AdminSetupPanel), so skipped entirely for a
      // delegated caller.
      access.isRealAdmin ? listDelegations(supabase, userId).catch(() => []) : Promise.resolve([]),
      listSelectableUsers(supabase),
      listStandardDepartments(supabase),
    ]);

  // Delegations tab (the only consumer of `contractors`) is real-Admin-only
  // and never rendered for a delegate — but a Next.js client component
  // receives every prop passed to it at mount regardless of which
  // internal tab is active, so an unconditional `contractors` here would
  // still ship every Contractor's name/email/home department into a
  // delegate's page payload even though the tab that uses it is hidden.
  // Computed only for a real Admin, same principle as visibleCompanies.
  const contractors = !access.isRealAdmin
    ? []
    : selectableUsers
        .filter((u) => u.role === "SUPERVISOR" || u.role === "MANAGER")
        .map((u) => ({
          userId: u.userId,
          email: u.email,
          projectId: u.projectId,
          projectName: u.projectName,
          departmentId: u.departmentId,
          departmentName: u.departmentName,
        }));

  // Every tab's data is filtered to the caller's resolved scope
  // server-side, before it ever reaches the client bundle — a delegated
  // Contractor is never even shown a project/department/user outside
  // what they were granted, not just blocked from writing to it (same
  // principle as the Dashboard's server-side filtering — see
  // lib/dashboard.ts). Real Admin sees everything, unchanged.
  const inProjectScope = (projectId: string) =>
    access.isRealAdmin || access.projectIds === "ALL" || access.projectIds.has(projectId);
  const inDepartmentScope = (departmentId: string) =>
    access.isRealAdmin || access.departmentIds === "ALL" || access.departmentIds.has(departmentId);

  const visibleCompanies = access.isRealAdmin ? companies : [];
  // Projects/Departments are needed broadly (e.g. as picker options on
  // the Departments/Users tabs even without PROJECT_MANAGEMENT/
  // DEPARTMENT_MANAGEMENT itself), so these two are scoped by
  // project/department membership only, matching every other picker in
  // this app. Work Items and Users carry more sensitive per-row data
  // (scheduledValue; email/role/status) and their own dedicated tabs, so
  // — beyond department scope — they're additionally gated on the
  // specific permission that tab requires: a delegate holding only
  // e.g. USER_MANAGEMENT must never receive Work Items' scheduledValue
  // in their page payload just because the department happens to be in
  // scope, even though that tab is hidden from them (a hidden client
  // component prop still ships in the page's data, so "not shown" isn't
  // "not sent" — see the `contractors` fix above for the same reasoning).
  const visibleProjects = access.isRealAdmin ? projects : projects.filter((p) => inProjectScope(p.projectId));
  const visibleDepartments = access.isRealAdmin
    ? departments
    : departments.filter((d) => inDepartmentScope(d.departmentId));
  const hasWorkItemManagement = access.isRealAdmin || access.permissions.has("WORK_ITEM_MANAGEMENT");
  const hasUserManagement = access.isRealAdmin || access.permissions.has("USER_MANAGEMENT");
  const visibleWorkItems = !hasWorkItemManagement
    ? []
    : access.isRealAdmin
      ? workItems
      : workItems.filter((w) => inDepartmentScope(w.departmentId));
  const visibleWorkItemDependencies = !hasWorkItemManagement
    ? []
    : access.isRealAdmin
      ? workItemDependencies
      : workItemDependencies.filter((dep) => visibleWorkItems.some((w) => w.workItemId === dep.workItemId));
  const visibleUsers = !hasUserManagement
    ? []
    : access.isRealAdmin
      ? users
      : users.filter((u) => u.projectRoles.some((r) => inDepartmentScope(r.departmentId)));

  return (
    <main className="min-h-screen py-8 px-4 sm:px-6 lg:px-10">
      <div className="max-w-[1600px] mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Admin Setup</h1>
          <SignOutLink />
          {!access.isRealAdmin && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2 inline-block">
              Viewing under a temporary administrative delegation — scope is limited to what was
              explicitly granted.
            </p>
          )}
        </div>

        <AdminSetupPanel
          adminUserId={userId}
          isRealAdmin={access.isRealAdmin}
          delegatedPermissions={Array.from(access.permissions)}
          companies={visibleCompanies}
          projects={visibleProjects}
          departments={visibleDepartments}
          workItems={visibleWorkItems}
          workItemDependencies={visibleWorkItemDependencies}
          users={visibleUsers}
          delegations={delegations}
          contractors={contractors}
          standardDepartments={standardDepartments}
        />
      </div>
    </main>
  );
}
