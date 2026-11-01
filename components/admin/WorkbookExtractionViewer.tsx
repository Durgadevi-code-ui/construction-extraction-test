"use client";

import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import Badge, { type BadgeVariant } from "@/components/ui/Badge";

/**
 * Admin view of an import's complete (Layer 1) extraction, read back from
 * the database (app/api/admin/projects/import/extraction/route.ts): the
 * import's completeness and a recount of its stored cells, every sheet
 * (switchable), each table with its own headers and which columns became
 * work-item fields, and the sheet's populated rows — one page at a time,
 * every cell at its original row/column with its header, formula and
 * value. Shows all rows, not only the ones that became work items.
 */

type ImportListItem = { import_id: string; file_name: string; sheet_count: number; cell_count: number; complete: boolean; created_at: string };

type Summary = {
  import: {
    importId: string;
    fileName: string;
    fileBytes: number;
    importedAt: string;
    complete: boolean;
    problems: string[];
    sheetCount: number;
    tableCount: number;
    rowCount: number;
    cellCount: number;
    formulaCellCount: number;
  };
  verification: {
    cellsExpected: number;
    cellsInDatabase: number;
    cellsBySheets: number;
    sheetsExpected: number;
    sheetsInDatabase: number;
    matches: boolean;
  };
  sheets: {
    index: number;
    name: string;
    visibility: string;
    status: string;
    message: string | null;
    usedRange: string | null;
    merges: string[];
    populatedRows: number;
    populatedColumns: number;
    populatedCells: number;
    formulaCells: number;
    tables: {
      index: number;
      headerRows: number[];
      firstRow: number;
      lastRow: number;
      dataRows: number;
      sectionRows: number;
      totalRows: number;
      columns: { col: number; column: string; header: string; mappedTo: string | null }[];
    }[];
  }[];
};

type Cell = {
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

type RowsPage = {
  page: number;
  pageSize: number;
  pageCount: number;
  totalRows: number;
  rows: { row: number; order: number; role: string; table: number | null; cells: Cell[] }[];
};

const PAGE_SIZE = 50;

const ROLE_STYLE: Record<string, { label: string; variant: BadgeVariant }> = {
  title: { label: "Title", variant: "brand" },
  metadata: { label: "Metadata", variant: "info" },
  note: { label: "Note", variant: "neutral" },
  header: { label: "Header", variant: "brand" },
  "header-band": { label: "Sub-header", variant: "brand" },
  "repeated-header": { label: "Header (repeat)", variant: "brand" },
  data: { label: "Data", variant: "success" },
  section: { label: "Section", variant: "info" },
  total: { label: "Total", variant: "warning" },
};

const SHEET_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  ok: { label: "Read in full", variant: "success" },
  empty: { label: "Empty sheet", variant: "neutral" },
  unsupported: { label: "No cell data (chart/dialog sheet)", variant: "neutral" },
  incomplete: { label: "Read only in part", variant: "error" },
  error: { label: "Could not be read", variant: "error" },
};

