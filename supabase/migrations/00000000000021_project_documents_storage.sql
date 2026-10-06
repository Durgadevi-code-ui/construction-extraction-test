-- ============================================================
-- Project documents: a private storage bucket for project-related files,
-- organized per project instead of flat UUID paths:
--
--   project-documents/
--     projects/<project_id>/imports/<timestamp>-<original file name>
--
-- First user: the Excel/G703 import (app/api/admin/projects/import)
-- now keeps the ORIGINAL uploaded workbook here on commit, so
-- "Download updated Excel" (app/api/workflow/excel-export) can re-open
-- that exact workbook — same sheets, headings, divisions and columns —
-- and fill in the latest progress, instead of inventing a new report
-- format. Later project document types get their own sibling folder
-- under projects/<project_id>/ (see lib/projectDocuments.ts).
--
-- Storage only: no table, column or existing policy is changed.
-- Service-role only from day one (same hardening as live-updates in
-- 00000000000014): NO anon/authenticated policy is created, so the
-- public anon key cannot list, read or write these files directly —
-- they hold contract amounts. Every read/write goes through the app's
-- server (lib/supabaseAdmin.ts) after its own role/scope checks.
--
-- If this migration hasn't been applied yet, imports still succeed
-- (storing the original is best-effort, logged) and the download falls
-- back to a regenerated workbook — nothing else depends on it.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('project-documents', 'project-documents', false)
on conflict (id) do nothing;
