"use client";

import { useId, useRef, useState } from "react";
import { Download } from "lucide-react";
import Button from "@/components/ui/Button";
import { errorMessage, readApiJson } from "@/lib/apiClient";
import { EXPORT_LATEST_HEADERS, type ExportLatestColumnKey } from "@/lib/excelExportColumns";

/** The additional columns the export appends after the sheet's standard
 * columns, in the order it appends them (lib/excelExport.ts). */
const ADDITIONAL_COLUMNS = Object.entries(EXPORT_LATEST_HEADERS) as [ExportLatestColumnKey, string][];
const ALL_KEYS = ADDITIONAL_COLUMNS.map(([key]) => key);

/**
 * "Download updated Excel" — the project's workbook with the latest
 * approved progress, at any point during the project (see
 * /api/workflow/excel-export). What it contains (departments, amounts)
 * is decided server-side from the signed-in user's role; this button
 * only asks for it. Shared by the Contractor, Subcontractor and Admin
 * screens; a department-scoped page (Subcontractor) also passes its
 * current department, which the server applies as a further narrowing.
 * Clicking it first asks which additional columns (appended after the
 * standard sheet columns) to include — all of them, or a chosen few;
 * the standard columns are always included, and Cancel downloads nothing.
 */
export default function ExcelDownloadButton({
  projectId,
  departmentId,
  className = "",
}: {
  projectId: string;
  departmentId?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [selected, setSelected] = useState<ExportLatestColumnKey[]>(ALL_KEYS);

  function openDialog() {
    setSelected(ALL_KEYS);
    dialogRef.current?.showModal();
  }

  function toggle(key: ExportLatestColumnKey) {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  /** `columns` = the additional columns to include; omitted = all of
   * them (the request is then exactly the one this button always sent). */
  async function download(columns?: ExportLatestColumnKey[]) {
    dialogRef.current?.close();
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ projectId });
      if (departmentId) qs.set("departmentId", departmentId);
      if (columns) qs.set("columns", ALL_KEYS.filter((key) => columns.includes(key)).join(","));
      const res = await fetch(`/api/workflow/excel-export?${qs.toString()}`);
      if (!res.ok) {
        await readApiJson(res, "The Excel file couldn't be prepared. Please try again.");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
      const fileName = encoded ? decodeURIComponent(encoded) : "project-updated.xlsx";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(errorMessage(err, "The Excel file couldn't be prepared. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={`inline-flex flex-col items-start gap-1 ${className}`}>
      <Button variant="secondary" size="sm" onClick={openDialog} disabled={busy} title="Download the project's Excel with the latest updates you can see">
        <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        {busy ? "Preparing…" : "Download updated Excel"}
      </Button>
      {error && <span className="text-xs text-error">{error}</span>}
      {/* Closing it any way (Cancel, Esc, a click outside) downloads nothing. */}
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-line bg-surface p-0 text-left shadow-lg backdrop:bg-black/50"
      >
        <div className="space-y-4 p-5">
          <div className="space-y-1">
            <h3 id={titleId} className="text-sm font-semibold text-foreground">
              Download updated Excel
            </h3>
            <p className="text-sm text-foreground-secondary">
              The standard sheet columns (through Column K) are always included. Do you want to include the
              following additional columns?
            </p>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
                Additional columns (after the standard columns)
              </p>
              <button
                type="button"
                onClick={() => setSelected(selected.length === ALL_KEYS.length ? [] : ALL_KEYS)}
                className="text-xs font-medium text-brand hover:underline"
              >
                {selected.length === ALL_KEYS.length ? "Clear all" : "Select all"}
              </button>
            </div>
            <div className="space-y-1">
              {ADDITIONAL_COLUMNS.map(([key, header]) => (
                <label key={key} className="flex items-center gap-2 text-sm text-foreground-secondary">
                  <input type="checkbox" checked={selected.includes(key)} onChange={() => toggle(key)} />
                  {header}
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => dialogRef.current?.close()}>
              Cancel
            </Button>
            <Button variant="secondary" size="sm" onClick={() => download(selected)}>
              {selected.length === 0 ? "Standard columns only" : `Download selected (${selected.length})`}
            </Button>
            <Button size="sm" onClick={() => download()}>
              Include All
            </Button>
          </div>
        </div>
      </dialog>
    </span>
  );
}
