-- ============================================================
-- EMERGENCY ONLY — reverses the effect of
-- 00000000000022_lock_core_tables_service_role_only.sql for the core
-- tables by RE-OPENING them to the anon/authenticated roles.
--
-- THIS RE-CREATES THE VULNERABILITY (anyone with the public anon key can
-- read and write these tables). Use it only if something OUTSIDE the
-- deployed app (commit 7fbe06f or later, which uses the service-role key
-- for every table) turns out to depend on anon access and must keep
-- working while that consumer is fixed — then re-apply migration 22.
--
-- If the APP itself fails after migration 22, this is almost certainly
-- NOT the fix: check that SUPABASE_SERVICE_ROLE_KEY is set in that Vercel
-- project (the API answers "Something went wrong on the server" when it
-- is missing) and that the deployment is commit 7fbe06f or later.
--
-- Migration 22 changes privileges/policies only (plus buckets' public
-- flag); no table data is modified, so restoring a backup/PITR is not
-- needed to undo it and would also discard every write made since.
--
-- To restore the EXACT previous policies instead of this generic one,
-- recreate them from section 2 of the security_review.sql output saved
-- before migration 22 was applied.
-- ============================================================

begin;

do $$
declare
  t text;
begin
  foreach t in array array[
    'companies', 'projects', 'departments', 'work_items', 'users',
    'user_project_roles', 'extraction_submissions', 'unified_records',
    'user_validations', 'reporting_periods'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
      if not exists (select 1 from pg_policies
                     where schemaname = 'public' and tablename = t and policyname = t || '_emergency_open') then
        execute format('create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
                       t || '_emergency_open', t);
      end if;
    end if;
  end loop;
end
$$;

grant usage, select on all sequences in schema public to anon, authenticated;

commit;
