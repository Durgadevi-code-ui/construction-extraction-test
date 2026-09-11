/**
 * Shared delegation types/constants with NO "server-only" import — the
 * pieces client components (DelegationManager, AdminSetupPanel) need
 * to reference directly. lib/delegation.ts (the actual server-only
 * data-access module) re-exports these so server code keeps a single
 * import source, while client code imports this file instead and
 * never accidentally pulls "server-only" into the browser bundle.
 */
export type DelegationPermission =
  | "WORK_ITEM_MANAGEMENT"
  | "WORKER_ASSIGNMENT"
  | "PLANNED_QUANTITY_MANAGEMENT"
  | "PROGRESS_REVIEW"
  | "PROJECT_MANAGEMENT"
  | "DEPARTMENT_MANAGEMENT"
  | "USER_MANAGEMENT";

/** The original four — day-to-day construction workflow capabilities a
 * Contractor delegate has always been able to receive. Unchanged. */
export const WORKFLOW_DELEGATION_PERMISSIONS: DelegationPermission[] = [
  "WORK_ITEM_MANAGEMENT",
  "WORKER_ASSIGNMENT",
  "PLANNED_QUANTITY_MANAGEMENT",
  "PROGRESS_REVIEW",
];

/**
 * Broader Admin Setup capabilities a delegation can now also grant (see
 * supabase/migrations/00000000000009_delegation_admin_permissions.sql).
 * Deliberately narrow and operational-only:
 *   - PROJECT_MANAGEMENT: edit an already-delegated project's details.
 *     Creating a brand-new project stays Admin-only — a project that
 *     doesn't exist yet has no project/department scope to bound it to
 *     (see lib/admin.ts updateProject / the migration doc).
 *   - DEPARTMENT_MANAGEMENT: edit delegated departments; create a new
 *     department only where the delegation is whole-project scoped for
 *     that project (no departmentId restriction) — the one case that
 *     has a natural, safe scope boundary.
 *   - USER_MANAGEMENT: create/edit operational (WORKER/FOREMAN/
 *     SUPERVISOR/MANAGER) users and their project/department role
 *     assignments within delegated scope ONLY. Creating or promoting an
 *     ADMIN, or touching an existing ADMIN's assignment, is blocked
 *     server-side for every non-Admin caller regardless of this
 *     permission — see app/api/admin/users/route.ts.
 * Company management and Delegation management are never delegable at
 * all (not in this list) — see the migration doc for why.
 */
export const ADMIN_DELEGATION_PERMISSIONS: DelegationPermission[] = [
  "PROJECT_MANAGEMENT",
  "DEPARTMENT_MANAGEMENT",
  "USER_MANAGEMENT",
];

export const DELEGATION_PERMISSIONS: DelegationPermission[] = [
  ...WORKFLOW_DELEGATION_PERMISSIONS,
  ...ADMIN_DELEGATION_PERMISSIONS,
];

export type DelegationProjectRef = {
  projectId: string;
  projectName: string;
};

export type DelegationDepartmentRef = {
  departmentId: string;
  departmentName: string;
  projectId: string;
};

export type Delegation = {
  delegationId: string;
  adminUserId: string;
  adminEmail: string;
  delegateUserId: string;
  delegateEmail: string;
  /** One or more projects (see supabase/migrations/00000000000008_delegation_scopes.sql — delegation_projects). */
  projects: DelegationProjectRef[];
  /** Zero or more departments (delegation_departments). For a given
   * project in `projects`, if none of these departments belong to it,
   * the grant covers every department of that project (the same "null
   * department_id = whole project" semantics the old single-department
   * column carried, applied per-project). If one or more do, the grant
   * for that project is restricted to exactly those. */
  departments: DelegationDepartmentRef[];
  permissions: DelegationPermission[];
  status: "Active" | "Revoked";
  startsAt: string;
  endsAt: string;
  reason: string | null;
  /** Derived: status === 'Active' AND now is within [startsAt, endsAt). */
  isCurrentlyActive: boolean;
};
