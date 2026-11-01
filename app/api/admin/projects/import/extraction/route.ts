import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/apiErrors";
import { getSupabaseClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/session";
import { assertAdminOrDelegated } from "@/lib/delegation";
import { listProjectExtractions, loadProjectExtraction } from "@/lib/projectDocuments";
import { tableRecords, type WorkbookExtraction } from "@/lib/workbookStructure";

export const runtime = "nodejs";

/**
 * The complete (Layer 1) extraction of a project's imported workbooks —
 * every sheet, table, column header and populated cell, as stored by the
 * import route — for AI analysis, mapping, reporting and the admin viewer
 * (components/admin/WorkbookExtractionViewer.tsx).
 *
 * From the stored JSON (project-documents bucket):
 *   GET ?projectId=…                      newest import, full extraction
 *   GET ?projectId=…&importId=…           a specific import
 *   GET ?projectId=…&format=records       tables as { header: value } records
 *   GET ?projectId=…&list=1               the stored imports (ids only)
 * From the database (workbook_* tables, migration 00000000000024):
 *   GET ?projectId=…&format=imports       the project's imports, newest first
 *   GET ?projectId=…&format=summary       one import: completeness, a recount
 *                                         of its stored cells, every sheet
 *                                         with its tables, headers and which
 *                                         columns were mapped to work items
 *   GET ?projectId=…&format=rows&sheet=…[&page=…&pageSize=…]
 *                                         one page of a sheet's populated
 *                                         rows, every cell with its header
 *   GET ?projectId=…&format=cells[&sheet=…] every populated cell (one row per
 *                                         cell with its own header)
 * `importId` selects an import in every format (default: the newest).
 * `sheet` is a sheet name or its 0-based index.
 *
 * Same authorization as importing: Admin, or a Contractor with an active
 * PROJECT_MANAGEMENT delegation for this project.
 */
export async function GET(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const params = request.nextUrl.searchParams;
  const projectId = params.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required." }, { status: 400 });
  }

  try {
    await assertAdminOrDelegated(getSupabaseClient(), {
      actorUserId: currentUser.userId,
      permission: "PROJECT_MANAGEMENT",
      projectId,
    });

    const format = params.get("format");
    const importId = params.get("importId");
    const notFound = () => NextResponse.json({ error: "No stored extraction for this project." }, { status: 404 });

    if (format === "imports") {
      return NextResponse.json({ imports: await listImports(projectId) });
    }
    if (format === "summary") {
      const summary = await loadSummary(projectId, importId);
      return summary ? NextResponse.json(summary) : notFound();
    }
    if (format === "rows") {
      const sheet = params.get("sheet");
      if (sheet === null) {
        return NextResponse.json({ error: "sheet is required." }, { status: 400 });
      }
      const page = await loadRows(projectId, importId, sheet, Number(params.get("page") ?? 1), Number(params.get("pageSize") ?? DEFAULT_PAGE_SIZE));
      return page ? NextResponse.json(page) : notFound();
    }
    if (format === "cells") {
      const imported = await loadImportedCells(projectId, importId, params.get("sheet"));
      return imported ? NextResponse.json(imported) : notFound();
    }

    if (params.get("list") === "1") {
      return NextResponse.json({ imports: (await listProjectExtractions(projectId)).map((e) => e.importId) });
    }

    const found = await loadProjectExtraction(projectId, importId ?? undefined);
    if (!found) return notFound();
    const extraction = found.extraction as WorkbookExtraction;
    if (format === "records") {
      return NextResponse.json({
        importId: found.importId,
        source: extraction.source,
        sheets: extraction.sheets.map((sheet) => ({
          name: sheet.name,
          // Rows outside any table (titles, metadata, notes), in order.
          other: sheet.rows
            .filter((r) => r.table === undefined)
            .map((r) => ({ row: r.row, role: r.role, cells: r.cells.map((c) => ({ column: c.column, value: c.date ?? c.value })) })),
          tables: sheet.tables.map((t) => ({
            index: t.index,
            headerRows: t.headerRows,
            columns: t.columns.map((c) => c.header),
            records: tableRecords(sheet, t.index),
          })),
        })),
      });
    }
    return NextResponse.json({ importId: found.importId, extraction });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load the extraction.";
    const unauthorized = message.includes("not authorized") || message.includes("No active project/department assignment");
    return jsonError(message, unauthorized ? 403 : 500);
  }
}

