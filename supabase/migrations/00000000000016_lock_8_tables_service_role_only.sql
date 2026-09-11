-- ============================================================
-- Locks 8 previously anon-open tables to service-role-only access, per
-- the P0 RLS audit. Application code was already migrated in a prior,
-- separate change (no files touched by this migration) to read/write
-- every one of these 8 tables exclusively through
-- getSupabaseServiceRoleClient() (lib/supabaseAdmin.ts) instead of the
-- plain anon-key client (lib/supabase.ts):
--
--   - admin_delegations         (lib/delegation.ts)
--   - delegation_projects       (lib/delegation.ts)
--   - delegation_permissions    (lib/delegation.ts)
--   - delegation_departments    (lib/delegation.ts)
--   - notifications             (lib/notifications.ts)
--   - standard_departments      (lib/admin.ts)
--   - work_item_assignments     (lib/workflow.ts)
--   - work_item_dependencies    (lib/workflow.ts, lib/admin.ts)
--
-- Each policy dropped below is the exact, unmodified "*_open_anon"
-- policy originally created for that table:
--   work_item_dependencies_open_anon  (00000000000004_work_item_dependencies.sql)
--   work_item_assignments_open_anon   (00000000000005_work_item_assignments.sql)
--   admin_delegations_open_anon       (00000000000006_admin_delegations.sql)
--   notifications_open_anon           (00000000000007_notifications.sql)
--   delegation_projects_open_anon     (00000000000008_delegation_scopes.sql)
--   delegation_departments_open_anon  (00000000000008_delegation_scopes.sql)
--   delegation_permissions_open_anon  (00000000000008_delegation_scopes.sql)
--   standard_departments_open_anon    (00000000000011_standard_departments.sql)
-- None of those original migration files are modified by this one — RLS
-- was already enabled on all 8 tables when each was created, so nothing
-- else needs to change there.
--
-- No other table, storage bucket, or policy is touched here. In
-- particular, this does NOT touch the untracked core tables
-- (companies/projects/departments/work_items/users/user_project_roles/
-- extraction_submissions/unified_records/user_validations) or the
-- dead-table lockdown from 00000000000015 — both are separate, already
-- addressed or explicitly deferred, phases of the same P0 audit.
--
-- Effect: with each anon policy below dropped and no anon/authenticated
-- replacement added, RLS (already enabled on every one of these 8
-- tables) denies anon and authenticated roles all access — SELECT,
-- INSERT, UPDATE, and DELETE alike, since the original policies were
-- unqualified `for all` grants and there is nothing narrower left once
-- they're gone. The service-role key always bypasses RLS regardless of
-- policy, so the application (now using getSupabaseServiceRoleClient()
-- for all 8) is unaffected.
-- ============================================================

drop policy if exists "work_item_dependencies_open_anon" on public.work_item_dependencies;
drop policy if exists "work_item_assignments_open_anon" on public.work_item_assignments;
drop policy if exists "admin_delegations_open_anon" on public.admin_delegations;
drop policy if exists "notifications_open_anon" on public.notifications;
drop policy if exists "delegation_projects_open_anon" on public.delegation_projects;
drop policy if exists "delegation_departments_open_anon" on public.delegation_departments;
drop policy if exists "delegation_permissions_open_anon" on public.delegation_permissions;
drop policy if exists "standard_departments_open_anon" on public.standard_departments;
