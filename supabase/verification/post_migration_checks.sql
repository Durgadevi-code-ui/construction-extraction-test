-- ============================================================
-- POST-MIGRATION CHECKS for 00000000000022 and 00000000000023.
--
-- READ-ONLY: one READ ONLY transaction; Postgres rejects any write in it.
-- Run in the Supabase SQL editor after both migrations. Every result set
-- states its expected value. The LAST statement is meant to FAIL with
-- "permission denied for table users" — that error is the proof that the
-- anon role is locked out; any other outcome means it is not.
-- ============================================================

begin transaction read only;

-- A. Effective privileges per public table (catalog-level, includes
--    grants inherited through PUBLIC).
--    Expect: anon_any = false, authenticated_any = false,
--            service_role_select = true, rls_enabled = true  — every row.
select
  c.relname as object_name,
  c.relkind as kind,                    -- r table, v view, m matview, p partitioned
  c.relrowsecurity as rls_enabled,
  has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')          as anon_any,
  has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as authenticated_any,
  has_table_privilege('service_role', c.oid, 'SELECT')                       as service_role_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
order by (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
          or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE')) desc,
         c.relname;

-- B. Summary line. Expect: objects_reachable_by_clients = 0,
--    client_role_policies = 0, public_app_buckets = 0,
--    service_role_missing_select = 0.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and (has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
            or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))) as objects_reachable_by_clients,
  (select count(*) from pg_policies
     where schemaname = 'public' and roles && array['public', 'anon', 'authenticated']::name[]) as client_role_policies,
  (select count(*) from storage.buckets
     where public and id in ('handwritten', 'voice', 'live-updates', 'project-documents', 'raw-inputs')) as public_app_buckets,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and not has_table_privilege('service_role', c.oid, 'SELECT')) as service_role_missing_select;

-- C. Functions: nothing in public executable by anon/authenticated; the
--    rate limiter executable by service_role only.
--    Expect: zero rows from the first query; (true, false, false) from the second.
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

select
  has_function_privilege('service_role', 'public.rate_limit_hit(text, integer)', 'EXECUTE')  as service_role_can_execute,
  has_function_privilege('anon', 'public.rate_limit_hit(text, integer)', 'EXECUTE')          as anon_can_execute,
  has_function_privilege('authenticated', 'public.rate_limit_hit(text, integer)', 'EXECUTE') as authenticated_can_execute;

-- D. Storage objects policies still granted to client roles, for review.
--    Expect: none mentioning handwritten, voice, live-updates,
--    project-documents or raw-inputs.
select policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and roles && array['public', 'anon', 'authenticated']::name[];

-- E. The server's own access still works: run as service_role (what the
--    deployed app uses). Expect: one row of counts, no error.
set local role service_role;
select
  (select count(*) from public.users)                   as users,
  (select count(*) from public.user_project_roles)      as user_project_roles,
  (select count(*) from public.projects)                as projects,
  (select count(*) from public.work_items)              as work_items,
  (select count(*) from public.extraction_submissions)  as extraction_submissions,
  (select count(*) from public.rate_limit_counters)     as rate_limit_counters;
reset role;

-- F. Same query as the anon role. Expect: ERROR "permission denied for
--    table users". (The editor stops here; the transaction is rolled back.)
set local role anon;
select count(*) from public.users;

rollback;
