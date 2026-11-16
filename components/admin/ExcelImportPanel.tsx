"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatQuantity } from "@/lib/format";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import WorkbookExtractionViewer from "./WorkbookExtractionViewer";

type ParsedRow = {
  sourceRow: number;
  sourceSheet: string;
  department: string;
  workItemNo: string | null;
  description: string;
  descriptionInferred: boolean;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  scheduledValue: number | null;
  csiLineCode: string | null;
  /** Columns in the file that didn't map to a standard field — kept and
   * imported under work_items.additional_fields, shown here so nothing
   * from the file looks silently dropped. */
  additionalFields: Record<string, string | number> | null;
};

type ParseIssue = { sourceRow: number; sourceSheet: string; message: string };

/** Completeness report (lib/excelImport.ts ExtractionReport, the fields shown here). */
type Extraction = {
  complete: boolean;
  sheetsDiscovered: number;
  sheetsRead: number;
  populatedRows: number;
  rowsMapped: number;
  rowsNotMapped: number;
  problems: string[];
  sheets: {
    name: string;
    visibility: string;
    status: string;
    mapping: string;
    populatedRows: number;
    rowsMapped: number;
    unmappedRows: { row: number; kind: string; reason: string; text: string }[];
  }[];
};

const ROW_KIND_LABELS: Record<string, string> = {
  info: "Info",
  header: "Header",
  division: "Division",
  heading: "Heading",
  total: "Total",
  "repeated-header": "Header",
  note: "Note",
  unmapped: "Not mapped",
};

const SHEET_MAPPING_LABELS: Record<string, string> = {
  mapped: "work items read",
  "no-work-items": "table found, no work items",
  "not-a-work-item-table": "no work-item table — kept, not mapped",
  skipped: "nothing to map",
  error: "mapping failed",
};

const UNMAPPED_ROWS_SHOWN = 500;

/** Layer 1 summary (lib/workbookStructure.ts extractionSummary): every
 * sheet's own tables and column headers — no cell contents. */
type WorkbookSummary = {
  totals: { sheets: number; tables: number; rows: number; cells: number; formulaCells: number };
  sheets: {
    name: string;
    visibility: string;
    status: string;
    populatedRows: number;
    populatedCells: number;
    rowsByRole: Record<string, number>;
    tables: { index: number; headerRow: number; rows: string; columns: string[]; dataRows: number; totalRows: number }[];
  }[];
};

type PreviewResponse = {
  preview: true;
  workbook?: WorkbookSummary;
  /** Set when no sheet has a work-item table (the workbook can still be stored). */
  notice?: string;
  sheetsScanned: string[];
  /** How each sheet's columns were understood (lib/excelImport.ts). */
  columnMappings?: { sheet: string; headerRow: number; columns: { header: string; field: string }[] }[];
  departments: string[];
  workItemCount: number;
  rows: ParsedRow[];
  issues: ParseIssue[];
  extraction?: Extraction;
};

type CommitResponse = {
  preview: false;
  importId?: string;
  extractionStored?: boolean;
  workbook?: WorkbookSummary;
  lineItemsAdjusted?: { sheet: string; row: number; from: string; to: string }[];
  departmentsActivated: number;
  departmentsCreated: number;
  workItemsCreated: number;
  workItemsUpdated: number;
  issues: ParseIssue[];
  extraction?: Extraction;
};

/**
 * Contractor/Admin project-file upload: pick a file, see exactly what
 * was extracted (departments, work item count, per-row issues) before
 * anything is written, then confirm to commit. Two round trips to the
 * same API route (dry-run, then commit — see
 * app/api/admin/projects/import/route.ts) rather than one blind write,
 * per the "present the extracted result before destructive database
 * changes" requirement.
 */
