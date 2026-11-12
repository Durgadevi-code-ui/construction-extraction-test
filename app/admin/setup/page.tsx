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
import { demoLoginConfig } from "@/lib/demoAccess";
import { ReadOnlyProvider } from "@/components/ui/ReadOnly";
import AdminSetupPanel from "@/components/admin/AdminSetupPanel";

export const dynamic = "force-dynamic";

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

  // Demo Login "Admin" door (lib/demoAccess.ts): a public, passwordless,
  // isolated demo session (never the real ADMIN) may VIEW a read-only,
  // demo-scoped preview of Admin Setup. It holds no admin role and no
  // delegation, so every /api/admin/* route still refuses it (isAdminUser)
  // — creating users, resetting passwords, changing roles and delegations
  // stay real-Admin-only, and the account-management tabs (Users,
  // Delegations) are not rendered at all. A demo session exists only when
  // every configured project is isolated (checkDemoAccount
  // project-not-isolated), so the demo-scoped data below contains no real
  // person's record.
  const demoAdmin = currentUser.isDemo && !access?.isRealAdmin;

  if (!demoAdmin && (!access || !access.canEnter)) {
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
      access?.isRealAdmin ? listDelegations(supabase, userId).catch(() => []) : Promise.resolve([]),
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
  const contractors = !access?.isRealAdmin
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
  // Every tab's data is filtered to the caller's resolved scope
  // server-side, before it ever reaches the client bundle (see the
  // `contractors` note above). A real Admin sees everything; a delegated
  // Contractor only their granted scope; a demo preview only the isolated
  // demo project(s), with the account-management tabs withheld entirely.
  let visibleCompanies: typeof companies;
  let visibleProjects: typeof projects;
  let visibleDepartments: typeof departments;
  let visibleWorkItems: typeof workItems;
  let visibleWorkItemDependencies: typeof workItemDependencies;
  let visibleUsers: typeof users;

  if (demoAdmin) {
    // Demo preview: scope strictly to the configured (isolated) demo
    // project(s). Users are included only so the overview counts render —
    // the Users tab itself is never shown for a demo preview, and every
    // member of an isolated project is an @example.com demo account, so no
    // real person's record is in scope.
    const demoProjectIds = new Set(demoLoginConfig().projectIds);
    visibleProjects = projects.filter((p) => demoProjectIds.has(p.projectId));
    const scopedProjectIds = new Set(visibleProjects.map((p) => p.projectId));
    visibleDepartments = departments.filter((d) => scopedProjectIds.has(d.projectId));
    const scopedDepartmentIds = new Set(visibleDepartments.map((d) => d.departmentId));
    visibleWorkItems = workItems.filter((w) => scopedDepartmentIds.has(w.departmentId));
    visibleWorkItemDependencies = workItemDependencies.filter((dep) =>
      visibleWorkItems.some((w) => w.workItemId === dep.workItemId)
    );
    visibleCompanies = companies.filter((c) => visibleProjects.some((p) => p.companyId === c.companyId));
    visibleUsers = users.filter((u) => u.projectRoles.some((r) => scopedDepartmentIds.has(r.departmentId)));
  } else {
    const resolved = access!;
    const inProjectScope = (projectId: string) =>
      resolved.isRealAdmin || resolved.projectIds === "ALL" || resolved.projectIds.has(projectId);
    const inDepartmentScope = (departmentId: string) =>
      resolved.isRealAdmin || resolved.departmentIds === "ALL" || resolved.departmentIds.has(departmentId);

    visibleCompanies = resolved.isRealAdmin ? companies : [];
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
    visibleProjects = resolved.isRealAdmin ? projects : projects.filter((p) => inProjectScope(p.projectId));
    visibleDepartments = resolved.isRealAdmin
      ? departments
      : departments.filter((d) => inDepartmentScope(d.departmentId));
    const hasWorkItemManagement = resolved.isRealAdmin || resolved.permissions.has("WORK_ITEM_MANAGEMENT");
    const hasUserManagement = resolved.isRealAdmin || resolved.permissions.has("USER_MANAGEMENT");
    visibleWorkItems = !hasWorkItemManagement
      ? []
      : resolved.isRealAdmin
        ? workItems
        : workItems.filter((w) => inDepartmentScope(w.departmentId));
    visibleWorkItemDependencies = !hasWorkItemManagement
      ? []
      : resolved.isRealAdmin
        ? workItemDependencies
        : workItemDependencies.filter((dep) => visibleWorkItems.some((w) => w.workItemId === dep.workItemId));
    visibleUsers = !hasUserManagement
      ? []
      : resolved.isRealAdmin
        ? users
        : users.filter((u) => u.projectRoles.some((r) => inDepartmentScope(r.departmentId)));
  }

  const panel = (
    <AdminSetupPanel
      adminUserId={userId}
      userEmail={currentUser.email}
      isRealAdmin={!!access?.isRealAdmin}
      demoAdmin={demoAdmin}
      delegatedPermissions={demoAdmin ? [] : Array.from(access?.permissions ?? [])}
      companies={visibleCompanies}
      projects={visibleProjects}
      departments={visibleDepartments}
      workItems={visibleWorkItems}
      workItemDependencies={visibleWorkItemDependencies}
      users={visibleUsers}
      delegations={demoAdmin ? [] : delegations}
      contractors={demoAdmin ? [] : contractors}
      standardDepartments={standardDepartments}
    />
  );

  // A demo preview is always read-only, independent of the
  // DEMO_LOGIN_READ_ONLY switch (which governs the trade-role workflow
  // experience). This provider wins over the layout's one for this subtree.
  return (
    <main className="flex-1 flex flex-col">
      {demoAdmin ? <ReadOnlyProvider readOnly>{panel}</ReadOnlyProvider> : panel}
    </main>
  );
}
