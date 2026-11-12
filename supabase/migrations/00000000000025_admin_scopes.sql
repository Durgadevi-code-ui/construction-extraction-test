-- Project-scoped ADMIN authority.
--
-- Purpose: let an ADMIN account (users.user_role = 'ADMIN') be confined to a
-- specific set of projects WITHOUT changing the existing global-ADMIN model.
-- This is what gives the Demo Login "Admin" door the real existing ADMIN role
-- while keeping it inside the isolated Presentation Demo Tower, with no access
-- to real client projects, companies, or credential administration.
--
-- Semantics (enforced in application code — see lib/authContext.ts getAdminScope):
--   * An ADMIN with ZERO rows here  = GLOBAL admin (existing behavior, unchanged).
--   * An ADMIN with >=1 rows here   = SCOPED admin, authorized ONLY within those
--                                     project_ids. Global/credential operations
--                                     (company management, project creation,
--                                     delegation management, ADMIN creation/
--                                     promotion) remain GLOBAL-admin-only.
--   * Rows for a non-ADMIN user are meaningless and ignored.
--
-- Backward compatible: before this migration is applied, no scoped admins can
-- exist, so every ADMIN remains global (getAdminScope treats a missing table as
-- "ALL"). Creating this table alone changes nothing until admin_scopes rows are
-- inserted for a specific account (a separate, reviewed data step).

create table if not exists public.admin_scopes (
  admin_scope_id uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(user_id)   on delete cascade,
  project_id     uuid not null references public.projects(project_id) on delete cascade,
  created_at     timestamptz not null default now(),
  unique (user_id, project_id)
);

create index if not exists admin_scopes_user_id_idx on public.admin_scopes (user_id);

-- Service-role-only, matching the other locked core tables (see migrations
-- 15/16/22): RLS enabled with NO policies denies all anon/authenticated access;
-- the application reads/writes it only through the service-role client after
-- verifying identity server-side. A scoped admin can never read or alter its own
-- scope through the client.
alter table public.admin_scopes enable row level security;

comment on table public.admin_scopes is
  'Optional project-scoping for an ADMIN account. ADMIN with no rows = global (unchanged); ADMIN with rows = scoped to those projects. See lib/authContext.ts getAdminScope.';