/** null for 404 (nothing stored yet), the parsed body otherwise. */
async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status}).`);
  return data as T;
}

/** The value as stored (dates as ISO, numbers at full precision). */
function storedValue(c: Cell): string {
  if (c.value_date) return c.value_date;
  if (c.value_number !== null) return String(c.value_number);
  if (c.value_boolean !== null) return c.value_boolean ? "TRUE" : "FALSE";
  return c.value_text ?? "";
}

function cellTitle(c: Cell): string {
  return [
    `${c.cell_ref}${c.header ? ` — ${c.header}` : ""}`,
    `Type: ${c.value_type}`,
    `Stored value: ${storedValue(c) || "(none)"}`,
    c.display_text !== null && c.display_text !== storedValue(c) ? `Displayed: ${c.display_text}` : null,
    c.formula ? `Formula: =${c.formula}` : null,
    c.number_format ? `Format: ${c.number_format}` : null,
    c.merge_range ? `Merged: ${c.merge_range}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export default function WorkbookExtractionViewer({ projectId, importId: initialImportId }: { projectId: string; importId?: string }) {
  const base = `/api/admin/projects/import/extraction?projectId=${encodeURIComponent(projectId)}`;
  const [imports, setImports] = useState<ImportListItem[] | null>(null);
  const [importId, setImportId] = useState<string | undefined>(initialImportId);
  // Each response is kept with the request it answers, so "loading" is
  // simply "the latest response is for a different request".
  const summaryKey = importId ?? "";
  const [summaryState, setSummaryState] = useState<{ key: string; data?: Summary; error?: string } | null>(null);
  const [sheetChoice, setSheetChoice] = useState<{ importId: string; index: number } | null>(null);
  const [pageChoice, setPageChoice] = useState<{ sheet: string; page: number } | null>(null);
  const [rowsState, setRowsState] = useState<{ key: string; data?: RowsPage; error?: string } | null>(null);
  const [showFormulas, setShowFormulas] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getJson<{ imports: ImportListItem[] }>(`${base}&format=imports`)
      .then((d) => !cancelled && setImports(d?.imports ?? []))
      .catch(() => !cancelled && setImports([]));
    return () => {
      cancelled = true;
    };
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    getJson<Summary>(`${base}&format=summary${summaryKey ? `&importId=${encodeURIComponent(summaryKey)}` : ""}`)
      .then((data) => !cancelled && setSummaryState({ key: summaryKey, data: data ?? undefined }))
      .catch((err) => !cancelled && setSummaryState({ key: summaryKey, error: err instanceof Error ? err.message : "Could not load the extraction." }));
    return () => {
      cancelled = true;
    };
  }, [base, summaryKey]);

  const summaryLoading = summaryState?.key !== summaryKey;
  const summary = summaryLoading ? null : (summaryState?.data ?? null);
  const summaryError = summaryLoading ? null : (summaryState?.error ?? null);

  // The chosen sheet of this import, else its first sheet with data.
  const sheetIndex =
    summary && sheetChoice?.importId === summary.import.importId
      ? sheetChoice.index
      : (summary?.sheets.find((s) => s.populatedCells > 0)?.index ?? summary?.sheets[0]?.index ?? 0);
  const sheet = summary?.sheets.find((s) => s.index === sheetIndex) ?? null;
  const sheetKey = summary && sheet ? `${summary.import.importId}|${sheet.index}` : "";
  const page = pageChoice?.sheet === sheetKey ? pageChoice.page : 1;
  const rowsKey = `${sheetKey}|${page}`;
  const sheetHasRows = !!sheet && sheet.populatedRows > 0;

  useEffect(() => {
    if (!summary || !sheet || !sheetHasRows) return;
    let cancelled = false;
    getJson<RowsPage>(
      `${base}&format=rows&importId=${encodeURIComponent(summary.import.importId)}&sheet=${sheet.index}&page=${page}&pageSize=${PAGE_SIZE}`
    )
      .then((data) => !cancelled && setRowsState(data ? { key: rowsKey, data } : { key: rowsKey, error: "This sheet is no longer stored." }))
      .catch((err) => !cancelled && setRowsState({ key: rowsKey, error: err instanceof Error ? err.message : "Could not load the rows." }));
    return () => {
      cancelled = true;
    };
  }, [base, summary, sheet, sheetHasRows, page, rowsKey]);

  const rowsLoading = rowsState?.key !== rowsKey;
  // While the next page loads, the previous page of the SAME sheet stays.
  const rows = rowsState?.data && rowsState.key.startsWith(`${sheetKey}|`) ? rowsState.data : null;
  const rowsError = rowsLoading ? null : (rowsState?.error ?? null);
  const setPage = (p: number) => setPageChoice({ sheet: sheetKey, page: p });

  // Only the columns this page actually has cells in, in sheet order.
  const columns = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of rows?.rows ?? []) for (const c of r.cells) seen.set(c.col_index, c.column_letter);
    return [...seen].sort(([a], [b]) => a - b);
  }, [rows]);

  if (summaryLoading) {
    return <p className="text-xs text-foreground-secondary">Loading the stored extraction…</p>;
  }
  if (summaryError) {
    return (
      <p className="text-xs text-error bg-error-soft border border-error-border rounded-lg px-2.5 py-1.5">
        Could not load the stored extraction: {summaryError}
      </p>
    );
  }
  if (!summary) {
    return <p className="text-xs text-foreground-secondary">No workbook has been imported for this project yet.</p>;
  }

  const { import: imp, verification: v } = summary;
  const firstShown = rows && rows.rows.length ? (rows.page - 1) * rows.pageSize + 1 : 0;
  const lastShown = rows ? firstShown + rows.rows.length - (rows.rows.length ? 1 : 0) : 0;

  return (
    <div className="space-y-3 text-xs">
      {/* Import + completeness */}
      <div className="bg-white border border-line rounded-lg p-2.5 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-foreground text-sm break-all">{imp.fileName}</p>
          <Badge variant={imp.complete ? "success" : "error"}>{imp.complete ? "Extraction complete" : "Extraction incomplete"}</Badge>
          <Badge variant={v.matches ? "success" : "error"}>
            {v.matches ? "Database verified" : "Database count mismatch"}
          </Badge>
        </div>
        <p className="text-foreground-secondary">
          Imported {new Date(imp.importedAt).toLocaleString()} · {imp.sheetCount} sheet(s) · {imp.tableCount} table(s) ·{" "}
          {imp.rowCount} populated row(s) · {imp.cellCount} populated cell(s) · {imp.formulaCellCount} formula cell(s)
        </p>
        <p className={v.matches ? "text-foreground-secondary" : "text-error"}>
          Stored in the database: {v.cellsInDatabase} of {v.cellsExpected} cells, {v.sheetsInDatabase} of {v.sheetsExpected} sheets
          {v.matches ? " — every extracted cell is stored." : " — the stored data does not match what was extracted."}
        </p>
        {!imp.complete && (
          <ul className="list-disc list-inside text-error">
            {imp.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
        {imports && imports.length > 1 && (
          <label className="flex items-center gap-2 text-foreground-secondary">
            Import:
            <select
              value={imp.importId}
              onChange={(e) => setImportId(e.target.value)}
              className="border border-line rounded-md bg-white px-1.5 py-1 text-xs text-foreground max-w-full"
            >
              {imports.map((i) => (
                <option key={i.import_id} value={i.import_id}>
                  {new Date(i.created_at).toLocaleString()} — {i.file_name} ({i.cell_count} cells{i.complete ? "" : ", incomplete"})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Sheet tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Worksheets">
        {summary.sheets.map((s) => (
          <button
            key={s.index}
            role="tab"
            aria-selected={s.index === sheetIndex}
            onClick={() => setSheetChoice({ importId: summary.import.importId, index: s.index })}
            className={`shrink-0 rounded-md border px-2.5 py-1 transition-colors duration-150 ${
              s.index === sheetIndex ? "border-brand bg-brand-soft text-brand font-medium" : "border-line bg-white text-foreground-secondary hover:bg-surface-hover"
            }`}
          >
            {s.name}
            {s.visibility !== "visible" ? " (hidden)" : ""} · {s.populatedCells}
          </button>
        ))}
      </div>

      {sheet && (
        <div className="space-y-2">
          {/* Sheet details */}
          <div className="bg-white border border-line rounded-lg p-2.5 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-foreground">
                Sheet {sheet.index + 1}: {sheet.name}
              </p>
              <Badge variant={SHEET_STATUS[sheet.status]?.variant ?? "neutral"}>{SHEET_STATUS[sheet.status]?.label ?? sheet.status}</Badge>
            </div>
            {sheet.message && <p className="text-error">{sheet.message}</p>}
            <p className="text-foreground-secondary">
              {sheet.populatedRows} populated row(s) · {sheet.populatedColumns} populated column(s) · {sheet.populatedCells} cell(s) ·{" "}
              {sheet.formulaCells} formula cell(s){sheet.usedRange ? ` · range ${sheet.usedRange}` : ""}
              {sheet.merges.length ? ` · ${sheet.merges.length} merged range(s)` : ""}
            </p>
            {sheet.tables.length === 0 ? (
              <p className="text-foreground-muted">No table detected — every row is kept as title, metadata or note.</p>
            ) : (
              sheet.tables.map((t) => (
                <div key={t.index} className="space-y-1">
                  <p className="text-foreground">
                    Table {t.index}: header row{t.headerRows.length > 1 ? "s" : ""} {t.headerRows.join(", ")} · rows {t.firstRow}–{t.lastRow} ·{" "}
                    {t.dataRows} data, {t.sectionRows} section, {t.totalRows} total row(s)
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {t.columns.map((c) => (
                      <span
                        key={c.col}
                        className={`rounded border px-1.5 py-0.5 ${c.mappedTo ? "border-success-border bg-success-soft text-success" : "border-line bg-surface-soft text-foreground-secondary"}`}
                        title={c.mappedTo ? `Column ${c.column} → work-item field "${c.mappedTo}"` : `Column ${c.column} — custom column, kept as extracted data`}
                      >
                        <span className="text-foreground-muted">{c.column}</span> {c.header}
                        {c.mappedTo ? ` → ${c.mappedTo}` : " · custom"}
                      </span>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Rows */}
          {sheet.populatedRows === 0 ? (
            <p className="text-foreground-muted">This sheet has no populated cells.</p>
          ) : rowsError ? (
            <p className="text-error bg-error-soft border border-error-border rounded-lg px-2.5 py-1.5">Could not load the rows: {rowsError}</p>
          ) : !rows ? (
            <p className="text-foreground-secondary">Loading rows…</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-foreground-secondary">
                  Rows {firstShown}–{lastShown} of {rows.totalRows} populated row(s) · page {rows.page} of {rows.pageCount}
                  {rowsLoading ? " · loading…" : ""}
                </p>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-foreground-secondary">
                    <input type="checkbox" checked={showFormulas} onChange={(e) => setShowFormulas(e.target.checked)} />
                    Show formulas
                  </label>
                  <Button variant="secondary" size="sm" disabled={rows.page <= 1 || rowsLoading} onClick={() => setPage(rows.page - 1)}>
                    Previous
                  </Button>
                  <Button variant="secondary" size="sm" disabled={rows.page >= rows.pageCount || rowsLoading} onClick={() => setPage(rows.page + 1)}>
                    Next
                  </Button>
                </div>
              </div>
              <div className="max-h-[28rem] overflow-auto border border-line rounded-lg bg-white">
                <table className="text-xs border-collapse">
                  <thead className="bg-surface-soft sticky top-0 z-10">
                    <tr>
                      <th className="text-right px-2 py-1.5 font-medium text-foreground-secondary sticky left-0 bg-surface-soft">Row</th>
                      <th className="text-left px-2 py-1.5 font-medium text-foreground-secondary">Kind</th>
                      {columns.map(([col, letter]) => (
                        <th key={col} className="text-left px-2 py-1.5 font-medium text-foreground-secondary border-l border-line">
                          {letter}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.rows.map((r) => {
                      const byCol = new Map(r.cells.map((c) => [c.col_index, c]));
                      const role = ROLE_STYLE[r.role] ?? { label: r.role, variant: "neutral" as BadgeVariant };
                      return (
                        <tr key={r.row} className="border-t border-line align-top">
                          <td className="px-2 py-1 text-right tabular-nums text-foreground-muted sticky left-0 bg-white">{r.row}</td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            <Badge variant={role.variant}>
                              {role.label}
                              {r.table !== null ? ` · T${r.table}` : ""}
                            </Badge>
                          </td>
                          {columns.map(([col]) => {
                            const c = byCol.get(col);
                            if (!c) return <td key={col} className="px-2 py-1 border-l border-line" />;
                            const shown = c.display_text ?? storedValue(c);
                            return (
                              <td key={col} className="px-2 py-1 border-l border-line max-w-[240px]" title={cellTitle(c)}>
                                {c.header && r.role !== "header" && <span className="block text-[10px] leading-tight text-foreground-muted truncate">{c.header}</span>}
                                <span className={`block truncate ${r.role === "header" || r.role === "header-band" ? "font-medium text-foreground" : "text-foreground"}`}>
                                  {c.formula && <span className="text-brand mr-0.5">ƒ</span>}
                                  {showFormulas && c.formula ? `=${c.formula} → ${shown || "(no cached value)"}` : shown}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-foreground-muted">
                Each cell shows its value as displayed in Excel and the header it sits under; hover a cell for its address, stored value,
                type, formula and number format. Row numbers are the sheet&apos;s own — gaps are blank rows.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
