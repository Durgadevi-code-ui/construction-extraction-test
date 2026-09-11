"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatQuantity } from "@/lib/format";

type ParsedRow = {
  sourceRow: number;
  sourceSheet: string;
  department: string;
  workItemNo: string | null;
  description: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  scheduledValue: number | null;
};

type ParseIssue = { sourceRow: number; sourceSheet: string; message: string };

type PreviewResponse = {
  preview: true;
  sheetsScanned: string[];
  departments: string[];
  workItemCount: number;
  rows: ParsedRow[];
  issues: ParseIssue[];
};

type CommitResponse = {
  preview: false;
  departmentsActivated: number;
  departmentsCreated: number;
  workItemsCreated: number;
  workItemsUpdated: number;
  issues: ParseIssue[];
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

  function reset() {
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
      <button
        onClick={() => setOpen(true)}
        className="text-xs px-2 py-1 rounded border border-line text-foreground-secondary hover:bg-surface-soft shrink-0"
      >
        Import Excel
      </button>
    );
  }

  return (
    <div className="mt-2 bg-surface-soft rounded p-3 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-foreground">Import Project File</h4>
        <button
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-xs text-foreground-secondary hover:underline"
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
            className="block w-full text-xs"
          />
          <p className="text-xs text-foreground-secondary">
            Reads every sheet, matches Department / Work Item / Quantity / Unit / Amount columns
            automatically (column order and naming don&apos;t need to match exactly). Nothing is
            saved until you confirm below.
          </p>

          {!preview ? (
            <button
              onClick={handleParse}
              disabled={!file || busy}
              className="text-xs px-3 py-1.5 rounded bg-brand text-white disabled:opacity-50"
            >
              {busy ? "Reading…" : "Read File"}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="bg-white border border-line rounded p-2 space-y-1">
                <p>
                  <span className="text-foreground-secondary">Sheets scanned:</span>{" "}
                  {preview.sheetsScanned.join(", ") || "—"}
                </p>
                <p>
                  <span className="text-foreground-secondary">Departments found:</span>{" "}
                  <span className="font-medium">{preview.departments.join(", ")}</span>
                </p>
                <p>
                  <span className="text-foreground-secondary">Work items found:</span>{" "}
                  <span className="font-medium">{preview.workItemCount}</span>
                </p>
              </div>

              <div className="max-h-56 overflow-x-auto overflow-y-auto border border-line rounded bg-white">
                <table className="w-full min-w-[560px] text-xs">
                  <thead className="bg-gray-100 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-1">Dept</th>
                      <th className="text-left px-2 py-1">Item #</th>
                      <th className="text-left px-2 py-1">Description</th>
                      <th className="text-left px-2 py-1">Qty</th>
                      <th className="text-left px-2 py-1">Unit</th>
                      <th className="text-left px-2 py-1">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 200).map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="px-2 py-1">{r.department}</td>
                        <td className="px-2 py-1">{r.workItemNo ?? "—"}</td>
                        <td className="px-2 py-1">{r.description}</td>
                        <td className="px-2 py-1">
                          {r.plannedQuantity !== null ? formatQuantity(r.plannedQuantity) : "—"}
                        </td>
                        <td className="px-2 py-1">{r.unitOfMeasure ?? "—"}</td>
                        <td className="px-2 py-1">
                          {r.scheduledValue !== null
                            ? `$${r.scheduledValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                            : "—"}
                        </td>
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
                <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-800">
                  <p className="font-medium">{preview.issues.length} row(s) skipped:</p>
                  <ul className="list-disc list-inside">
                    {preview.issues.slice(0, 10).map((issue, i) => (
                      <li key={i}>
                        {issue.sourceSheet} row {issue.sourceRow}: {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleConfirm}
                  disabled={busy}
                  className="text-xs px-3 py-1.5 rounded bg-green-600 text-white disabled:opacity-50"
                >
                  {busy ? "Importing…" : `Confirm Import (${preview.workItemCount} work items)`}
                </button>
                <button
                  onClick={reset}
                  className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {result && (
        <div className="bg-green-50 border border-green-200 rounded p-2 text-xs text-green-800 space-y-1">
          <p className="font-medium">Import complete.</p>
          <p>
            Departments activated: {result.departmentsActivated} ({result.departmentsCreated} new)
          </p>
          <p>
            Work items created: {result.workItemsCreated}, updated: {result.workItemsUpdated}
          </p>
          {result.issues.length > 0 && <p>{result.issues.length} row(s) were skipped — see above rules.</p>}
          <button onClick={reset} className="text-xs text-green-700 underline">
            Import another file
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
