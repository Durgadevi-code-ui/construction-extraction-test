import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserContext, assertRole, CONTRACTOR_ROLES } from "./authContext";
import { formatUserDisplayName } from "./format";

/**
 * "Review / Live Update" evidence — a Worker sharing a quick photo or
 * voice note so a reviewer can follow ongoing work, entirely separate
 * from the real extraction/progress pipeline (see lib/workflow.ts,
 * lib/ocr.ts, lib/stt.ts, lib/construction.ts — none of those are
 * touched by anything in this file, and this file never reads/writes
 * extraction_submissions/user_validations/unified_records). A live
 * update carries no progress percentage or quantity and is never
 * approved/rejected — it is informational only.
 *
 * See supabase/migrations/00000000000013_live_updates.sql for the
 * table/bucket this module reads and writes.
 */

export type LiveUpdateType = "PHOTO" | "VOICE";

const BUCKET = "live-updates";
const SIGNED_URL_TTL_SECONDS = 300;

export type LiveUpdateRecord = {
  liveUpdateId: string;
  updateType: LiveUpdateType;
  workerName: string;
  workItemCode: string | null;
  workItemDescription: string | null;
  caption: string | null;
  /** Short-lived signed URL into the private `live-updates` storage
   * bucket, generated fresh on every read (never stored) — null only if
   * signing itself failed (e.g. the underlying object was removed). */
  mediaUrl: string | null;
  createdAt: string;
};

/**
 * Records a live update. Caller must be an Active WORKER (never a
 * Foreman/Contractor/Admin posting "as" a worker) — the same role gate
 * every worker-only write in lib/workflow.ts uses. project_id/
 * department_id always come from the worker's own server-verified
 * context (getUserContext), never trusted from the client. When
 * workItemId is supplied it must belong to the worker's own department
 * (loosely — unlike submitWorkerProgress, this does NOT require the
 * work item to be assigned to this specific worker, since a live update
 * is informational context, not a progress claim against that item).
 */
export async function createLiveUpdate(
  supabase: SupabaseClient,
  params: {
    workerId: string;
    workItemId?: string | null;
    updateType: LiveUpdateType;
    storagePath: string;
    caption?: string | null;
  }
): Promise<void> {
  // With a work item, act under the worker's role row for THAT work
  // item's project/department (a worker may hold several) — the checks
  // below still require the department to match; without one, the first
  // role as before.
  const { data: target } = params.workItemId
    ? await supabase.from("work_items").select("project_id, department_id").eq("work_item_id", params.workItemId).maybeSingle()
    : { data: null };
  const ctx = await getUserContext(
    supabase,
    params.workerId,
    target ? { projectId: target.project_id as string, departmentId: target.department_id as string } : undefined
  );
  assertRole(ctx.role, ["WORKER"]);

  if (params.workItemId) {
    const { data: workItem, error } = await supabase
      .from("work_items")
      .select("department_id")
      .eq("work_item_id", params.workItemId)
      .maybeSingle();
    if (error || !workItem) {
      throw new Error(`Work item not found: ${error?.message ?? params.workItemId}`);
    }
    if (workItem.department_id !== ctx.departmentId) {
      throw new Error(`Work item ${params.workItemId} does not belong to your department.`);
    }
  }

  const { error } = await supabase.from("live_updates").insert({
    project_id: ctx.projectId,
    department_id: ctx.departmentId,
    work_item_id: params.workItemId ?? null,
    worker_id: params.workerId,
    update_type: params.updateType,
    storage_path: params.storagePath,
    caption: params.caption?.trim() || null,
  });

  if (error) {
    throw new Error(`Failed to save live update: ${error.message}`);
  }
}

const LIVE_UPDATE_SELECT =
  "live_update_id, update_type, storage_path, caption, created_at, work_item_id, users(user_mail, first_name, last_name), work_items(line_item_no, description_of_work)";

