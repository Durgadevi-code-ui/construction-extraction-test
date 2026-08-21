-- ============================================================
-- Minimal schema for the extraction accuracy test app.
-- No auth, no users, no projects — by design (see spec).
--
-- WARNING — TEST-APP-ONLY PERMISSIVENESS:
-- RLS is enabled (never leave it off entirely) but the policies below
-- are fully open to the anon role, because this app has no login and
-- the anon key is the only credential available anywhere in the app.
-- That is fine for a local/private accuracy-testing tool. It is NOT
-- fine for anything with real users or real data — tighten these
-- policies (or add auth) before using this schema for anything beyond
-- this test.
-- ============================================================

create extension if not exists pgcrypto;

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  input_type text not null check (input_type in ('HANDWRITTEN', 'VOICE', 'TEXT')),
  raw_file_path text,
  original_text text,
  status text not null default 'PROCESSING'
    check (status in ('PROCESSING', 'VALID', 'INVALID')),
  created_at timestamptz not null default now()
);

create table public.extracted_results (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  raw_extracted_text text,
  normalized_text text,
  confidence numeric(4,3),
  validation_reason text,
  created_at timestamptz not null default now()
);

create index idx_extracted_results_submission on public.extracted_results(submission_id);

alter table public.submissions enable row level security;
alter table public.extracted_results enable row level security;

-- Fully open policies — see WARNING above.
create policy "submissions_open_anon" on public.submissions
  for all using (true) with check (true);

create policy "extracted_results_open_anon" on public.extracted_results
  for all using (true) with check (true);
