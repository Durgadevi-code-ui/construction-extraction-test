-- ============================================================
-- Broader administrative delegation: extends the existing
-- delegation_permissions vocabulary (00000000000008_delegation_scopes.sql)
-- with three new delegable modules — PROJECT_MANAGEMENT,
-- DEPARTMENT_MANAGEMENT, USER_MANAGEMENT — reusing the exact same
-- delegation_projects/delegation_departments/delegation_permissions
-- tables and expiry/revocation mechanism. No new tables, no second
-- delegation system.
--
-- Deliberately NOT added here (see lib/delegation.ts and the API route
-- comments for the full reasoning):
--   - Company management: Companies are the root of the hierarchy
--     (projects belong to a company, not the other way around) — this
--     schema's delegation scope is project/department-based, which
--     gives no safe way to bound "which companies." Stays Admin-only.
--   - Creating a brand-new Project: same reasoning as Company — a
--     project that doesn't exist yet isn't "inside" any project/
--     department scope a delegation could restrict it to. Stays
--     Admin-only; PROJECT_MANAGEMENT covers editing already-delegated
--     projects only.
--   - A separate "Progress Workflow Management" permission: that's
--     just the existing four workflow permissions (WORK_ITEM_MANAGEMENT/
--     WORKER_ASSIGNMENT/PLANNED_QUANTITY_MANAGEMENT/PROGRESS_REVIEW)
--     combined — adding a fifth umbrella permission that means "all of
--     the above" would just be an alias, not a new capability.
--   - A separate "Dashboard access" / "Reports" permission: the
--     aggregate Dashboard (lib/dashboard.ts) already automatically
--     surfaces whatever project/department scope any active delegation
--     grants, regardless of which permission — it's a view over
--     existing data, not its own capability to gate.
-- ============================================================

do $$
declare
  existing_constraint text;
begin
  select con.conname into existing_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'delegation_permissions'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%permission%';

  if existing_constraint is not null then
    execute format('alter table public.delegation_permissions drop constraint %I', existing_constraint);
  end if;
end $$;

alter table public.delegation_permissions
  add constraint delegation_permissions_permission_check
  check (permission in (
    'WORK_ITEM_MANAGEMENT',
    'WORKER_ASSIGNMENT',
    'PLANNED_QUANTITY_MANAGEMENT',
    'PROGRESS_REVIEW',
    'PROJECT_MANAGEMENT',
    'DEPARTMENT_MANAGEMENT',
    'USER_MANAGEMENT'
  ));
