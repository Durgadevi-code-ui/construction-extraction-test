import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/apiErrors";
import { getSupabaseClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/session";
import { RATE_LIMITS, rateLimitResponse } from "@/lib/rateLimit";
import { assertAdminOrDelegated } from "@/lib/delegation";
import { parseProjectWorkbook, distinctDepartments } from "@/lib/excelImport";
import { upsertWorkItemFromImport } from "@/lib/admin";
import { saveProjectImport } from "@/lib/projectDocuments";
import { extractionSummary } from "@/lib/workbookStructure";
import { hasWorkbookExtension, looksLikeWorkbook } from "@/lib/fileSignature";
import { WorkbookTooLargeError } from "@/lib/workbookLimits";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB — generous for a spreadsheet, small enough to reject a mistaken upload of the wrong file type.

/**
 * Project file (Excel) ingestion — the Contractor/Admin upload flow
 * (see AGENTS.md master prompt sections 4-8). Same
 * PROJECT_MANAGEMENT authorization boundary as editing the project
 * itself (app/api/admin/projects/route.ts PATCH): Admin unconditionally,
 * or a Contractor holding an active PROJECT_MANAGEMENT delegation for
 * this exact project. A caller cannot import into a project outside
 * their own authorized scope, however `projectId` is supplied.
 *
 * Two-step by design ("present the extracted result before destructive
 * database changes" — spec section 4):
 *   - dryRun=1 (or omitted `commit`): parses and returns a preview only.
 *     Nothing is written.
 *   - commit=1: re-parses the same file and actually creates/updates
 *     departments and work items. The client is expected to call
 *     dry-run first, show the preview, then re-submit the same file
 *     with commit=1 once the user confirms.
 */
export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const limited = await rateLimitResponse(RATE_LIMITS.workbookImport, currentUser.userId);
  if (limited) return limited;

  const supabase = getSupabaseClient();
  const actorUserId = currentUser.userId;

  try {
    const formData = await request.formData();
    const projectId = formData.get("projectId");
    const commit = formData.get("commit") === "1";
    const file = formData.get("file");

    if (typeof projectId !== "string" || !projectId) {
      return NextResponse.json({ error: "projectId is required." }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required." }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "File is too large (max 10MB)." }, { status: 400 });
    }

    await assertAdminOrDelegated(supabase, {
      actorUserId,
      permission: "PROJECT_MANAGEMENT",
      projectId,
    });

    const fileBytes = await file.arrayBuffer();
    // Same file types the picker offers, checked by name AND content
    // (never by the browser-supplied MIME type) before the parser runs.
    if (!hasWorkbookExtension(file.name) || !looksLikeWorkbook(new Uint8Array(fileBytes))) {
      return NextResponse.json(
        { error: "Could not read this file. Upload a valid .xlsx/.xls/.csv workbook." },
        { status: 400 }
      );
    }
    let parsed;
    try {
      parsed = parseProjectWorkbook(fileBytes, file.name);
    } catch (err) {
      // Over the cell limit (all sheets combined): refused as a whole, for
      // preview and commit alike, before anything is stored.
      if (err instanceof WorkbookTooLargeError) {
        return NextResponse.json(
          { error: err.message, cellCount: err.cellCount, cellLimit: err.cellLimit },
          { status: 413 }
        );
      }
      return NextResponse.json(
        { error: "Could not read this file. Upload a valid .xlsx/.xls/.csv workbook." },
        { status: 400 }
      );
    }

    // Per-sheet / per-row completeness report. The raw cell-level
    // extraction (parsed.raw) is not sent: it can be as large as the
    // workbook itself, and the uploaded file is kept as the source of
    // record on commit.
    const { extraction } = parsed;
    // Layer 1 summary (sheets, tables, their own column headers, row
    // roles, cell totals) — the complete extraction itself is stored on
    // commit and served by ./extraction/route.ts.
    const workbook = extractionSummary(parsed.complete);

    // A workbook with no work-item table is still fully extracted and can
    // still be imported (stored) — it just creates no work items. Say what
    // was read, not just which headings were expected.
    const noWorkItemsNote =
      parsed.rows.length === 0
        ? [
            `The workbook was read (${extraction.sheetsDiscovered} sheet${extraction.sheetsDiscovered === 1 ? "" : "s"}) and all of its data is extracted, but no sheet has a work-item table (a work description column with rows of work items under it), so importing it stores the workbook and its data without creating work items.`,
            ...parsed.diagnostics,
            ...extraction.problems,
          ].join(" ")
        : null;

    const departments = distinctDepartments(parsed.rows);

    if (!commit) {
      return NextResponse.json({
        preview: true,
        sheetsScanned: parsed.sheetsScanned,
        columnMappings: parsed.columnMappings,
        departments,
        workItemCount: parsed.rows.length,
        rows: parsed.rows,
        issues: parsed.issues,
        diagnostics: parsed.diagnostics,
        extraction,
        workbook,
        ...(noWorkItemsNote ? { notice: noWorkItemsNote } : {}),
      });
    }

    // The source of record first: the original file and the complete
    // extraction. If either cannot be stored, nothing is written at all.
    let stored;
    try {
      stored = await saveProjectImport(projectId, { name: file.name, bytes: fileBytes, contentType: file.type }, parsed.complete, actorUserId, parsed.columnMappings);
    } catch (err) {
      console.error("Import refused — source of record not stored:", err instanceof Error ? err.message : err);
      return NextResponse.json(
        { error: "The workbook could not be stored, so nothing was imported. Please try again." },
        { status: 503 }
      );
    }
    const tableOf = new Map(
      parsed.complete.sheets.flatMap((s) => s.rows.map((r) => [`${s.name}\u0000${r.row}`, r.table ?? null] as const))
    );

    // Department resolution happens inside upsertWorkItemFromImport now,
    // lazily and per-row (see its doc comment) — not pre-resolved here —
    // so a row whose imported department name is only a presentational
    // grouping (e.g. an AIA G703 "DIVISION CO — CHANGE ORDERS" section
    // whose items already exist under their real trade department) never
    // forces a department to be created just because its name appeared
    // in the file.
    let departmentsCreated = 0;
    let workItemsCreated = 0;
    let workItemsUpdated = 0;
    // Work items written by this import: each source row gets its own, so
    // rows are never merged (see upsertWorkItemFromImport).
    const claimed = new Set<string>();
    const lineItemsAdjusted: { sheet: string; row: number; from: string; to: string }[] = [];
    let written = 0;
    try {
      for (const row of parsed.rows) {
        const result = await upsertWorkItemFromImport(supabase, {
          projectId,
          departmentName: row.department,
          lineItemNo: row.workItemNo,
          description: row.description,
          plannedQuantity: row.plannedQuantity,
          unitOfMeasure: row.unitOfMeasure,
          scheduledValue: row.scheduledValue,
          csiLineCode: row.csiLineCode,
          additionalFields: row.additionalFields,
          source: {
            importId: stored.importId,
            sheet: row.sourceSheet,
            row: row.sourceRow,
            table: tableOf.get(`${row.sourceSheet}\u0000${row.sourceRow}`) ?? null,
            lineItemNo: row.workItemNo,
          },
          claimed,
        });
        written++;
        if (result.wasCreated) workItemsCreated++;
        else workItemsUpdated++;
        if (result.departmentWasCreated) departmentsCreated++;
        if (result.lineItemAdjusted) {
          lineItemsAdjusted.push({ sheet: row.sourceSheet, row: row.sourceRow, from: row.workItemNo ?? "", to: result.lineItemAdjusted });
        }
      }
    } catch (err) {
      // The workbook and its complete extraction are already stored; say
      // exactly how far the work-item mapping got.
      console.error("Import stopped part-way:", err instanceof Error ? err.message : err);
      return NextResponse.json(
        {
          error: `The workbook and its complete extraction were stored (import ${stored.importId}), but only ${written} of ${parsed.rows.length} work items were saved before an error. Re-import the same file to finish — saved items are updated, not duplicated.`,
          importId: stored.importId,
          workItemsWritten: written,
          workItemsTotal: parsed.rows.length,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      preview: false,
      importId: stored.importId,
      departmentsActivated: departments.length,
      departmentsCreated,
      workItemsCreated,
      workItemsUpdated,
      lineItemsAdjusted,
      originalStored: true,
      extractionStored: true,
      issues: parsed.issues,
      extraction,
      workbook,
    });
  } catch (err) {
    console.error("Failed to import project file:", err);
    const message = err instanceof Error ? err.message : "Failed to import project file.";
    // Same convention as app/api/workflow/dashboard/route.ts — an
    // authorization failure (assertAdminOrDelegated, or getUserContext
    // for a caller with no role at all) reads as 403, not a generic 500.
    const unauthorized = message.includes("not authorized") || message.includes("No active project/department assignment");
    return jsonError(message, unauthorized ? 403 : 500);
  }
}
