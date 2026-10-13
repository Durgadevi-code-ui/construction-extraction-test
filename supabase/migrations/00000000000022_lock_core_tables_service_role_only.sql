-- ============================================================
-- Finishes the P0 RLS lockdown begun in 00000000000014 (live_updates)
-- and 00000000000016 (8 tables): NO table, function or app storage
-- bucket in this project stays reachable with the anon key or a user's
-- own JWT. Only the service-role key (server-side only) can use them.
--
-- Prerequisite (DONE — commit 7fbe06f, deployed to both production
-- projects): lib/supabase.ts getSupabaseClient() and the users-profile
-- lookups in lib/session.ts / app/login/actions.ts use the service-role
-- client, so the application no longer reads or writes any public table
-- with the anon key or a user JWT. Applying this BEFORE that code is live
-- would break the app.
--
-- Run supabase/verification/security_review.sql (read-only) first and
-- keep its output: it is the record needed to recreate any dropped policy.
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
-- Transaction: one explicit transaction — either everything below takes
-- effect or nothing does, whichever client runs it (SQL editor or psql).
--
-- Ownership: Supabase's SQL editor runs as `postgres`, which is not a
-- superuser. An object owned by another role (e.g. an extension table
-- such as PostGIS's spatial_ref_sys, or storage.objects owned by
-- supabase_storage_admin) can't have RLS enabled or a policy dropped by
-- `postgres`. Those steps are attempted per object; one that is refused
-- is reported as a WARNING instead of aborting the whole lockdown, and the
-- final check at the end lists anything still reachable. Read the
-- WARNING lines in the output (and re-run security_review.sql).
--
-- Idempotent: safe to run again; a second run changes nothing.
--
-- RLS stays ENABLED everywhere (it is turned on for any public table that
-- has it off — never off). The service role bypasses RLS, so the
-- application is unaffected. Supabase Auth (auth.*) is a separate schema
-- and is not touched.
-- ============================================================

begin;

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
    begin
      execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    exception when insufficient_privilege then
      raise warning 'NOT DROPPED (not owner): policy % on public.%', r.policyname, r.tablename;
    end;
  end loop;
end
$$;

-- 2. RLS on for every table in public that has it off.
do $$
declare
  r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' and not rowsecurity
  loop
    begin
      execute format('alter table public.%I enable row level security', r.tablename);
    exception when insufficient_privilege then
      raise warning 'RLS NOT ENABLED (not owner): public.%', r.tablename;
    end;
  end loop;
end
$$;

-- 3. No direct privileges for the client-facing roles, now or for objects
--    created later by the migration owner. (For an object `postgres`
--    doesn't own, Postgres itself only warns and revokes nothing — the
--    final check below reports it.)
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
do $$
begin
  update storage.buckets
  set public = false
  where id in ('handwritten', 'voice', 'live-updates', 'project-documents', 'raw-inputs');
exception when insufficient_privilege then
  raise warning 'BUCKETS NOT UPDATED (no privilege on storage.buckets) — set them private in Storage settings';
end
$$;

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
    begin
      execute format('drop policy %I on storage.objects', r.policyname);
    exception when insufficient_privilege then
      raise warning 'NOT DROPPED (not owner): storage policy %', r.policyname;
    end;
  end loop;
end
$$;

-- 5. Report anything the client-facing roles can still reach. Silence
--    here means the lockdown is complete for the public schema and the
--    app buckets.
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
           or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
  loop
    raise warning 'STILL REACHABLE by anon/authenticated: public.%', r.relname;
  end loop;
  for r in
    select tablename, policyname from pg_policies
    where (schemaname = 'public'
           or (schemaname = 'storage' and tablename = 'objects'
               and (coalesce(qual, '') ~ '''(handwritten|voice|live-updates|project-documents|raw-inputs)'''
                    or coalesce(with_check, '') ~ '''(handwritten|voice|live-updates|project-documents|raw-inputs)''')))
      and roles && array['public', 'anon', 'authenticated']::name[]
  loop
    raise warning 'CLIENT-ROLE POLICY REMAINS: % on %', r.policyname, r.tablename;
  end loop;
  for r in select id from storage.buckets
           where public and id in ('handwritten', 'voice', 'live-updates', 'project-documents', 'raw-inputs')
  loop
    raise warning 'BUCKET STILL PUBLIC: %', r.id;
  end loop;
end
$$;

commit;
