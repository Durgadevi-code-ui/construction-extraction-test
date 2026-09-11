-- ============================================================
-- Minimal prerequisite edge list for work_items, so the Worker
-- "next work item" suggestion can reflect real construction
-- dependencies (e.g. Electrical Rough-in depends on Wall Construction)
-- instead of assuming every work item in a department must happen in
-- strict line_item_no order. A work item with zero rows here is fully
-- parallel / always eligible. See lib/workflow.ts suggestNextWorkItem.
--
-- Same fully-open RLS policy as every other table in this schema (see
-- WARNING in 00000000000001_schema.sql / lib/supabase.ts) — required
-- for this app to keep working with zero login.
-- ============================================================

create table public.work_item_dependencies (
  work_item_id uuid not null
    references public.work_items(work_item_id) on delete cascade,
  depends_on_work_item_id uuid not null
    references public.work_items(work_item_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (work_item_id, depends_on_work_item_id),
  constraint work_item_dependencies_not_self
    check (work_item_id <> depends_on_work_item_id)
);

create index idx_work_item_dependencies_depends_on
  on public.work_item_dependencies(depends_on_work_item_id);

alter table public.work_item_dependencies enable row level security;

-- Fully open policy — see WARNING above.
create policy "work_item_dependencies_open_anon" on public.work_item_dependencies
  for all using (true) with check (true);
