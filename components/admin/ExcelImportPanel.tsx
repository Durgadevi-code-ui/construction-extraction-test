"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatQuantity } from "@/lib/format";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";

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
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} className="shrink-0">
        Import Excel
      </Button>
    );
  }

  return (
    <div className="mt-2 bg-surface-soft border border-line rounded-lg p-4 space-y-3 text-sm">
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
          <p className="text-xs text-foreground-secondary">
            Reads every sheet, matches Department / Work Item / Quantity / Unit / Amount columns
            automatically (column order and naming don&apos;t need to match exactly). Nothing is
            saved until you confirm below.
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

              <div className="max-h-56 overflow-x-auto overflow-y-auto border border-line rounded-lg bg-white">
                <table className="w-full min-w-[560px] text-xs">
                  <thead className="bg-surface-soft sticky top-0">
                    <tr>
                      <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Dept</th>
                      <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Item #</th>
                      <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Description</th>
                      <th className="text-right px-2.5 py-1.5 font-medium text-foreground-secondary">Qty</th>
                      <th className="text-left px-2.5 py-1.5 font-medium text-foreground-secondary">Unit</th>
                      <th className="text-right px-2.5 py-1.5 font-medium text-foreground-secondary">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 200).map((r, i) => (
                      <tr key={i} className="border-t border-line hover:bg-surface-hover transition-colors duration-150">
                        <td className="px-2.5 py-1.5 text-foreground-secondary">{r.department}</td>
                        <td className="px-2.5 py-1.5 text-foreground">{r.workItemNo ?? "—"}</td>
                        <td className="px-2.5 py-1.5 text-foreground">{r.description}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground">
                          {r.plannedQuantity !== null ? formatQuantity(r.plannedQuantity) : "—"}
                        </td>
                        <td className="px-2.5 py-1.5 text-foreground-secondary">{r.unitOfMeasure ?? "—"}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums text-foreground">
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
                <div className="bg-warning-soft border border-warning-border rounded-lg p-2.5 text-xs text-warning space-y-1">
                  <p className="font-medium flex items-center gap-1.5">
                    <Badge variant="warning">{preview.issues.length} row(s) skipped</Badge>
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
                  {busy ? "Importing…" : `Confirm Import (${preview.workItemCount} work items)`}
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
        <div className="bg-success-soft border border-success-border rounded-lg p-3 text-xs text-success space-y-1.5">
          <p className="font-medium">Import complete.</p>
          <p>
            Departments activated: {result.departmentsActivated} ({result.departmentsCreated} new)
          </p>
          <p>
            Work items created: {result.workItemsCreated}, updated: {result.workItemsUpdated}
          </p>
          {result.issues.length > 0 && <p>{result.issues.length} row(s) were skipped — see above rules.</p>}
          <button onClick={reset} className="text-xs text-success underline hover:opacity-80 transition-opacity duration-150">
            Import another file
          </button>
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
