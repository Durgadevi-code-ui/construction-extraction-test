-- ============================================================
-- Role-level security / work-item visibility (Contractor -> Subcontractor
-- -> Worker): the schema had role+department+project scoping already
-- (users -> user_project_roles), but nothing recording which specific
-- work items are assigned to which worker. Without this, any Worker in
-- a department could see and submit progress against every work item in
-- that department, not just their own — this table is the minimum
-- addition to close that gap. See lib/workflow.ts
-- listAssignedWorkItemsForWorker / resolveWorkItemForWorker.
--
-- Many-to-many by design (one work item can be assigned to several
-- workers at once, and a worker can hold several work items) — same
-- edge-list shape as work_item_dependencies, just worker <-> work_item
-- instead of work_item <-> work_item.
--
-- Same fully-open RLS policy as every other table in this schema (see
-- WARNING in 00000000000001_schema.sql / lib/supabase.ts) — this app
-- has no login, so Postgres has no per-request identity for RLS to key
-- on. The actual authorization check (a worker only ever sees/submits
-- against rows in *their own* work_item_assignments) happens server-side
-- in lib/workflow.ts, the same place department/project scoping already
-- happens today.
-- ============================================================

create table public.work_item_assignments (
  work_item_id uuid not null
    references public.work_items(work_item_id) on delete cascade,
  user_id uuid not null
    references public.users(user_id) on delete cascade,
  status text not null default 'Active'
    check (status in ('Active', 'Removed')),
  assigned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (work_item_id, user_id)
);

create index idx_work_item_assignments_user
  on public.work_item_assignments(user_id);

alter table public.work_item_assignments enable row level security;

-- Fully open policy — see WARNING above.
create policy "work_item_assignments_open_anon" on public.work_item_assignments
  for all using (true) with check (true);

-- ------------------------------------------------------------------
-- Seed data for the two-department test phase (Electrical / Plumbing),
-- reusing the workers/work items already seeded in this project — no
-- new users or work items created here. Idempotent: safe to re-run.
-- ------------------------------------------------------------------

insert into public.work_item_assignments (work_item_id, user_id, status)
select w.work_item_id, u.user_id, 'Active'
from public.work_items w
join public.departments d
  on d.department_id = w.department_id
  and d.department_name = 'Electrical Department'
join public.users u
  on u.user_mail = 'electrical.worker@test.com'
where w.line_item_no in ('053', '055')
on conflict (work_item_id, user_id) do nothing;

insert into public.work_item_assignments (work_item_id, user_id, status)
select w.work_item_id, u.user_id, 'Active'
from public.work_items w
join public.departments d
  on d.department_id = w.department_id
  and d.department_name = 'Plumbing Department'
join public.users u
  on u.user_mail = 'plumbing.worker@test.com'
where w.line_item_no = '043'
on conflict (work_item_id, user_id) do nothing;