/** PostgREST returns at most this many rows per request (Supabase's
 * default max-rows); larger reads are paged. */
const PAGE = 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const IMPORT_COLUMNS =
  "import_id, file_name, file_bytes, file_sha256, schema_version, extracted_at, sheet_count, table_count, row_count, cell_count, formula_cell_count, complete, problems, column_mappings, imported_by, created_at";

type ImportRow = {
  import_id: string;
  file_name: string;
  file_bytes: number;
  file_sha256: string;
  schema_version: number;
  extracted_at: string;
  sheet_count: number;
  table_count: number;
  row_count: number;
  cell_count: number;
  formula_cell_count: number;
  complete: boolean;
  problems: string[];
  column_mappings: { sheet: string; headerRow: number; columns: { col: number; header: string; field: string }[] }[];
  imported_by: string | null;
  created_at: string;
};

type SheetRow = {
  sheet_index: number;
  sheet_name: string;
  visibility: string;
  status: string;
  message: string | null;
  used_range: string | null;
  merges: string[];
  tables: {
    index: number;
    headerRows: number[];
    firstRow: number;
    lastRow: number;
    columns: { col: number; column: string; header: string }[];
    dataRows: number;
    sectionRows: number;
    totalRows: number;
  }[];
  populated_rows: number;
  populated_columns: number;
  populated_cells: number;
  formula_cells: number;
};

type CellRow = {
  sheet_index: number;
  sheet_name: string;
  row_number: number;
  row_order: number;
  row_role: string;
  table_index: number | null;
  col_index: number;
  column_letter: string;
  cell_ref: string;
  header: string | null;
  value_type: string;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  display_text: string | null;
  formula: string | null;
  number_format: string | null;
  merge_range: string | null;
};

