import "server-only";
import { randomUUID } from "crypto";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";
import type { WorkbookExtraction } from "./workbookStructure";
import { assertWithinCellLimit } from "./workbookLimits";

/**
 * Project document storage — one private bucket, organized per project
 * (see supabase/migrations/00000000000021_project_documents_storage.sql):
 *
 *   project-documents/projects/<projectId>/<kind>/<file>
 *
 * Service-role only (no anon policy on the bucket), so every caller of
 * this module must already have authorized the user for that project.
 * Kinds: `imports` (original uploaded Excel/G703 workbooks) and
 * `extractions` (the complete Layer 1 extraction of each import, JSON —
 * lib/workbookStructure.ts). A new document type is a new `kind`, never a
 * new top-level location.
 */
export const PROJECT_DOCUMENTS_BUCKET = "project-documents";

export type ProjectDocumentKind = "imports" | "extractions";

export function projectDocumentFolder(projectId: string, kind: ProjectDocumentKind): string {
  return `projects/${projectId}/${kind}`;
}

/** Keeps a file name readable but storage-safe (no slashes/odd chars). */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(-120) || "file";
}

/**
 * Stores an uploaded project workbook as-is under the project's
 * imports/ folder (timestamp-prefixed, so every import is kept and the
 * newest sorts last). Best-effort by design: returns null and logs on
 * any failure (e.g. the bucket migration not applied yet) — an import
 * must never fail just because its original couldn't be archived.
 */
export async function saveProjectImportFile(
  projectId: string,
  file: { name: string; bytes: ArrayBuffer; contentType: string }
): Promise<string | null> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${projectDocumentFolder(projectId, "imports")}/${stamp}-${safeFileName(file.name)}`;
    const { error } = await getSupabaseServiceRoleClient()
      .storage.from(PROJECT_DOCUMENTS_BUCKET)
      .upload(path, file.bytes, { contentType: file.contentType || "application/octet-stream", upsert: false });
    if (error) {
      console.error("Could not store the original project workbook:", error.message);
      return null;
    }
    return path;
  } catch (err) {
    console.error("Could not store the original project workbook:", err);
    return null;
  }
}

/**
 * Every stored original workbook for a project, newest first, each
 * downloaded only when its `read()` is called — the caller (the Excel
 * export) decides which upload is the project's working sheet. Empty
 * when none were stored (imported before this existed, or storage
 * unavailable); the caller then builds the workbook from the database.
 */
export async function listProjectImportFiles(
  projectId: string
): Promise<{ path: string; name: string; read: () => Promise<ArrayBuffer | null> }[]> {
  try {
    const storage = getSupabaseServiceRoleClient().storage.from(PROJECT_DOCUMENTS_BUCKET);
    const folder = projectDocumentFolder(projectId, "imports");
    const { data: files, error } = await storage.list(folder, {
      limit: 100,
      sortBy: { column: "name", order: "desc" },
    });
    if (error || !files) return [];
    // Timestamp-prefixed names: a greater name is a newer import.
    return files
      .filter((f) => f.name && !f.name.endsWith("/"))
      .sort((a, b) => b.name.localeCompare(a.name))
      .map((f) => {
        const path = `${folder}/${f.name}`;
        return {
          path,
          name: f.name.replace(/^[0-9T-]+Z?-/, ""),
          read: async () => {
            const { data: blob, error: downloadError } = await storage.download(path);
            return downloadError || !blob ? null : blob.arrayBuffer();
          },
        };
      });
  } catch (err) {
    console.error("Could not list the stored project workbooks:", err);
    return [];
  }
}

/**
 * Stores one import's original workbook AND its complete extraction, under
 * the same timestamped name (imports/<stamp>-<file>, extractions/<stamp>-
 * <file>.json). Unlike saveProjectImportFile this is NOT best-effort: the
 * import route calls it before writing any work item and refuses the
 * import if either part cannot be stored, so an import never exists
 * without its source of record. The extraction is also written cell by
 * cell to the workbook_* tables (supabase/migrations/
 * 00000000000024_workbook_extractions.sql) so it can be queried; if that
 * fails too, everything stored for this import is removed again.
 */
export async function saveProjectImport(
  projectId: string,
  file: { name: string; bytes: ArrayBuffer; contentType: string },
  extraction: WorkbookExtraction,
  importedBy: string | null = null,
  columnMappings: ColumnMappings = []
): Promise<{ importId: string; filePath: string; extractionPath: string }> {
  // Checked again here, before the first upload, whatever the caller did.
  assertWithinCellLimit(extraction.sheets);
  const client = getSupabaseServiceRoleClient();
  const storage = client.storage.from(PROJECT_DOCUMENTS_BUCKET);
  // Timestamp first (newest sorts first by name); the random part keeps two
  // uploads of the same file in the same millisecond apart.
  const importId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${safeFileName(file.name)}`;
  const filePath = `${projectDocumentFolder(projectId, "imports")}/${importId}`;
  const extractionPath = `${projectDocumentFolder(projectId, "extractions")}/${importId}.json`;

  const { error: fileError } = await storage.upload(filePath, file.bytes, {
    contentType: file.contentType || "application/octet-stream",
    upsert: false,
  });
  if (fileError) throw new Error(`Could not store the original workbook: ${fileError.message}`);

  const json = new TextEncoder().encode(JSON.stringify(extraction));
  const { error: jsonError } = await storage.upload(extractionPath, json, { contentType: "application/json", upsert: false });
  if (jsonError) {
    await storage.remove([filePath]);
    throw new Error(`Could not store the workbook extraction: ${jsonError.message}`);
  }

  try {
    await insertExtractionRows(client, { importId, projectId, filePath, extractionPath, importedBy, columnMappings }, extraction);
  } catch (err) {
    await deleteExtractionRows(client, importId);
    await storage.remove([filePath, extractionPath]);
    throw err;
  }
  return { importId, filePath, extractionPath };
}

