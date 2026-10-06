import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/session";
import { assertAdminOrDelegated } from "@/lib/delegation";
import { parseProjectWorkbook, distinctDepartments } from "@/lib/excelImport";
import { upsertWorkItemFromImport } from "@/lib/admin";
import { saveProjectImportFile } from "@/lib/projectDocuments";

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
    let parsed;
    try {
      parsed = parseProjectWorkbook(fileBytes);
    } catch {
      return NextResponse.json(
        { error: "Could not read this file. Upload a valid .xlsx/.xls/.csv workbook." },
        { status: 400 }
      );
    }

    if (parsed.rows.length === 0) {
      return NextResponse.json(
        {
          // Say what was actually read, not just which headings were
          // expected — columns are interpreted from headings AND content.
          error: [
            `The workbook was read (${parsed.diagnostics.length} sheet${parsed.diagnostics.length === 1 ? "" : "s"}), but no reliable work-item structure could be inferred — no sheet had a table with a work description column and rows of work items under it.`,
            ...parsed.diagnostics,
          ].join(" "),
          diagnostics: parsed.diagnostics,
          issues: parsed.issues,
        },
        { status: 422 }
      );
    }

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
      });
    }

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
      });
      if (result.wasCreated) workItemsCreated++;
      else workItemsUpdated++;
      if (result.departmentWasCreated) departmentsCreated++;
    }

    // Keep the original workbook under this project's documents
    // (projects/<projectId>/imports/) so "Download updated Excel" can
    // return the same file structure with the latest data filled in.
    // Best-effort: the import above is already committed either way.
    const storedOriginal = await saveProjectImportFile(projectId, {
      name: file.name,
      bytes: fileBytes,
      contentType: file.type,
    });

    return NextResponse.json({
      preview: false,
      departmentsActivated: departments.length,
      departmentsCreated,
      workItemsCreated,
      workItemsUpdated,
      originalStored: storedOriginal !== null,
      issues: parsed.issues,
    });
  } catch (err) {
    console.error("Failed to import project file:", err);
    const message = err instanceof Error ? err.message : "Failed to import project file.";
    // Same convention as app/api/workflow/dashboard/route.ts — an
    // authorization failure (assertAdminOrDelegated, or getUserContext
    // for a caller with no role at all) reads as 403, not a generic 500.
    const unauthorized = message.includes("not authorized") || message.includes("No active project/department assignment");
    return NextResponse.json({ error: message }, { status: unauthorized ? 403 : 500 });
  }
}
