import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { humanizeRole } from "./format";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";
import { CONTRACTOR_ROLES } from "./authContext";

/**
 * Worker progress-review notifications (see
 * supabase/migrations/00000000000007_notifications.sql). The only
 * writer is createProgressNotification, called from lib/workflow.ts at
 * the exact points a worker's submission is reviewed/changed/approved/
 * returned: foremanForwardSubmission (Subcontractor correction before
 * forwarding), supervisorApprove, supervisorEditSubmission (only when
 * editing an already-approved item — the "70% -> 80%" case), and
 * supervisorRollback. A notification is created only when something
 * actually changed (a real percentage change, or a real approve/return
 * status transition) — never on a no-op save — so a worker is never
 * notified twice for the same unchanged approval.
 */

export type NotificationType =
  | "PROGRESS_APPROVED"
  | "PROGRESS_APPROVED_WITH_CHANGES"
  | "PROGRESS_CHANGED"
  | "PROGRESS_RETURNED"
  | "SUBMISSION_PENDING_REVIEW"
  | "SUBMISSION_FORWARDED";

export type NotificationRecord = {
  notificationId: string;
  type: NotificationType;
  title: string;
  message: string;
  projectId: string | null;
  projectName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  workItemId: string | null;
  workItemCode: string | null;
  workItemDescription: string | null;
  /** notifications.submission_id — the exact submission this is about,
   * used to focus/highlight that record in the recipient's review queue. */
  submissionId: string | null;
  submittedProgress: number | null;
  previousApprovedProgress: number | null;
  newApprovedProgress: number | null;
  reviewerName: string | null;
  reviewerRole: string | null;
  remarks: string | null;
  isRead: boolean;
  createdAt: string;
  /** Where "View Update"/"View Queue" on this notification should
   * navigate, or null when there is nowhere useful to send this
   * recipient (see resolveNotificationTarget) — always an existing
   * in-app route built only from this row's own ids, never a
   * client-supplied or fabricated URL. Computed per-recipient by the
   * caller (see app/api/workflow/notifications/route.ts), since the
   * same notification `type` (e.g. SUBMISSION_FORWARDED) is sent to two
   * different roles with two different correct destinations. */
  actionHref: string | null;
  actionLabel: string | null;
};

/**
 * Resolves a notification's navigation target from data ALREADY on the
 * row (workItemId) plus the resolved recipient's own role — never a
 * client-supplied value, never an invented URL, only existing app
 * routes:
 *   - WORKER recipient (every PROGRESS_* outcome, plus their own copy of
 *     SUBMISSION_FORWARDED): straight to their own Worker Dashboard,
 *     pre-selected on the exact work item (same route the dashboard's
 *     Work Item dropdown already uses).
 *   - FOREMAN recipient (SUBMISSION_PENDING_REVIEW): their review queue.
 *   - Contractor/Supervisor recipient (SUBMISSION_FORWARDED to
 *     CONTRACTOR_ROLES): their review queue.
 *   - Any other role (e.g. an Admin who somehow holds a notification):
 *     no target — nothing for them to see on either dashboard.
 * Authorization is unaffected by this: the destination page itself still
 * enforces who may view what (see app/workflow/worker|foreman|supervisor
 * pages) — this only decides which existing, already-authorized page to
 * send a recipient to for their OWN notification.
 */
