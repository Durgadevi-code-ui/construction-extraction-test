-- ============================================================
-- READ-ONLY security review of the Supabase project.
--
-- Changes nothing: every statement is a SELECT against the system
-- catalogs, inside a READ ONLY transaction (Postgres rejects any write
-- in it). Run it in the Supabase SQL editor (or psql) before and after
-- applying 00000000000022 / 00000000000023 and keep both outputs.
--
-- Not in this directory's migrations on purpose: it is never applied.
-- ============================================================

begin transaction read only;

-- 1. Every table in public: is RLS on (and forced), and how many policies?
--    Expect: rls_enabled = true for every row.
select
  c.relname                                   as table_name,
  c.relrowsecurity                            as rls_enabled,
  c.relforcerowsecurity                       as rls_forced,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
order by c.relname;

-- 2. Policies on public tables and app storage objects, with their roles
--    and conditions. RLS being on is not enough: a policy with
--    qual = 'true' for anon/authenticated/public opens the whole table.
--    Expect after 00000000000022: no row whose roles include anon,
--    authenticated or public.
select
  schemaname, tablename, policyname, permissive, roles, cmd,
  qual        as using_expression,
  with_check  as with_check_expression,
  (roles && array['public', 'anon', 'authenticated']::name[]) as client_role_policy,
  (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true') as unconditional
from pg_policies
where schemaname = 'public'
   or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, policyname;

-- 3. Direct table privileges held by the client-facing roles.
--    Expect after 00000000000022: no rows.
select table_schema, table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')
group by table_schema, table_name, grantee
order by table_name, grantee;

-- 4. Functions in public the client-facing roles can execute (including
--    SECURITY DEFINER ones, which run with their owner's rights).
--    Expect after 00000000000022 / 23: no rows.
select
  p.proname                                    as function_name,
  pg_get_function_identity_arguments(p.oid)    as arguments,
  p.prosecdef                                  as security_definer,
  has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
order by p.proname;

-- 5. Storage buckets: expect public = false for every bucket this app
--    uses (handwritten, voice, live-updates, project-documents) and the
--    dead raw-inputs bucket.
select id, name, public, file_size_limit, allowed_mime_types, created_at
from storage.buckets
order by id;

-- 6. Rate limiting (after 00000000000023): table present with RLS on, and
--    the function executable only by service_role.
select
  to_regclass('public.rate_limit_counters') is not null as counters_table_exists,
  (select relrowsecurity from pg_class where oid = to_regclass('public.rate_limit_counters')) as counters_rls_enabled,
  (select has_function_privilege('service_role', 'public.rate_limit_hit(text, integer)', 'EXECUTE')
     where to_regprocedure('public.rate_limit_hit(text, integer)') is not null) as service_role_can_execute,
  (select has_function_privilege('anon', 'public.rate_limit_hit(text, integer)', 'EXECUTE')
     where to_regprocedure('public.rate_limit_hit(text, integer)') is not null) as anon_can_execute;

-- 7. Sensitive tables this app relies on — confirm each exists and is
--    covered above (users, user_project_roles, work_items,
--    extraction_submissions, chat_messages, live_updates, ...).
select t.name as expected_table, to_regclass('public.' || t.name) is not null as exists
from (values
  ('users'), ('user_project_roles'), ('companies'), ('projects'), ('departments'),
  ('work_items'), ('extraction_submissions'), ('unified_records'), ('user_validations'),
  ('chat_messages'), ('live_updates'), ('notifications'), ('admin_delegations'),
  ('work_item_assignments'), ('reporting_periods')
) as t(name)
order by t.name;

rollback;
