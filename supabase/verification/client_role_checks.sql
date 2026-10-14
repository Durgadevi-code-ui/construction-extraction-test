-- ============================================================
-- CLIENT-ROLE CHECKS — supplements post_migration_checks.sql.
--
-- READ-ONLY: SELECTs against the system catalogs inside one READ ONLY
-- transaction that ends in ROLLBACK; Postgres rejects any write in it.
-- Never applied as a migration.
--
-- Returns ONE result table (the Supabase SQL editor shows the last
-- result only): one row per check with expected / actual / status and
-- the names of anything that needs review. "App schemas" means every
-- schema except Postgres' own and the Supabase-managed ones listed in
-- `managed` below, whose grants Supabase itself maintains.
-- ============================================================

begin transaction read only;

with
managed(nspname) as (
  values ('information_schema'), ('auth'), ('storage'), ('realtime'), ('_realtime'),
         ('supabase_functions'), ('supabase_migrations'), ('extensions'), ('graphql'),
         ('graphql_public'), ('vault'), ('pgsodium'), ('pgsodium_masks'), ('net'),
         ('cron'), ('pgbouncer'), ('_analytics')
),
app_ns as (
  select n.oid, n.nspname
  from pg_namespace n
  where n.nspname not like 'pg\_%' and n.nspname not in (select nspname from managed)
),
client_roles as (
  select oid from pg_roles where rolname in ('anon', 'authenticated')
),
rels as (
  select a.nspname, c.relname, c.relkind, c.relrowsecurity,
         has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as client_reachable,
         has_table_privilege('service_role', c.oid, 'SELECT') as service_select
  from pg_class c
  join app_ns a on a.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f')
),
seqs as (
  select a.nspname, c.relname,
         has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
           or has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE') as client_usable
  from pg_class c
  join app_ns a on a.oid = c.relnamespace
  where c.relkind = 'S'
),
funcs as (
  select a.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef,
         has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') as client_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
  from pg_proc p
  join app_ns a on a.oid = p.pronamespace
),
checks as (
  select 1 as n, 'App tables/views/foreign tables reachable by anon or authenticated' as check_name, '0' as expected,
         (count(*) filter (where client_reachable))::text as actual,
         coalesce(string_agg(nspname || '.' || relname, ', ') filter (where client_reachable), '') as details
  from rels
  union all
  select 2, 'App tables with RLS disabled', '0',
         (count(*) filter (where relkind in ('r', 'p') and not relrowsecurity))::text,
         coalesce(string_agg(nspname || '.' || relname, ', ') filter (where relkind in ('r', 'p') and not relrowsecurity), '')
  from rels
  union all
  select 3, 'App tables the server (service_role) cannot read', '0',
         (count(*) filter (where relkind in ('r', 'p') and not service_select))::text,
         coalesce(string_agg(nspname || '.' || relname, ', ') filter (where relkind in ('r', 'p') and not service_select), '')
  from rels
  union all
  select 4, 'Policies on app tables granted to public/anon/authenticated', '0',
         count(*)::text,
         coalesce(string_agg(schemaname || '.' || tablename || ': ' || policyname, ', '), '')
  from pg_policies
  where schemaname in (select nspname from app_ns)
    and roles && array['public', 'anon', 'authenticated']::name[]
  union all
  select 5, 'App sequences usable by anon or authenticated', '0',
         (count(*) filter (where client_usable))::text,
         coalesce(string_agg(nspname || '.' || relname, ', ') filter (where client_usable), '')
  from seqs
  union all
  select 6, 'App functions executable by anon or authenticated', '0',
         (count(*) filter (where client_exec))::text,
         coalesce(string_agg(nspname || '.' || proname || '(' || args || ')', ', ') filter (where client_exec), '')
  from funcs
  union all
  select 7, 'SECURITY DEFINER functions in app schemas', '1: public.rate_limit_hit',
         (count(*) filter (where prosecdef))::text,
         coalesce(string_agg(nspname || '.' || proname || '(' || args || ')', ', ') filter (where prosecdef), '')
  from funcs
  union all
  select 8, 'rate_limit_hit executable by service_role only', 'service_role only',
         coalesce(string_agg(case when service_exec and not client_exec then 'service_role only'
                                  else 'service=' || service_exec || ' client=' || client_exec end, '; '), 'MISSING'),
         ''
  from funcs
  where nspname = 'public' and proname = 'rate_limit_hit'
  union all
  select 9, 'Default privileges that grant future app objects to anon/authenticated', '0',
         count(*)::text,
         coalesce(string_agg(pg_get_userbyid(d.defaclrole) || ' / ' || d.defaclobjtype::text || ' / ' || coalesce(n.nspname, 'all schemas'), ', '), '')
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  where (n.nspname is null or n.nspname in (select nspname from app_ns))
    and exists (select 1 from aclexplode(d.defaclacl) x where x.grantee in (select oid from client_roles))
  union all
  select 10, 'Public storage buckets', '0',
         count(*)::text, coalesce(string_agg(id, ', '), '')
  from storage.buckets
  where public
  union all
  select 11, 'storage.objects policies granted to public/anon/authenticated', '0',
         count(*)::text, coalesce(string_agg(policyname, ', '), '')
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and roles && array['public', 'anon', 'authenticated']::name[]
)
select n, check_name, expected, actual,
       case when n in (7, 8) then (case when actual = case n when 7 then '1' else 'service_role only' end
                                         and (n = 8 or details = 'public.rate_limit_hit(p_key text, p_window_seconds integer)')
                                        then 'PASS' else 'REVIEW' end)
            when actual = expected then 'PASS' else 'REVIEW' end as status,
       details
from checks
order by n;

rollback;

-- Optional, run SEPARATELY afterwards (it is meant to fail): proves a
-- signed-in user's role is refused at the privilege level.
--   begin transaction read only;
--   set local role authenticated;
--   select count(*) from public.users;   -- expect: ERROR permission denied for table users
--   rollback;
