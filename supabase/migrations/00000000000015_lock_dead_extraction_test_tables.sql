-- ============================================================
-- Locks down the ORIGINAL "Extraction Accuracy Test" schema
-- (00000000000001_schema.sql / 00000000000002_storage.sql) — confirmed
-- dead by a full-repo grep before writing this migration:
--   - public.submissions / public.extracted_results: zero
--     `.from("submissions")` / `.from("extracted_results")` references
--     anywhere in app/ or lib/. The live pipeline uses
--     extraction_submissions/user_validations/unified_records instead
--     (see app/api/text|handwritten|voice/route.ts).
--   - storage bucket 'raw-inputs': zero references to the string
--     "raw-inputs" anywhere in app/ or lib/. lib/supabase.ts's
--     STORAGE_BUCKETS only defines "handwritten" and "voice" — a
--     different bucket, created out-of-band, not touched by this
--     migration.
--
-- This is the smallest, zero-risk piece of the P0 RLS audit: since
-- nothing reads or writes these three objects, dropping their anon
-- policies cannot break any existing behavior (there is no behavior to
-- break). RLS is already enabled on both tables (00000000000001) and on
-- storage.objects (Supabase default) — dropping the anon policies below
-- with no replacement leaves both tables and the bucket reachable only
-- by the service-role key, which nothing in this app currently uses for
-- them (and nothing needs to — they are inert). If a genuine future need
-- to write to them ever arises, that would go through the service-role
-- client, same pattern as lib/liveUpdates.ts.
--
-- Deliberately NOT touched here (see the P0 audit report): every other
-- anon-open table added in 00000000000004-00000000000011
-- (work_item_dependencies, work_item_assignments, admin_delegations,
-- delegation_projects/departments/permissions, notifications,
-- standard_departments) — those ARE actively read/written via the anon
-- client throughout lib/workflow.ts, lib/admin.ts, lib/delegation.ts,
-- lib/notifications.ts, and tightening them requires migrating every one
-- of those call sites to the service-role client first, a separate,
-- larger, independently-verified phase, not a "smallest safe fix."
-- ============================================================

drop policy if exists "submissions_open_anon" on public.submissions;
drop policy if exists "extracted_results_open_anon" on public.extracted_results;
drop policy if exists "raw_inputs_anon_insert" on storage.objects;
drop policy if exists "raw_inputs_anon_select" on storage.objects;