export function resolveNotificationTarget(
  recipientRole: string,
  workItemId: string | null,
  /** Optional — when present, the reviewer link also carries which
   * record to focus (`focus`, the submission) and which notification
   * opened it (`n`), so the Reviews tab can scroll to and highlight that
   * exact record instead of just opening the page. Both ids come from
   * this recipient's own notification row. */
  focus?: {
    submissionId: string | null;
    workItemCode: string | null;
    notificationId: string;
    /** The notification's own project/department — opens the recipient's
     * page in that context when they hold roles on several. */
    projectId?: string | null;
    departmentId?: string | null;
  }
): { href: string; label: string } | null {
  const projectQuery = focus?.projectId ? `&projectId=${focus.projectId}` : "";
  const workerContextQuery = `${projectQuery}${focus?.departmentId ? `&departmentId=${focus.departmentId}` : ""}`;
  if (recipientRole === "WORKER") {
    // Same focus mechanism as the reviewer links below: the exact
    // submission in the Worker's own History when the notification
    // carries one (every current Worker notification type does), else
    // the work item's card on Work Items; the old pre-selected-work-item
    // link only when neither is known. The Worker page still re-checks
    // everything server-side (own data only).
    if (focus?.submissionId) {
      const item = focus.workItemCode ? `&item=${encodeURIComponent(focus.workItemCode)}` : "";
      return {
        href: `/workflow/worker?tab=history&focus=${focus.submissionId}${item}&n=${focus.notificationId}${workerContextQuery}`,
        label: "View Update",
      };
    }
    if (focus?.workItemCode) {
      return {
        href: `/workflow/worker?tab=workItems&item=${encodeURIComponent(focus.workItemCode)}&n=${focus.notificationId}${workerContextQuery}`,
        label: "View Update",
      };
    }
    return workItemId ? { href: `/workflow/worker?workItemId=${workItemId}`, label: "View Update" } : null;
  }
  // `?tab=` matters even though it's also each page's own default tab:
  // ForemanTabs/ContractorTabs hold the active tab in local component
  // state, not the URL, so navigating to the bare page while the
  // recipient is already sitting on it (their only dashboard — the
  // common case) would otherwise change nothing visible at all. Both
  // components read this param on every navigation (not just on
  // mount) specifically so this link works from anywhere, including a
  // second click from the same page.
  const focusQuery = focus
    ? `${focus.submissionId ? `&focus=${focus.submissionId}` : ""}${
        focus.workItemCode ? `&item=${encodeURIComponent(focus.workItemCode)}` : ""
      }&n=${focus.notificationId}`
    : "";
  if (recipientRole === "FOREMAN") {
    return { href: `/workflow/foreman?tab=reviews${focusQuery}${projectQuery}`, label: "View Queue" };
  }
  if (CONTRACTOR_ROLES.includes(recipientRole)) {
    return { href: `/workflow/supervisor?tab=reviews${focusQuery}${projectQuery}`, label: "View Queue" };
  }
  return null;
}

