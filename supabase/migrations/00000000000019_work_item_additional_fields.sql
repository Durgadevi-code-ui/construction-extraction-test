-- ============================================================
-- Dynamic Excel/G703 import: preserve columns the importer doesn't
-- recognize as one of the standard work-item fields, instead of
-- silently discarding them. A real project file's extra/unknown
-- columns (see lib/excelImport.ts matchColumns) are now captured
-- per-row and stored here rather than lost on import.
--
-- Nullable JSONB, no default value (NOT `default '{}'::jsonb`) — most
-- rows/imports have no unrecognized columns at all, and a work item
-- created any other way (manual Admin Setup entry, an older import)
-- simply has no additional fields; null cleanly means "none", not "an
-- empty set was recorded". Purely additive: every existing row/query
-- against public.work_items is unaffected, no existing column changed,
-- no existing constraint touched.
-- ============================================================

alter table public.work_items
  add column if not exists additional_fields jsonb;

comment on column public.work_items.additional_fields is
  'Column data from an imported Excel/G703 file that did not map to a standard work-item field (e.g. "Retainage", "% Complete") — {"Original Header Text": value, ...}. Null when the row had no such columns or the work item was not created via import. Never used in any query filter/join, display-only.';
