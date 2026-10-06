import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/session";
import { buildProjectExcelExport } from "@/lib/excelExport";

export const runtime = "nodejs";

/**
 * "Download updated Excel" for one project — the original uploaded
 * workbook (or a rebuilt one in the same shape) with the latest approved
 * progress, limited to what the signed-in user may see: Admin and
 * Contractor get their full authorized scope with amounts; a
 * Subcontractor gets their own department(s) with Amount left blank; a
 * Worker is refused. Every scope/amount decision is made server-side in
 * lib/excelExport.ts from the verified session — the projectId only
 * says which project, never what the caller may see in it.
 */
export async function GET(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required." }, { status: 400 });
  }

  // Optional: the page's current department — only ever narrows the
  // caller's own scope (see buildProjectExcelExport).
  const departmentId = request.nextUrl.searchParams.get("departmentId");

  try {
    const result = await buildProjectExcelExport(getSupabaseClient(), currentUser.userId, projectId, departmentId);
    const asciiName = result.fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    return new Response(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
        "Cache-Control": "no-store",
        "X-Export-Source": result.source,
      },
    });
  } catch (err) {
    console.error("Failed to build the Excel download:", err);
    const message = err instanceof Error ? err.message : "Failed to build the Excel download.";
    const status = message === "Project not found."
      ? 404
      : message.includes("not authorized") || message.includes("No active project/department assignment")
        ? 403
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
