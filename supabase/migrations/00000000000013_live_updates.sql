-- ============================================================
-- "Review / Live Update" evidence — a Worker can share a quick photo or
-- voice note so a reviewer can follow ongoing work, entirely SEPARATE
-- from the real extraction/progress pipeline (extraction_submissions /
-- user_validations / unified_records). A live_updates row is never read
-- by resolveConstructionContext, submitWorkerProgress, OCR/STT, progress
-- calculations, or approval logic — it carries no progress percentage
-- or quantity at all, by design, so it can never be mistaken for (or
-- accidentally counted as) a real progress submission.
--
-- Same fully-open RLS policy as every other table in this schema (see
-- WARNING in 00000000000001_schema.sql / lib/supabase.ts) — this app
-- has no per-request Postgres identity for RLS to key on; the actual
-- authorization check (a Worker may only post for their own project/
-- department; a reviewer only ever sees their own department's rows)
-- happens server-side in lib/liveUpdates.ts, the same pattern every
-- other table in this schema already uses.
-- ============================================================

create table public.live_updates (
  live_update_id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(project_id) on delete cascade,
  department_id uuid not null references public.departments(department_id) on delete cascade,
  work_item_id uuid references public.work_items(work_item_id) on delete set null,
  worker_id uuid not null references public.users(user_id) on delete cascade,
  update_type text not null check (update_type in ('PHOTO', 'VOICE')),
  storage_path text not null,
  caption text,
  status text not null default 'Active' check (status in ('Active', 'Removed')),
  created_at timestamptz not null default now()
);

-- Powers "every live update in this department, newest first" (reviewer
-- feed) and "every live update this worker posted" (worker's own view) —
-- the two queries lib/liveUpdates.ts reads through.
create index idx_live_updates_department on public.live_updates(department_id, created_at desc);
create index idx_live_updates_worker on public.live_updates(worker_id, created_at desc);

alter table public.live_updates enable row level security;

-- Fully open policy — see WARNING above.
create policy "live_updates_open_anon" on public.live_updates
  for all using (true) with check (true);

-- ------------------------------------------------------------------
-- Dedicated storage bucket, separate from the extraction pipeline's
-- handwritten/voice buckets (never reused — a live update must never be
-- picked up by anything that scans those extraction buckets). Private
-- (public: false); same anon insert/select policy shape as
-- 00000000000002_storage.sql's raw-inputs bucket, since every write/read
-- in this app goes through the anon-key server client (lib/supabase.ts),
-- never a signed-in end-user Postgres role — see that migration's own
-- WARNING for why.
-- ------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('live-updates', 'live-updates', false)
on conflict (id) do nothing;

create policy "live_updates_anon_insert" on storage.objects
  for insert to anon
  with check (bucket_id = 'live-updates');

create policy "live_updates_anon_select" on storage.objects
  for select to anon
  using (bucket_id = 'live-updates');
