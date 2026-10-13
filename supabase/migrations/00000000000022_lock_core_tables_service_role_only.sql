-- ============================================================
-- Finishes the P0 RLS lockdown begun in 00000000000014 (live_updates)
-- and 00000000000016 (8 tables): NO table, function or app storage
-- bucket in this project stays reachable with the anon key or a user's
-- own JWT. Only the service-role key (server-side only) can use them.
--
-- NOT YET APPLIED ANYWHERE. Order matters:
--   1. Deploy the application change that moves lib/supabase.ts
--      getSupabaseClient() and the users-profile lookups in
--      lib/session.ts / app/login/actions.ts to the service-role client
--      (same change set as this file). Until then the app still uses the
--      anon key for these tables and this migration WOULD break it.
--   2. Run supabase/verification/security_review.sql (read-only) and
--      record its output, so the "before" state is known.
--   3. Apply this migration to staging, smoke-test every role, then
--      production. Re-run the verification script afterwards.
--
-- Why schema-wide instead of naming each policy: the core tables
-- (companies, projects, departments, work_items, users,
-- user_project_roles, extraction_submissions, unified_records,
-- user_validations, reporting_periods, ...) and the handwritten/voice
-- buckets were created outside these migrations, so their exact policy
-- names are not in this repository. Every policy granted to the anon,
-- authenticated or PUBLIC roles is dropped, and the table privileges are
-- revoked as well, so a policy that is missed or added later still can't
-- open a table.
--
-- RLS stays ENABLED everywhere (it is turned on for any public table that
-- somehow has it off — never off). The service role bypasses RLS, so the
-- application is unaffected. Supabase Auth (auth.*) is a separate schema
-- and is not touched.
-- ============================================================

-- 1. Drop every public-schema policy that applies to anon / authenticated / PUBLIC.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and roles && array['public', 'anon', 'authenticated']::name[]
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end
$$;

-- 2. RLS on for every table in public (no-op where it already is).
do $$
declare
  r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end
$$;

-- 3. No direct privileges for the client-facing roles, now or for objects
--    created later by the migration owner.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant execute on all functions in schema public to service_role;
revoke execute on all functions in schema public from public, anon, authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- 4. App storage buckets: private, and no anon/authenticated object policy.
--    (Files are only ever read through the server — signed URLs for live
--    updates — never by public URL.)
update storage.buckets
set public = false
where id in ('handwritten', 'voice', 'live-updates', 'project-documents', 'raw-inputs');

do $$
declare
  r record;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and roles && array['public', 'anon', 'authenticated']::name[]
      and (
        coalesce(qual, '') ~ '''(handwritten|voice|live-updates|project-documents|raw-inputs)'''
        or coalesce(with_check, '') ~ '''(handwritten|voice|live-updates|project-documents|raw-inputs)'''
      )
  loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end
$$;