const CELL_BATCH = 1000;

type ServiceClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type ColumnMappings = { sheet: string; headerRow: number; columns: { col: number; header: string; field: string }[] }[];

/** One workbook_imports row, a workbook_sheets row per sheet (empty and
 * hidden ones too) and a workbook_cells row per populated cell. */
async function insertExtractionRows(
  client: ServiceClient,
  meta: { importId: string; projectId: string; filePath: string; extractionPath: string; importedBy: string | null; columnMappings: ColumnMappings },
  extraction: WorkbookExtraction
): Promise<void> {
  // A sheet read only in part (or not at all) makes the extraction
  // incomplete; chart/dialog sheets hold no cells and empty ones none.
  const problems = extraction.sheets
    .filter((s) => s.status === "incomplete" || s.status === "error")
    .map((s) => `${s.name}: ${s.message ?? s.status}`);
  const fail = (what: string, message: string) => {
    throw new Error(`Could not store the workbook extraction (${what}): ${message}`);
  };
  const { error: importError } = await client.from("workbook_imports").insert({
    import_id: meta.importId,
    project_id: meta.projectId,
    file_name: extraction.source.fileName,
    file_bytes: extraction.source.bytes,
    file_sha256: extraction.source.sha256,
    file_path: meta.filePath,
    extraction_path: meta.extractionPath,
    schema_version: extraction.schemaVersion,
    extracted_at: extraction.extractedAt,
    sheet_count: extraction.totals.sheets,
    table_count: extraction.totals.tables,
    row_count: extraction.totals.rows,
    cell_count: extraction.totals.cells,
    formula_cell_count: extraction.totals.formulaCells,
    complete: problems.length === 0,
    problems,
    column_mappings: meta.columnMappings,
    imported_by: meta.importedBy,
  });
  if (importError) fail("import", importError.message);

  if (extraction.sheets.length > 0) {
    const { error: sheetError } = await client.from("workbook_sheets").insert(
      extraction.sheets.map((s) => ({
        import_id: meta.importId,
        sheet_index: s.index,
        sheet_name: s.name,
        visibility: s.visibility,
        status: s.status,
        message: s.message ?? null,
        used_range: s.usedRange,
        merges: s.merges,
        tables: s.tables,
        populated_rows: s.populatedRows,
        populated_columns: new Set(s.rows.flatMap((r) => r.cells.map((c) => c.col))).size,
        populated_cells: s.populatedCells,
        formula_cells: s.formulaCells,
      }))
    );
    if (sheetError) fail("sheets", sheetError.message);
  }

  const cells = extraction.sheets.flatMap((s) =>
    s.rows.flatMap((r) =>
      r.cells.map((c) => ({
        import_id: meta.importId,
        sheet_index: s.index,
        sheet_name: s.name,
        row_number: r.row,
        row_order: r.order,
        row_role: r.role,
        table_index: r.table ?? null,
        col_index: c.col,
        column_letter: c.column,
        cell_ref: c.ref,
        header: c.header ?? null,
        value_type: c.type,
        value_text: typeof c.value === "string" ? c.value : null,
        value_number: typeof c.value === "number" ? c.value : null,
        value_boolean: typeof c.value === "boolean" ? c.value : null,
        value_date: c.date ?? null,
        display_text: c.text,
        formula: c.formula ?? null,
        number_format: c.format ?? null,
        merge_range: c.merge ?? null,
      }))
    )
  );
  for (let i = 0; i < cells.length; i += CELL_BATCH) {
    const { error: cellError } = await client.from("workbook_cells").insert(cells.slice(i, i + CELL_BATCH));
    if (cellError) fail("cells", cellError.message);
  }
}

/** Children first, so the rollback doesn't depend on ON DELETE CASCADE. */
async function deleteExtractionRows(client: ServiceClient, importId: string): Promise<void> {
  for (const table of ["workbook_cells", "workbook_sheets", "workbook_imports"]) {
    const { error } = await client.from(table).delete().eq("import_id", importId);
    if (error) console.error(`Could not roll back ${table} for import ${importId}:`, error.message);
  }
}

/** Every stored extraction for a project, newest first (no content). */
export async function listProjectExtractions(projectId: string): Promise<{ importId: string; path: string }[]> {
  const storage = getSupabaseServiceRoleClient().storage.from(PROJECT_DOCUMENTS_BUCKET);
  const folder = projectDocumentFolder(projectId, "extractions");
  const { data: files, error } = await storage.list(folder, { limit: 100, sortBy: { column: "name", order: "desc" } });
  if (error) throw new Error(`Could not list the stored extractions: ${error.message}`);
  return (files ?? [])
    .filter((f) => f.name.endsWith(".json"))
    .sort((a, b) => b.name.localeCompare(a.name))
    .map((f) => ({ importId: f.name.replace(/\.json$/, ""), path: `${folder}/${f.name}` }));
}

/** One stored extraction (the newest when `importId` is omitted), or null. */
export async function loadProjectExtraction(projectId: string, importId?: string): Promise<{ importId: string; extraction: unknown } | null> {
  const list = await listProjectExtractions(projectId);
  const entry = importId ? list.find((e) => e.importId === importId) : list[0];
  if (!entry) return null;
  const { data: blob, error } = await getSupabaseServiceRoleClient().storage.from(PROJECT_DOCUMENTS_BUCKET).download(entry.path);
  if (error || !blob) throw new Error(`Could not read the stored extraction: ${error?.message ?? "no data"}`);
  return { importId: entry.importId, extraction: JSON.parse(await blob.text()) };
}
