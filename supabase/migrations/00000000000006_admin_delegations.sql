-- ============================================================
-- Temporary Admin -> Contractor delegation (mentor requirement:
-- Admin may be on leave/unavailable and needs to hand off selected
-- administrative capabilities to a Contractor for a bounded window,
-- without granting permanent/unrestricted Admin access).
--
-- Deliberately narrow, not a general permissions engine:
--   - delegate_user_id must be a SUPERVISOR/MANAGER (Contractor) —
--     enforced in lib/delegation.ts, not here (no per-request
--     identity in Postgres for RLS to key on, same reason every
--     other table in this schema is checked server-side instead —
--     see WARNING in 00000000000001_schema.sql).
--   - permissions is a fixed vocabulary (see DelegationPermission in
--     lib/delegation.ts): WORK_ITEM_MANAGEMENT, WORKER_ASSIGNMENT,
--     PLANNED_QUANTITY_MANAGEMENT, PROGRESS_REVIEW. Company/Project/
--     Department/User administration is intentionally never
--     delegatable — those stay Admin-only.
--   - scope is project_id (required) + department_id (optional —
--     null means "every department in this project"), so a
--     Plumbing-only delegation can never reach Electrical data.
--   - a delegation is only "active" when status = 'Active' AND now()
--     is within [starts_at, ends_at) — see
--     lib/delegation.ts getActiveDelegationsForUser. Expiry is time-
--     based, not a background job: a delegation past ends_at simply
--     stops matching that query, so the delegate loses access the
--     instant it expires, with no cleanup step required.
--
-- Same fully-open RLS policy as every other table in this schema
-- (see WARNING in 00000000000001_schema.sql / lib/supabase.ts) — this
-- app has no login, so the actual authorization check happens
-- server-side in lib/delegation.ts, the same place every other role/
-- department check in this app already happens.
-- ============================================================

create table public.admin_delegations (
  delegation_id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.users(user_id),
  delegate_user_id uuid not null references public.users(user_id),
  project_id uuid not null references public.projects(project_id),
  department_id uuid references public.departments(department_id),
  permissions text[] not null,
  status text not null default 'Active' check (status in ('Active', 'Revoked')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint admin_delegations_window check (ends_at > starts_at),
  constraint admin_delegations_not_self check (admin_user_id <> delegate_user_id),
  constraint admin_delegations_permissions_not_empty check (array_length(permissions, 1) > 0)
);

create index idx_admin_delegations_delegate on public.admin_delegations(delegate_user_id);
create index idx_admin_delegations_admin on public.admin_delegations(admin_user_id);

alter table public.admin_delegations enable row level security;

-- Fully open policy — see WARNING above.
create policy "admin_delegations_open_anon" on public.admin_delegations
  for all using (true) with check (true);
