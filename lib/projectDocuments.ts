import "server-only";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";

/**
 * Project document storage — one private bucket, organized per project
 * (see supabase/migrations/00000000000021_project_documents_storage.sql):
 *
 *   project-documents/projects/<projectId>/<kind>/<file>
 *
 * Service-role only (no anon policy on the bucket), so every caller of
 * this module must already have authorized the user for that project.
 * Only `imports` (original uploaded Excel/G703 workbooks) exists today;
 * a new document type is a new `kind`, never a new top-level location.
 */
export const PROJECT_DOCUMENTS_BUCKET = "project-documents";

export type ProjectDocumentKind = "imports";

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
