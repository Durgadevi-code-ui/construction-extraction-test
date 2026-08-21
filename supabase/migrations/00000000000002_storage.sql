-- ============================================================
-- Storage bucket for raw inputs (handwritten/ and voice/ folders).
-- Same test-app-only permissiveness warning as the schema migration
-- applies here: this bucket accepts anonymous uploads/reads because
-- there is no auth anywhere in this app. Do not reuse these policies
-- for anything with real users.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('raw-inputs', 'raw-inputs', false)
on conflict (id) do nothing;

create policy "raw_inputs_anon_insert" on storage.objects
  for insert to anon
  with check (bucket_id = 'raw-inputs');

create policy "raw_inputs_anon_select" on storage.objects
  for select to anon
  using (bucket_id = 'raw-inputs');
