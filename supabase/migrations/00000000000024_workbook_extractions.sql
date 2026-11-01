-- ============================================================
-- Layer 1 of the dynamic Excel import, queryable in the database: the
-- complete extraction of every imported workbook (lib/workbookStructure.ts)
-- — every worksheet, and every populated cell with its sheet's OWN
-- structure — independent of the fixed work_items columns.
--
--   workbook_imports  one row per import (file, checksum, totals)
--   workbook_sheets   one row per worksheet, incl. empty/hidden ones, with
--                     each table's own column headers (jsonb)
--   workbook_cells    one row per populated cell: sheet, sheet row, row
--                     order, row role (title/metadata/note/header/data/
--                     section/total...), table, column letter, the header
--                     the value sits under, and the value itself (typed
--                     columns + Excel's displayed text, formula, format)
--
-- No fixed source columns anywhere: a header is DATA (workbook_cells.header),
-- so a workbook with any number of sheets, columns or custom headers is
-- stored without a schema change. Rows are reconstructed from cells by
-- (sheet_index, row_number) and kept in order by row_order / col_index.
--
-- The same extraction is also kept as JSON in the project-documents bucket
-- (projects/<id>/extractions/<import_id>.json) next to the original file;
-- the import route writes both or neither (lib/projectDocuments.ts).
-- work_items is unchanged — mapped work items point back here through
-- additional_fields.__source.importId.
--
-- PREREQUISITE for the import code that writes these tables: apply this
-- migration BEFORE deploying it, or committed imports answer 503 (nothing
-- is imported, by design — an import never exists without its extraction).
--
-- Service-role only, like every other table (see 00000000000022): RLS on,
-- no policy, privileges revoked from anon/authenticated.
-- One transaction; idempotent. Additive only: no existing table, row,
-- column, policy or bucket is changed.
-- ============================================================

begin;

create table if not exists public.workbook_imports (
  import_id text primary key,
  project_id uuid not null references public.projects(project_id) on delete cascade,
  file_name text not null,
  file_bytes bigint not null,
  file_sha256 text not null,
  file_path text not null,
  extraction_path text not null,
  schema_version integer not null,
  extracted_at timestamptz not null,
  sheet_count integer not null,
  table_count integer not null,
  row_count integer not null,
  cell_count integer not null,
  formula_cell_count integer not null,
  -- False when any worksheet could not be read in full (status
  -- 'incomplete' or 'error'); problems lists why (no cell contents).
  complete boolean not null,
  problems jsonb not null default '[]'::jsonb,
  -- Layer 2: which sheet columns were mapped to which work-item field
  -- ([{ sheet, headerRow, columns: [{ col, header, field }] }]). Every
  -- other column is custom data, kept only here in Layer 1.
  column_mappings jsonb not null default '[]'::jsonb,
  imported_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_workbook_imports_project on public.workbook_imports(project_id, created_at desc);

create table if not exists public.workbook_sheets (
  import_id text not null references public.workbook_imports(import_id) on delete cascade,
  sheet_index integer not null,
  sheet_name text not null,
  visibility text not null,
  status text not null,
  message text,
  used_range text,
  merges jsonb not null default '[]'::jsonb,
  -- [{ index, headerRows, firstRow, lastRow, columns: [{ col, column, header }], ... }]
  tables jsonb not null default '[]'::jsonb,
  populated_rows integer not null,
  populated_columns integer not null,
  populated_cells integer not null,
  formula_cells integer not null,
  primary key (import_id, sheet_index)
);

create table if not exists public.workbook_cells (
  import_id text not null,
  sheet_index integer not null,
  sheet_name text not null,
  row_number integer not null,
  row_order integer not null,
  row_role text not null,
  table_index integer,
  col_index integer not null,
  column_letter text not null,
  cell_ref text not null,
  header text,
  value_type text not null,
  value_text text,
  value_number double precision,
  value_boolean boolean,
  value_date text,
  display_text text,
  formula text,
  number_format text,
  merge_range text,
  primary key (import_id, sheet_index, cell_ref),
  foreign key (import_id, sheet_index) references public.workbook_sheets(import_id, sheet_index) on delete cascade
);
create index if not exists idx_workbook_cells_row on public.workbook_cells(import_id, sheet_index, row_number, col_index);
-- Row paging in the admin viewer (row_order ranges within a sheet).
create index if not exists idx_workbook_cells_order on public.workbook_cells(import_id, sheet_index, row_order);
create index if not exists idx_workbook_cells_header on public.workbook_cells(import_id, header) where header is not null;

comment on table public.workbook_cells is
  'Every populated cell of an imported workbook (Layer 1 extraction), with its sheet, row, row role, table and own header. Headers are data, so any workbook layout is stored without schema changes.';

alter table public.workbook_imports enable row level security;
alter table public.workbook_sheets enable row level security;
alter table public.workbook_cells enable row level security;
revoke all on table public.workbook_imports from anon, authenticated;
revoke all on table public.workbook_sheets from anon, authenticated;
revoke all on table public.workbook_cells from anon, authenticated;
-- Explicit, so the server's access doesn't depend on Supabase's default
-- privileges (00000000000022 may or may not have run first).
grant select, insert, update, delete on table public.workbook_imports to service_role;
grant select, insert, update, delete on table public.workbook_sheets to service_role;
grant select, insert, update, delete on table public.workbook_cells to service_role;

commit;

-- Make the new tables visible to the API (PostgREST) right away.
notify pgrst, 'reload schema';