export default function ExcelImportPanel({ projectId }: { projectId: string }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [result, setResult] = useState<CommitResponse | null>(null);
  /** Browsing the stored extraction of earlier imports (no file picked). */
  const [browsing, setBrowsing] = useState(false);

  function reset() {
    setBrowsing(false);
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleParse() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("projectId", projectId);
      formData.append("file", file);
      const res = await fetch("/api/admin/projects/import", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to read file.");
      setPreview(data as PreviewResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read file.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("projectId", projectId);
      formData.append("file", file);
      formData.append("commit", "1");
      const res = await fetch("/api/admin/projects/import", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed.");
      setPreview(null);
      setResult(data as CommitResponse);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="shrink-0">
        Import Excel
      </Button>
    );
  }

  const hasAdditionalFields =
    preview?.rows.some((r) => r.additionalFields && Object.keys(r.additionalFields).length > 0) ?? false;
  const extraction = preview?.extraction;
  const unmappedRows =
    extraction?.sheets.flatMap((s) => s.unmappedRows.map((row) => ({ ...row, sheet: s.name }))) ?? [];

  return (
    // order-last + w-full: inside the project's Excel actions row the
    // opened panel drops to its own line below the buttons.
    <div className="order-last w-full mt-1 bg-surface-soft border border-line rounded-lg p-4 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-foreground">Import Project File</h4>
        <button
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-xs text-foreground-secondary hover:text-foreground hover:underline transition-colors duration-150"
        >
          Close
        </button>
      </div>

      {!result && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setResult(null);
              setError(null);
            }}
            className="block w-full text-xs text-foreground-secondary file:mr-3 file:rounded-lg file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground-secondary hover:file:bg-surface-hover file:transition-colors file:duration-150"
          />
          {!preview && (
            <button
              onClick={() => setBrowsing((b) => !b)}
              className="text-xs text-foreground hover:underline transition-colors duration-150"
            >
              {browsing ? "Hide imported workbook data" : "View imported workbook data (every sheet, row and cell stored)"}
            </button>
          )}
          {browsing && !preview && <WorkbookExtractionViewer projectId={projectId} />}
          <p className="text-xs text-foreground-secondary">
            Reads every sheet, every table and every populated cell with the sheet&apos;s own column
            headers, and stores all of it with the original file. Where a table has work-item columns
            (department, item number, description, quantity, unit, amount — names and order don&apos;t
            need to match), those rows also become work items; their other columns are kept with each
            item. Nothing is saved until you confirm below.
          </p>

          {!preview ? (
            <Button size="sm" onClick={handleParse} disabled={!file || busy}>
              {busy ? "Reading…" : "Read File"}
            </Button>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-white border border-line rounded-lg p-2.5">
                  <p className="text-xs text-foreground-muted">Sheets scanned</p>
                  <p className="mt-0.5 text-sm font-medium text-foreground truncate" title={preview.sheetsScanned.join(", ")}>
                    {preview.sheetsScanned.join(", ") || "—"}
                  </p>
                </div>
                <div className="bg-white border border-line rounded-lg p-2.5">
                  <p className="text-xs text-foreground-muted">Departments found</p>
                  <p className="mt-0.5 text-sm font-medium text-foreground truncate" title={preview.departments.join(", ")}>
                    {preview.departments.join(", ") || "—"}
                  </p>
                </div>
                <div className="bg-white border border-line rounded-lg p-2.5">
                  <p className="text-xs text-foreground-muted">Work items found</p>
                  <p className="mt-0.5 text-sm font-medium text-foreground">{preview.workItemCount}</p>
                </div>
              </div>

              {preview.columnMappings && preview.columnMappings.length > 0 && (
                <div className="text-xs text-foreground-secondary space-y-0.5">
                  {preview.columnMappings.map((m) => (
                    <p key={`${m.sheet}-${m.headerRow}`}>
                      <span className="font-medium text-foreground">{m.sheet}</span> (header row {m.headerRow}):{" "}
                      {m.columns.map((c) => `${c.header} → ${c.field}`).join(" · ")}
                    </p>
                  ))}
                </div>
              )}

              {preview.notice && (
                <p className="text-xs text-warning bg-warning-soft border border-warning-border rounded-lg p-2.5">{preview.notice}</p>
              )}

              {preview.workbook && (
                <div className="text-xs text-foreground-secondary space-y-1 bg-white border border-line rounded-lg p-2.5">
                  <p className="font-medium text-foreground">
                    Complete extraction — {preview.workbook.totals.sheets} sheet(s), {preview.workbook.totals.tables} table(s),{" "}
                    {preview.workbook.totals.rows} row(s), {preview.workbook.totals.cells} cell(s); every populated cell is
                    kept with its sheet, row and column header and stored with the import.
                  </p>
                  {preview.workbook.sheets.map((s) => (
                    <div key={s.name}>
                      <p>
                        <span className="font-medium text-foreground">{s.name}</span>
                        {s.visibility !== "visible" ? ` (${s.visibility})` : ""}: {s.populatedRows} row(s), {s.populatedCells} cell(s)
                        {Object.keys(s.rowsByRole).length > 0 &&
                          ` — ${Object.entries(s.rowsByRole)
                            .map(([role, n]) => `${n} ${role}`)
                            .join(", ")}`}
                      </p>
                      {s.tables.map((t) => (
                        <p key={t.index} className="pl-3">
                          Table {t.index} (rows {t.rows}, {t.dataRows} data row(s)): {t.columns.join(" · ")}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {extraction && (
                <div className="text-xs text-foreground-secondary space-y-1.5">
                  <p>
                    Read {extraction.sheetsRead} of {extraction.sheetsDiscovered} sheet(s) ·{" "}
                    {extraction.populatedRows} populated rows · {extraction.rowsMapped} work items ·{" "}
                    {extraction.rowsNotMapped} other rows kept but not imported as work items
                  </p>
                  {!extraction.complete && (
                    <div className="bg-error-soft border border-error-border rounded-lg px-2.5 py-1.5 text-error space-y-0.5">
                      <p className="font-medium">Extraction incomplete — part of this workbook could not be read.</p>
                      <ul className="list-disc list-inside">
                        {extraction.problems.map((p, i) => (
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <details>
                    <summary className="cursor-pointer text-foreground hover:underline">
                      Sheets and rows not imported as work items ({extraction.rowsNotMapped})
                    </summary>
                    <div className="mt-1.5 space-y-1.5">
                      <ul className="space-y-0.5">
                        {extraction.sheets.map((s) => (
                          <li key={s.name}>
                            <span className="font-medium text-foreground">{s.name}</span>
                            {s.visibility !== "visible" && " (hidden)"}: {s.populatedRows} rows, {s.rowsMapped} work items —{" "}
                            {s.status === "ok" ? (SHEET_MAPPING_LABELS[s.mapping] ?? s.mapping) : s.status}
                          </li>
                        ))}
                      </ul>
                      {unmappedRows.length > 0 && (
                        <div className="max-h-48 overflow-x-auto overflow-y-auto border border-line rounded-lg bg-white">
                          <table className="w-full min-w-[560px] text-xs">
                            <thead className="bg-surface-soft sticky top-0">
                              <tr>
                                <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Sheet</th>
                                <th className="text-right px-2.5 py-1.5 font-medium text-foreground-secondary">Row</th>
                                <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Read as</th>
                                <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Content</th>
                                <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Why not a work item</th>
                              </tr>
                            </thead>
                            <tbody>
                              {unmappedRows.slice(0, UNMAPPED_ROWS_SHOWN).map((r) => (
                                <tr key={`${r.sheet}:${r.row}`} className="border-t border-line">
                                  <td className="px-2.5 py-1.5 text-foreground-secondary">{r.sheet}</td>
                                  <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground-secondary">{r.row}</td>
                                  <td className="px-2.5 py-1.5 text-foreground-secondary">{ROW_KIND_LABELS[r.kind] ?? r.kind}</td>
                                  <td className="px-2.5 py-1.5 text-foreground truncate max-w-[220px]" title={r.text}>
                                    {r.text}
                                  </td>
                                  <td className="px-2.5 py-1.5 text-foreground-secondary">{r.reason}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {unmappedRows.length > UNMAPPED_ROWS_SHOWN && (
                        <p className="text-foreground-muted">
                          Showing first {UNMAPPED_ROWS_SHOWN} of {unmappedRows.length} rows.
                        </p>
                      )}
                    </div>
                  </details>
                </div>
              )}

              <div className="max-h-56 overflow-x-auto overflow-y-auto border border-line rounded-lg bg-white">
                <table className="w-full min-w-[560px] text-xs">
                  <thead className="bg-surface-soft sticky top-0">
                    <tr>
                      <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Dept</th>
                      <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Item #</th>
                      <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">CSI Code</th>
                      <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Description</th>
                      <th className="text-right px-2.5 py-1.5 font-medium text-foreground-secondary">Qty</th>
                      <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Unit</th>
                      <th className="text-right px-2.5 py-1.5 font-medium text-foreground-secondary">Value</th>
                      {hasAdditionalFields && (
                        <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Extra columns</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 200).map((r, i) => (
                      <tr key={i} className="border-t border-line hover:bg-surface-hover transition-colors duration-150">
                        <td className="px-2.5 py-1.5 text-foreground-secondary">{r.department}</td>
                        <td className="px-2.5 py-1.5 text-foreground">{r.workItemNo ?? "—"}</td>
                        <td className="px-2.5 py-1.5 text-foreground-secondary">{r.csiLineCode ?? "—"}</td>
                        <td className="px-2.5 py-1.5 text-foreground">
                          {r.description}
                          {r.descriptionInferred && (
                            <span className="ml-1 text-foreground-muted italic" title="No description column value — inferred from item/CSI code.">
                              (inferred)
                            </span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground">
                          {r.plannedQuantity !== null ? formatQuantity(r.plannedQuantity) : "—"}
                        </td>
                        <td className="px-2.5 py-1.5 text-foreground-secondary">{r.unitOfMeasure ?? "—"}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground">
                          {r.scheduledValue !== null
                            ? `$${r.scheduledValue.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                            : "—"}
                        </td>
                        {hasAdditionalFields && (
                          <td
                            className="px-2.5 py-1.5 text-foreground-secondary truncate max-w-[220px]"
                            title={
                              r.additionalFields
                                ? Object.entries(r.additionalFields)
                                    .map(([k, v]) => `${k}: ${v}`)
                                    .join("\n")
                                : undefined
                            }
                          >
                            {r.additionalFields
                              ? Object.entries(r.additionalFields)
                                  .map(([k, v]) => `${k}: ${v}`)
                                  .join(", ")
                              : "—"}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.length > 200 && (
                <p className="text-xs text-foreground-muted">
                  Showing first 200 of {preview.rows.length} rows.
                </p>
              )}

              {preview.issues.length > 0 && (
                <div className="bg-warning-soft border border-warning-border rounded-lg p-2.5 text-xs text-warning space-y-1">
                  <p className="font-medium flex items-center gap-1.5">
                    <Badge variant="warning">{preview.issues.length} issue(s)</Badge>
                  </p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {preview.issues.slice(0, 10).map((issue, i) => (
                      <li key={i}>
                        {issue.sourceSheet} row {issue.sourceRow}: {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex gap-2">
                <Button size="sm" onClick={handleConfirm} disabled={busy}>
                  {busy
                    ? "Importing…"
                    : preview.workItemCount > 0
                      ? `Confirm Import (${preview.workItemCount} work items)`
                      : "Store workbook (no work items)"}
                </Button>
                <Button variant="secondary" size="sm" onClick={reset}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {result && (
        <div className="space-y-3">
        <div
          className={`rounded-lg p-3 text-xs space-y-1.5 border ${
            result.extractionStored && result.extraction?.complete !== false
              ? "bg-success-soft border-success-border text-success"
              : "bg-warning-soft border-warning-border text-warning"
          }`}
        >
          <p className="font-medium">
            {result.extraction && !result.extraction.complete
              ? "Import finished, but the workbook was not read completely:"
              : "Import complete."}
          </p>
          {result.extraction && !result.extraction.complete && (
            <ul className="list-disc list-inside text-error">
              {result.extraction.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          <p>
            Departments activated: {result.departmentsActivated} ({result.departmentsCreated} new)
          </p>
          <p>
            Work items created: {result.workItemsCreated}, updated: {result.workItemsUpdated}
          </p>
          {result.extractionStored && result.workbook && (
            <p>
              Workbook and complete extraction stored ({result.workbook.totals.sheets} sheet(s), {result.workbook.totals.cells}{" "}
              cell(s)).
            </p>
          )}
          {result.lineItemsAdjusted && result.lineItemsAdjusted.length > 0 && (
            <div>
              <p>Kept as separate work items under a derived item number (the file&apos;s number is kept with each):</p>
              <ul className="list-disc list-inside">
                {result.lineItemsAdjusted.map((a) => (
                  <li key={`${a.sheet}-${a.row}`}>
                    {a.sheet} row {a.row}: {a.from} → {a.to}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.issues.length > 0 && <p>{result.issues.length} issue(s) were reported while reading the file.</p>}
          <button onClick={reset} className="text-xs underline hover:opacity-80 transition-opacity duration-150">
            Import another file
          </button>
        </div>
        {result.importId && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">Extracted workbook data, as stored</p>
            <WorkbookExtractionViewer projectId={projectId} importId={result.importId} />
          </div>
        )}
        </div>
      )}

      {error && (
        <p className="text-xs text-error bg-error-soft border border-error-border rounded-lg px-2.5 py-1.5">
          {error}
        </p>
      )}
    </div>
  );
}