async function listImports(projectId: string) {
  const { data, error } = await getSupabaseClient()
    .from("workbook_imports")
    .select("import_id, file_name, sheet_count, cell_count, complete, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Failed to list the imports: ${error.message}`);
  return data ?? [];
}

/** The import (the newest when none is given) — only if it belongs to
 * this project, so an import id can't be used to read another project. */
async function findImport(projectId: string, importId: string | null): Promise<ImportRow | null> {
  let query = getSupabaseClient().from("workbook_imports").select(IMPORT_COLUMNS).eq("project_id", projectId);
  if (importId) query = query.eq("import_id", importId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(`Failed to load the import: ${error.message}`);
  return (data?.[0] as ImportRow | undefined) ?? null;
}

async function loadSheets(importId: string): Promise<SheetRow[]> {
  const { data, error } = await getSupabaseClient()
    .from("workbook_sheets")
    .select("*")
    .eq("import_id", importId)
    .order("sheet_index");
  if (error) throw new Error(`Failed to load the sheets: ${error.message}`);
  return (data ?? []) as SheetRow[];
}

function resolveSheet(sheets: SheetRow[], sheet: string): SheetRow | undefined {
  return sheets.find((s) => s.sheet_name === sheet) ?? (/^\d+$/.test(sheet) ? sheets.find((s) => s.sheet_index === Number(sheet)) : undefined);
}

async function loadSummary(projectId: string, importId: string | null) {
  const found = await findImport(projectId, importId);
  if (!found) return null;
  const supabase = getSupabaseClient();
  const sheets = await loadSheets(found.import_id);
  // Recount what is actually in the database, independently of the
  // totals recorded at import time.
  const { count, error } = await supabase
    .from("workbook_cells")
    .select("cell_ref", { count: "exact", head: true })
    .eq("import_id", found.import_id);
  if (error) throw new Error(`Failed to count the stored cells: ${error.message}`);
  const cellsInDatabase = count ?? 0;
  const cellsBySheets = sheets.reduce((n, s) => n + s.populated_cells, 0);

  const mappedField = (sheetName: string, headerRow: number, col: number) =>
    found.column_mappings.find((m) => m.sheet === sheetName && m.headerRow === headerRow)?.columns.find((c) => c.col === col)?.field ?? null;

  return {
    import: {
      importId: found.import_id,
      fileName: found.file_name,
      fileBytes: found.file_bytes,
      sha256: found.file_sha256,
      schemaVersion: found.schema_version,
      extractedAt: found.extracted_at,
      importedAt: found.created_at,
      complete: found.complete,
      problems: found.problems,
      sheetCount: found.sheet_count,
      tableCount: found.table_count,
      rowCount: found.row_count,
      cellCount: found.cell_count,
      formulaCellCount: found.formula_cell_count,
    },
    verification: {
      cellsExpected: found.cell_count,
      cellsInDatabase,
      cellsBySheets,
      sheetsExpected: found.sheet_count,
      sheetsInDatabase: sheets.length,
      matches: cellsInDatabase === found.cell_count && cellsBySheets === found.cell_count && sheets.length === found.sheet_count,
    },
    sheets: sheets.map((s) => ({
      index: s.sheet_index,
      name: s.sheet_name,
      visibility: s.visibility,
      status: s.status,
      message: s.message,
      usedRange: s.used_range,
      merges: s.merges,
      populatedRows: s.populated_rows,
      populatedColumns: s.populated_columns,
      populatedCells: s.populated_cells,
      formulaCells: s.formula_cells,
      tables: s.tables.map((t) => ({
        ...t,
        // Which work-item field a column became (Layer 2), or null: a
        // custom column, kept in the extraction (and, for work-item rows,
        // in the work item's additional fields).
        columns: t.columns.map((c) => ({ ...c, mappedTo: mappedField(s.sheet_name, t.headerRows[0], c.col) })),
      })),
    })),
  };
}

/** All cells of `importId` matching `filter`, in sheet/row/column order,
 * paged past PostgREST's per-request row cap. */
async function selectCells(importId: string, filter: { sheetIndex?: number; sheetName?: string; orderFrom?: number; orderTo?: number }): Promise<CellRow[]> {
  const supabase = getSupabaseClient();
  const cells: CellRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from("workbook_cells").select("*").eq("import_id", importId);
    if (filter.sheetIndex !== undefined) query = query.eq("sheet_index", filter.sheetIndex);
    if (filter.sheetName !== undefined) query = query.eq("sheet_name", filter.sheetName);
    if (filter.orderFrom !== undefined) query = query.gte("row_order", filter.orderFrom);
    if (filter.orderTo !== undefined) query = query.lte("row_order", filter.orderTo);
    const { data, error } = await query
      .order("sheet_index")
      .order("row_number")
      .order("col_index")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to load the extracted cells: ${error.message}`);
    cells.push(...((data ?? []) as CellRow[]));
    if (!data || data.length < PAGE) break;
  }
  return cells;
}

/** One page of a sheet's populated rows (by original order), each with
 * all its cells — so the viewer never loads a whole large sheet at once. */
async function loadRows(projectId: string, importId: string | null, sheet: string, page: number, pageSize: number) {
  const found = await findImport(projectId, importId);
  if (!found) return null;
  const sheets = await loadSheets(found.import_id);
  const target = resolveSheet(sheets, sheet);
  if (!target) return null;
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || DEFAULT_PAGE_SIZE));
  const pageCount = Math.max(1, Math.ceil(target.populated_rows / size));
  const current = Math.min(pageCount, Math.max(1, Math.floor(page) || 1));
  const cells = await selectCells(found.import_id, {
    sheetIndex: target.sheet_index,
    orderFrom: (current - 1) * size + 1,
    orderTo: current * size,
  });
  const rows: { row: number; order: number; role: string; table: number | null; cells: CellRow[] }[] = [];
  for (const c of cells) {
    const last = rows[rows.length - 1];
    if (last && last.row === c.row_number) last.cells.push(c);
    else rows.push({ row: c.row_number, order: c.row_order, role: c.row_role, table: c.table_index, cells: [c] });
  }
  return {
    importId: found.import_id,
    sheet: { index: target.sheet_index, name: target.sheet_name },
    page: current,
    pageSize: size,
    pageCount,
    totalRows: target.populated_rows,
    rows,
  };
}

/** The import's workbook_cells rows in sheet/row/column order. */
async function loadImportedCells(projectId: string, importId: string | null, sheet: string | null) {
  const found = await findImport(projectId, importId);
  if (!found) return null;
  const cells = await selectCells(found.import_id, sheet ? { sheetName: sheet } : {});
  return { importId: found.import_id, fileName: found.file_name, cellCount: found.cell_count, cells };
}