type LiveUpdateRow = {
  live_update_id: string;
  update_type: LiveUpdateType;
  storage_path: string;
  caption: string | null;
  created_at: string;
  work_item_id: string | null;
  users:
    | { user_mail: string; first_name: string | null; last_name: string | null }
    | { user_mail: string; first_name: string | null; last_name: string | null }[]
    | null;
  work_items:
    | { line_item_no: string; description_of_work: string }
    | { line_item_no: string; description_of_work: string }[]
    | null;
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

async function toRecord(supabase: SupabaseClient, row: LiveUpdateRow): Promise<LiveUpdateRecord> {
  const worker = one(row.users);
  const workItem = one(row.work_items);

  // Signed fresh on every read rather than stored — the bucket is
  // private (see the migration), so a URL that leaked or was cached
  // client-side stops working after SIGNED_URL_TTL_SECONDS instead of
  // being a permanent, unauthenticated link to the file.
  const { data: signed } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);

  return {
    liveUpdateId: row.live_update_id,
    updateType: row.update_type,
    workerName: worker
      ? formatUserDisplayName({
          firstName: worker.first_name,
          lastName: worker.last_name,
          email: worker.user_mail,
        })
      : "(unknown)",
    workItemCode: workItem?.line_item_no ?? null,
    workItemDescription: workItem?.description_of_work ?? null,
    caption: row.caption,
    mediaUrl: signed?.signedUrl ?? null,
    createdAt: row.created_at,
  };
}

const RECENT_LIMIT = 50;

/**
 * Every Active live_updates row in the reviewer's own department, newest
 * first — the Subcontractor/Contractor "Live Updates" feed. Authorized
 * for FOREMAN and CONTRACTOR_ROLES only (the same reviewer roles
 * lib/workflow.ts's getCurrentWorkItemRecords/listForemanQueue serve),
 * scoped to the caller's own department exactly like every other
 * reviewer-facing query in this app — never another department's rows.
 * Admin cross-department visibility is intentionally not built here
 * (Admin has no single department to scope to) — a small, separate
 * addition if actually needed later, not assumed.
 */
export async function listLiveUpdatesForReviewer(
  supabase: SupabaseClient,
  reviewerUserId: string,
  /** Optional project context (reviewer with roles on several projects);
   * selects among the reviewer's own roles only. */
  projectId?: string
): Promise<LiveUpdateRecord[]> {
  const ctx = await getUserContext(supabase, reviewerUserId, projectId ? { projectId } : undefined);
  if (ctx.role !== "FOREMAN" && !CONTRACTOR_ROLES.includes(ctx.role)) {
    throw new Error(`${ctx.role} ${reviewerUserId} is not authorized to view live updates.`);
  }

  const { data, error } = await supabase
    .from("live_updates")
    .select(LIVE_UPDATE_SELECT)
    .eq("department_id", ctx.departmentId)
    .eq("status", "Active")
    .order("created_at", { ascending: false })
    .limit(RECENT_LIMIT);

  if (error) {
    throw new Error(`Failed to load live updates: ${error.message}`);
  }

  return Promise.all(((data ?? []) as unknown as LiveUpdateRow[]).map((row) => toRecord(supabase, row)));
}

/** A Worker's own recently-posted live updates — lets them see their own
 * posts were actually saved, never another worker's. */
export async function listLiveUpdatesForWorker(
  supabase: SupabaseClient,
  workerUserId: string
): Promise<LiveUpdateRecord[]> {
  const ctx = await getUserContext(supabase, workerUserId);
  assertRole(ctx.role, ["WORKER"]);

  const { data, error } = await supabase
    .from("live_updates")
    .select(LIVE_UPDATE_SELECT)
    .eq("worker_id", workerUserId)
    .eq("status", "Active")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(`Failed to load live updates: ${error.message}`);
  }

  return Promise.all(((data ?? []) as unknown as LiveUpdateRow[]).map((row) => toRecord(supabase, row)));
}
