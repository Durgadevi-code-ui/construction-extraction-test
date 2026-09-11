-- ============================================================
-- Standard department catalog ("70% standard + 30% dynamic" — see
-- project spec). A reusable master list of construction trades that
-- every project draws from, instead of each project's departments
-- being unrelated one-off rows that merely happen to share a name.
--
-- Purely additive:
--   - public.departments is untouched except for one new NULLABLE
--     column (standard_department_id). Every existing department row
--     keeps working exactly as before with that column simply null
--     ("custom" — never matched to the catalog). Nothing here changes
--     department_id, project_id, department_code, department_name, or
--     any existing foreign key that already points at departments.
--   - No existing table is dropped or recreated.
--
-- ON DELETE SET NULL (not CASCADE): removing a catalog entry must
-- never cascade-delete real project departments — it only forgets
-- which standard trade they were linked to.
-- ============================================================

-- IF NOT EXISTS / guarded throughout this migration so it can be safely
-- re-run against an environment where it partially applied before
-- (e.g. a prior attempt that failed partway through) without erroring
-- or duplicating objects.
create table if not exists public.standard_departments (
  standard_department_id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null unique,
  status text not null default 'Active' check (status in ('Active', 'Removed')),
  created_at timestamptz not null default now()
);

alter table public.departments
  add column if not exists standard_department_id uuid
    references public.standard_departments(standard_department_id) on delete set null;

create index if not exists idx_departments_standard_department
  on public.departments(standard_department_id);

alter table public.standard_departments enable row level security;

-- Same fully-open policy as every other table in this schema (see
-- WARNING in 00000000000001_schema.sql) — server-side code in
-- lib/admin.ts / lib/excelImport.ts is the actual authorization
-- boundary, same pattern as every other table here. Guarded with a
-- pg_policies check since CREATE POLICY has no IF NOT EXISTS form.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'standard_departments'
      and policyname = 'standard_departments_open_anon'
  ) then
    create policy "standard_departments_open_anon" on public.standard_departments
      for all using (true) with check (true);
  end if;
end $$;

-- Seed the reusable catalog — common construction trades. Idempotent
-- (ON CONFLICT DO NOTHING) so this migration is safe to re-run and
-- safe to run against an environment where some of these might
-- already have been added by hand.
insert into public.standard_departments (code, name) values
  ('ELEC', 'Electrical Department'),
  ('PLUMB', 'Plumbing Department'),
  ('CONC', 'Concrete Department'),
  ('HVAC', 'HVAC Department'),
  ('ROOF', 'Roofing Department'),
  ('STRUCT', 'Structural Department'),
  ('FRAME', 'Framing Department'),
  ('DRYWALL', 'Drywall Department'),
  ('PAINT', 'Painting Department'),
  ('FLOOR', 'Flooring Department'),
  ('MASON', 'Masonry Department'),
  ('STEEL', 'Steel Department'),
  ('GLAZE', 'Glazing Department'),
  ('INSUL', 'Insulation Department'),
  ('FIRE', 'Fire Protection Department'),
  ('ELEV', 'Elevator Department'),
  ('LOWV', 'Low Voltage Department'),
  ('EXCAV', 'Excavation Department'),
  ('SITE', 'Sitework Department'),
  ('LAND', 'Landscaping Department')
on conflict (code) do nothing;

-- Best-effort backfill: link already-existing project departments to
-- the catalog wherever the name matches exactly — never touches rows
-- that don't match (those stay "custom", which is correct: an admin
-- typed a department name that isn't in the standard list).
update public.departments d
set standard_department_id = sd.standard_department_id
from public.standard_departments sd
where d.standard_department_id is null
  and lower(d.department_name) = lower(sd.name);
