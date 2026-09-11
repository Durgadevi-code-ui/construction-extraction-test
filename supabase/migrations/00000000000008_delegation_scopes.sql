-- ============================================================
-- Multi-project / multi-department delegation scope.
--
-- admin_delegations previously scoped to exactly one project_id and at
-- most one department_id (00000000000006_admin_delegations.sql). Real
-- usage needs an Admin to delegate several projects and several
-- departments (permissions were already an array-in-a-row and are left
-- alone) in a single grant. Proper relational modeling per requirement,
-- not comma-separated ids: one child table per multi-valued dimension,
-- each a plain (delegation_id, <id>) edge list — the same shape
-- work_item_dependencies and work_item_assignments already use
-- elsewhere in this schema.
--
-- delegation_departments carrying zero rows *for one of the
-- delegation's projects* means "every department in that project" (the
-- same "null department_id = whole project" semantics the single-
-- department column used to carry) — see hasDelegatedPermission in
-- lib/delegation.ts, which applies this per-project, not delegation-wide
-- (a delegation can be whole-project for Project A and department-
-- restricted for Project B in the same grant).
--
-- Existing rows are migrated, not dropped: every admin_delegations row's
-- single project_id/department_id/permissions becomes exactly one row
-- in delegation_projects (+ one in delegation_departments, if it had a
-- department_id) and N rows in delegation_permissions, so no delegation
-- created before this migration loses access.
-- ============================================================

create table public.delegation_projects (
  delegation_id uuid not null references public.admin_delegations(delegation_id) on delete cascade,
  project_id uuid not null references public.projects(project_id) on delete cascade,
  primary key (delegation_id, project_id)
);

create table public.delegation_departments (
  delegation_id uuid not null references public.admin_delegations(delegation_id) on delete cascade,
  department_id uuid not null references public.departments(department_id) on delete cascade,
  primary key (delegation_id, department_id)
);

create table public.delegation_permissions (
  delegation_id uuid not null references public.admin_delegations(delegation_id) on delete cascade,
  permission text not null check (permission in (
    'WORK_ITEM_MANAGEMENT', 'WORKER_ASSIGNMENT', 'PLANNED_QUANTITY_MANAGEMENT', 'PROGRESS_REVIEW'
  )),
  primary key (delegation_id, permission)
);

create index idx_delegation_projects_delegation on public.delegation_projects(delegation_id);
create index idx_delegation_projects_project on public.delegation_projects(project_id);
create index idx_delegation_departments_delegation on public.delegation_departments(delegation_id);
create index idx_delegation_departments_department on public.delegation_departments(department_id);
create index idx_delegation_permissions_delegation on public.delegation_permissions(delegation_id);

alter table public.delegation_projects enable row level security;
alter table public.delegation_departments enable row level security;
alter table public.delegation_permissions enable row level security;

-- Fully open policies — see WARNING in 00000000000001_schema.sql. The
-- actual authorization check happens server-side in lib/delegation.ts,
-- same as admin_delegations itself.
create policy "delegation_projects_open_anon" on public.delegation_projects
  for all using (true) with check (true);
create policy "delegation_departments_open_anon" on public.delegation_departments
  for all using (true) with check (true);
create policy "delegation_permissions_open_anon" on public.delegation_permissions
  for all using (true) with check (true);

-- Backfill from the existing single-valued columns before they're dropped.
insert into public.delegation_projects (delegation_id, project_id)
select delegation_id, project_id from public.admin_delegations
on conflict do nothing;

insert into public.delegation_departments (delegation_id, department_id)
select delegation_id, department_id from public.admin_delegations
where department_id is not null
on conflict do nothing;

insert into public.delegation_permissions (delegation_id, permission)
select delegation_id, unnest(permissions) from public.admin_delegations
on conflict do nothing;

-- Optional free-text reason/remarks on a delegation grant — additive,
-- nullable, no backfill needed for existing rows.
alter table public.admin_delegations add column reason text;

-- The single-valued columns are now fully superseded by the child
-- tables above (every reader — lib/delegation.ts — is updated in this
-- same change to use them instead) — drop them so scope lives in
-- exactly one place, per "do not duplicate."
alter table public.admin_delegations drop constraint if exists admin_delegations_permissions_not_empty;
alter table public.admin_delegations drop column project_id;
alter table public.admin_delegations drop column department_id;
alter table public.admin_delegations drop column permissions;