function round1(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

/**
 * Builds the notification body per the required content: work item,
 * project (+ department), what the worker submitted, the previous
 * approved value (if any), the new value, who reviewed it and their
 * role, and remarks — e.g. "Your progress submission for Foundation
 * Work in Project ABC was approved by Contractor Ravi. You submitted
 * 75%, and the approved progress is now 70%. Remarks: ...".
 * `progressNoun` lets a not-yet-approved review (Subcontractor
 * forwarding with a correction) read as "progress is now X%" instead
 * of falsely claiming "approved".
 */
function buildMessage(params: {
  workItemDescription: string;
  projectName: string;
  departmentName: string | null;
  outcomeLabel: string;
  reviewerRoleLabel: string;
  reviewerName: string;
  submittedProgress: number | null;
  previousProgress: number | null;
  newProgress: number | null;
  progressNoun: string;
  remarks: string | null;
}): string {
  const parts: string[] = [
    `Your progress submission for ${params.workItemDescription} in ${params.projectName}` +
      (params.departmentName ? ` (${params.departmentName})` : "") +
      ` was ${params.outcomeLabel} by ${params.reviewerRoleLabel} ${params.reviewerName}.`,
  ];

  if (params.submittedProgress !== null) {
    parts.push(`You submitted ${params.submittedProgress}%,`);
  }

  if (params.newProgress !== null) {
    if (params.previousProgress !== null && params.previousProgress !== params.newProgress) {
      parts.push(
        `${parts.length > 1 ? "and the" : "The"} ${params.progressNoun} changed from ${params.previousProgress}% to ${params.newProgress}%.`
      );
    } else {
      parts.push(`${parts.length > 1 ? "and the" : "The"} ${params.progressNoun} is now ${params.newProgress}%.`);
    }
  }

  if (params.remarks) {
    parts.push(`Remarks: ${params.remarks}`);
  }

  return parts.join(" ");
}

const TYPE_TITLE: Record<NotificationType, string> = {
  PROGRESS_APPROVED: "Progress Approved",
  PROGRESS_APPROVED_WITH_CHANGES: "Progress Approved (with changes)",
  PROGRESS_CHANGED: "Progress Changed",
  PROGRESS_RETURNED: "Progress Returned for Correction",
  SUBMISSION_PENDING_REVIEW: "New Submission Awaiting Your Review",
  SUBMISSION_FORWARDED: "Submission Forwarded for Approval",
};

const TYPE_OUTCOME_LABEL: Record<NotificationType, string> = {
  PROGRESS_APPROVED: "approved",
  PROGRESS_APPROVED_WITH_CHANGES: "reviewed and approved",
  PROGRESS_CHANGED: "reviewed and changed",
  PROGRESS_RETURNED: "reviewed and returned for correction",
  SUBMISSION_PENDING_REVIEW: "submitted",
  SUBMISSION_FORWARDED: "forwarded",
};

/**
 * Notifies every Active reviewer in a department — the Foreman(s) when
 * a Worker submits, or the Supervisor/Contractor(s) when a Foreman
 * forwards — never the originating actor. Distinct from
 * createProgressNotification (which reports a review OUTCOME back to
 * the Worker who submitted): this reports that something is now
 * WAITING for the recipient's own action. Reuses the same
 * notifications table/columns rather than a second table — the
 * reviewer_name/reviewer_role columns here store the ACTOR who
 * triggered the notification (the submitter/forwarder), which reads
 * naturally in the message ("Ravi submitted...") even though for the
 * PROGRESS_* types those same columns mean "who reviewed it."
 */
export async function createReviewerNotification(
  supabase: SupabaseClient,
  params: {
    recipientUserIds: string[];
    type: Extract<NotificationType, "SUBMISSION_PENDING_REVIEW" | "SUBMISSION_FORWARDED">;
    projectId: string;
    projectName: string;
    departmentId: string;
    departmentName: string;
    workItemId: string;
    workItemDescription: string;
    submissionId?: string | null;
    validationId?: string | null;
    submittedProgress: number | null;
    actorUserId: string;
    actorRole: string;
    actorName: string;
    remarks?: string | null;
  }
): Promise<void> {
  if (params.recipientUserIds.length === 0) return;

  const actorRoleLabel = humanizeRole(params.actorRole);
  const submittedProgress = round1(params.submittedProgress);
  const progressClause =
    submittedProgress !== null ? ` Reported progress: ${submittedProgress}%.` : "";
  const remarksClause = params.remarks ? ` Remarks: ${params.remarks}` : "";

  const message =
    `${params.actorName} (${actorRoleLabel}) ${TYPE_OUTCOME_LABEL[params.type]} progress for ` +
    `${params.workItemDescription} in ${params.projectName} (${params.departmentName}) — ` +
    `it's waiting for your review.${progressClause}${remarksClause}`;

  const rows = params.recipientUserIds.map((recipientUserId) => ({
    recipient_user_id: recipientUserId,
    project_id: params.projectId,
    department_id: params.departmentId,
    work_item_id: params.workItemId,
    submission_id: params.submissionId ?? null,
    validation_id: params.validationId ?? null,
    type: params.type,
    title: TYPE_TITLE[params.type],
    message,
    submitted_progress: submittedProgress,
    previous_approved_progress: null,
    new_approved_progress: null,
    reviewer_user_id: params.actorUserId,
    reviewer_name: params.actorName,
    reviewer_role: actorRoleLabel,
    remarks: params.remarks ?? null,
  }));

  // Same best-effort, non-blocking contract as createProgressNotification
  // above — a notification failure must never roll back the actual
  // submit/forward action it's reporting on. notifications is one of the
  // 8 tables being prepared for service-role-only RLS (see the P0 audit).
  const { error } = await getSupabaseServiceRoleClient().from("notifications").insert(rows);
  if (error) {
    console.error("Failed to create reviewer notification:", error.message);
  }
}

/**
 * Active user_ids holding any of `roles` in `departmentId` (within
 * `projectId`) — the recipient list for createReviewerNotification.
 * Same Active-only scoping as every other department-membership query
 * in this app (see lib/workflow.ts listDepartmentWorkers), so a
 * Removed assignment never receives a notification for work it's no
 * longer responsible for. `projectId` is checked too, defensively —
 * department_id alone already determines project_id 1:1 in a
 * correctly-shaped user_project_roles row, but nothing in this schema
 * enforces that pairing with a DB constraint, so filtering on both
 * columns closes that gap rather than trusting the pairing implicitly.
 */
export async function listDepartmentReviewers(
  supabase: SupabaseClient,
  projectId: string,
  departmentId: string,
  roles: string[]
): Promise<string[]> {
  const { data, error } = await supabase
    .from("user_project_roles")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("department_id", departmentId)
    .eq("status", "Active")
    .in("role", roles);

  if (error) {
    throw new Error(`Failed to load department reviewers: ${error.message}`);
  }
  return [...new Set((data ?? []).map((r) => r.user_id as string))];
}

export async function createProgressNotification(
  supabase: SupabaseClient,
  params: {
    recipientUserId: string;
    type: NotificationType;
    projectId: string;
    projectName: string;
    departmentId: string;
    departmentName: string;
    workItemId: string;
    workItemDescription: string;
    submissionId?: string | null;
    validationId?: string | null;
    submittedProgress: number | null;
    previousApprovedProgress: number | null;
    newApprovedProgress: number | null;
    reviewerUserId: string;
    reviewerRole: string;
    reviewerName: string;
    remarks?: string | null;
    /** "approved progress" (Contractor actions, canonical) vs "progress"
     * (Subcontractor forwarding — nothing is approved yet). */
    progressNoun?: string;
  }
): Promise<void> {
  const reviewerRoleLabel = humanizeRole(params.reviewerRole);
  const submittedProgress = round1(params.submittedProgress);
  const previousApprovedProgress = round1(params.previousApprovedProgress);
  const newApprovedProgress = round1(params.newApprovedProgress);

  const message = buildMessage({
    workItemDescription: params.workItemDescription,
    projectName: params.projectName,
    departmentName: params.departmentName,
    outcomeLabel: TYPE_OUTCOME_LABEL[params.type],
    reviewerRoleLabel,
    reviewerName: params.reviewerName,
    submittedProgress,
    previousProgress: previousApprovedProgress,
    newProgress: newApprovedProgress,
    progressNoun: params.progressNoun ?? "approved progress",
    remarks: params.remarks ?? null,
  });

  // A notification failure must never roll back the actual review
  // action it's reporting on — log and continue, same "best-effort,
  // additive" contract as every other non-core lookup in this app (see
  // AdminSetupPage's delegations .catch(() => [])).
  const { error } = await getSupabaseServiceRoleClient().from("notifications").insert({
    recipient_user_id: params.recipientUserId,
    project_id: params.projectId,
    department_id: params.departmentId,
    work_item_id: params.workItemId,
    submission_id: params.submissionId ?? null,
    validation_id: params.validationId ?? null,
    type: params.type,
    title: TYPE_TITLE[params.type],
    message,
    submitted_progress: submittedProgress,
    previous_approved_progress: previousApprovedProgress,
    new_approved_progress: newApprovedProgress,
    reviewer_user_id: params.reviewerUserId,
    reviewer_name: params.reviewerName,
    reviewer_role: reviewerRoleLabel,
    remarks: params.remarks ?? null,
  });

  if (error) {
    console.error("Failed to create notification:", error.message);
  }
}

const NOTIFICATION_SELECT =
  "notification_id, type, title, message, project_id, projects(project_name), department_id, departments(department_name), work_item_id, work_items(line_item_no, description_of_work), submission_id, submitted_progress, previous_approved_progress, new_approved_progress, reviewer_name, reviewer_role, remarks, is_read, created_at";

type NotificationRow = {
  notification_id: string;
  type: NotificationType;
  title: string;
  message: string;
  project_id: string | null;
  projects: { project_name: string } | { project_name: string }[] | null;
  department_id: string | null;
  departments: { department_name: string } | { department_name: string }[] | null;
  work_item_id: string | null;
  work_items:
    | { line_item_no: string; description_of_work: string }
    | { line_item_no: string; description_of_work: string }[]
    | null;
  submission_id: string | null;
  submitted_progress: number | null;
  previous_approved_progress: number | null;
  new_approved_progress: number | null;
  reviewer_name: string | null;
  reviewer_role: string | null;
  remarks: string | null;
  is_read: boolean;
  created_at: string;
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

function toNotification(row: NotificationRow, recipientRole: string): NotificationRecord {
  const target = resolveNotificationTarget(recipientRole, row.work_item_id, {
    submissionId: row.submission_id,
    workItemCode: one(row.work_items)?.line_item_no ?? null,
    notificationId: row.notification_id,
    projectId: row.project_id,
    departmentId: row.department_id,
  });
  return {
    notificationId: row.notification_id,
    type: row.type,
    title: row.title,
    message: row.message,
    projectId: row.project_id,
    projectName: one(row.projects)?.project_name ?? null,
    departmentId: row.department_id,
    departmentName: one(row.departments)?.department_name ?? null,
    workItemId: row.work_item_id,
    workItemCode: one(row.work_items)?.line_item_no ?? null,
    workItemDescription: one(row.work_items)?.description_of_work ?? null,
    submissionId: row.submission_id,
    submittedProgress: row.submitted_progress,
    previousApprovedProgress: row.previous_approved_progress,
    newApprovedProgress: row.new_approved_progress,
    reviewerName: row.reviewer_name,
    reviewerRole: row.reviewer_role,
    remarks: row.remarks,
    isRead: row.is_read,
    createdAt: row.created_at,
    actionHref: target?.href ?? null,
    actionLabel: target?.label ?? null,
  };
}

/**
 * Every notification addressed to `userId` — ownership IS the query
 * (recipient_user_id = userId), the same non-login authorization
 * pattern as every other module in this app (see lib/authContext.ts):
 * a caller can only ever see the notifications for the exact user id it
 * supplies, never another user's, because nothing else in the request
 * can widen this WHERE clause.
 */
export async function listNotificationsForUser(
  supabase: SupabaseClient,
  userId: string,
  /** The recipient's own role (ADMIN/WORKER/FOREMAN/SUPERVISOR/MANAGER)
   * — resolved by the caller (see app/api/workflow/notifications/route.ts,
   * via isAdminUser/getUserContext, the same resolution every other role
   * check in this app uses) and used only to pick each notification's
   * navigation target (see resolveNotificationTarget); never affects
   * which rows are returned — that's still ownership alone
   * (recipient_user_id = userId). */
  recipientRole: string,
  options?: { unreadOnly?: boolean; limit?: number }
): Promise<NotificationRecord[]> {
  let query = getSupabaseServiceRoleClient()
    .from("notifications")
    .select(NOTIFICATION_SELECT)
    .eq("recipient_user_id", userId)
    .order("created_at", { ascending: false });

  if (options?.unreadOnly) query = query.eq("is_read", false);
  if (options?.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load notifications: ${error.message}`);
  return ((data ?? []) as unknown as NotificationRow[]).map((row) => toNotification(row, recipientRole));
}

export async function getUnreadNotificationCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { count, error } = await getSupabaseServiceRoleClient()
    .from("notifications")
    .select("notification_id", { count: "exact", head: true })
    .eq("recipient_user_id", userId)
    .eq("is_read", false);

  if (error) throw new Error(`Failed to count notifications: ${error.message}`);
  return count ?? 0;
}

/** Marks one notification read — ownership-checked (must belong to
 * `userId`) before the update, same pattern as
 * assertSubmissionInDepartment in lib/workflow.ts: a crafted
 * notificationId belonging to someone else is rejected, never silently
 * updated. */
export async function markNotificationRead(
  supabase: SupabaseClient,
  params: { userId: string; notificationId: string }
): Promise<void> {
  const serviceSupabase = getSupabaseServiceRoleClient();

  const { data: existing, error: findError } = await serviceSupabase
    .from("notifications")
    .select("recipient_user_id")
    .eq("notification_id", params.notificationId)
    .maybeSingle();

  if (findError) throw new Error(`Failed to load notification: ${findError.message}`);
  if (!existing || existing.recipient_user_id !== params.userId) {
    throw new Error("Notification not found for this user.");
  }

  const { error } = await serviceSupabase
    .from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("notification_id", params.notificationId);

  if (error) throw new Error(`Failed to mark notification read: ${error.message}`);
}

export async function markAllNotificationsRead(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await getSupabaseServiceRoleClient()
    .from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("recipient_user_id", userId)
    .eq("is_read", false);

  if (error) throw new Error(`Failed to mark notifications read: ${error.message}`);
}
