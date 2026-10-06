"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import Button from "@/components/ui/Button";
import { errorMessage, readApiJson } from "@/lib/apiClient";

/**
 * "Download updated Excel" — the project's workbook with the latest
 * approved progress, at any point during the project (see
 * /api/workflow/excel-export). What it contains (departments, amounts)
 * is decided server-side from the signed-in user's role; this button
 * only asks for it. Shared by the Contractor, Subcontractor and Admin
 * screens; a department-scoped page (Subcontractor) also passes its
 * current department, which the server applies as a further narrowing.
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

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ projectId });
      if (departmentId) qs.set("departmentId", departmentId);
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
      <Button variant="secondary" size="sm" onClick={download} disabled={busy} title="Download the project's Excel with the latest updates you can see">
        <Download className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        {busy ? "Preparing…" : "Download updated Excel"}
      </Button>
      {error && <span className="text-xs text-error">{error}</span>}
    </span>
  );
}
