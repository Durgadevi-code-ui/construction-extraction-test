import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserContext, isAdminUser } from "./authContext";
import { formatUserDisplayName } from "./format";

/**
 * Project Communication / Chat — a simple project-scoped message
 * board, entirely separate from the extraction/progress pipeline (see
 * supabase/migrations/00000000000017_chat_messages.sql). A message
 * carries no progress/approval meaning at all; it is never read by
 * lib/workflow.ts, lib/dashboard.ts, or any notification logic.
 */

export type ChatMessageRecord = {
  chatMessageId: string;
  senderName: string;
  senderRole: string;
  body: string;
  createdAt: string;
  /** True when this row was posted by the caller — lets the UI align
   * the caller's own messages differently without a second query. */
  isOwn: boolean;
};

/** One person the caller is allowed to start a private conversation
 * with — see listProjectContacts. */
export type ChatContact = {
  userId: string;
  name: string;
  role: string;
};

const RECENT_LIMIT = 200;
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Which project a caller's chat activity is scoped to, and what role
 * they're acting under for display purposes. Every
 * Worker/Subcontractor/Contractor is scoped to their own single
 * active project and role (getUserContext — the same server-verified
 * context every other write in this app uses, never a client-supplied
 * id). This is also the only role source used for a message's
 * sender_role: `users.user_role` is a separate, secondary column that
 * can drift from the Active user_project_roles row getUserContext
 * resolves (the field every authorization check in this app actually
 * trusts — see lib/authContext.ts) — using it here would risk
 * displaying a stale/incorrect role next to a sender's name. Admin has
 * no single project (see lib/authContext.ts isAdminUser's own doc
 * comment on why), so an Admin must explicitly pick one — a
 * requestedProjectId is required and used as-is; nothing further to
 * validate beyond "this caller is really an Admin", since an Admin is
 * already authorized to see every project in this app (same as every
 * other Admin Setup module).
 */
async function resolveSenderContext(
  supabase: SupabaseClient,
  userId: string,
  requestedProjectId?: string | null
): Promise<{ projectId: string; role: string }> {
  if (await isAdminUser(supabase, userId)) {
    if (!requestedProjectId) {
      throw new Error("Select a project to view its communication.");
    }
    return { projectId: requestedProjectId, role: "ADMIN" };
  }

  const ctx = await getUserContext(supabase, userId);
  return { projectId: ctx.projectId, role: ctx.role };
}

/** Every Active broadcast ("Team") message in the caller's resolved
 * project, oldest first — recipient_user_id IS NULL is what
 * distinguishes this from a private direct message (see
 * listDirectMessages below); a simple chronological board, not a
 * per-user inbox. */
export async function listChatMessages(
  supabase: SupabaseClient,
  userId: string,
  requestedProjectId?: string | null
): Promise<ChatMessageRecord[]> {
  const { projectId } = await resolveSenderContext(supabase, userId, requestedProjectId);

  const { data, error } = await supabase
    .from("chat_messages")
    .select("chat_message_id, sender_user_id, sender_name, sender_role, body, created_at")
    .eq("project_id", projectId)
    .eq("status", "Active")
    .is("recipient_user_id", null)
    .order("created_at", { ascending: true })
    .limit(RECENT_LIMIT);

  if (error) {
    throw new Error(`Failed to load messages: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    chatMessageId: row.chat_message_id as string,
    senderName: row.sender_name as string,
    senderRole: row.sender_role as string,
    body: row.body as string,
    createdAt: row.created_at as string,
    isOwn: row.sender_user_id === userId,
  }));
}

/** Posts one message to the caller's resolved project. Sender name is
 * snapshotted from users at send time; sender role comes from
 * resolveSenderContext (getUserContext/isAdminUser), never the
 * separate users.user_role column — both display-only, never
 * re-derived from a client-supplied value, same convention
 * lib/liveUpdates.ts uses for workerName. */
export async function sendChatMessage(
  supabase: SupabaseClient,
  userId: string,
  body: string,
  requestedProjectId?: string | null
): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error("Message cannot be empty.");
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);
  }

  const { projectId, role } = await resolveSenderContext(supabase, userId, requestedProjectId);

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("first_name, last_name, user_mail")
    .eq("user_id", userId)
    .maybeSingle();

  if (userError || !userRow) {
    throw new Error("Could not resolve sender identity.");
  }

  const senderName = formatUserDisplayName({
    firstName: userRow.first_name,
    lastName: userRow.last_name,
    email: userRow.user_mail,
  });

  const { error } = await supabase.from("chat_messages").insert({
    project_id: projectId,
    sender_user_id: userId,
    sender_name: senderName,
    sender_role: role,
    body: trimmed,
  });

  if (error) {
    throw new Error(`Failed to send message: ${error.message}`);
  }
}

/**
 * Private 1:1 Communication — additive on top of the broadcast board
 * above (see 00000000000018_chat_direct_messages.sql). A direct
 * message is the same chat_messages row shape with recipient_user_id
 * set instead of null; the broadcast functions above are untouched and
 * keep working exactly as before for recipient_user_id IS NULL rows,
 * surfaced in the UI as the "Team" conversation.
 *
 * "Permitted contacts" is intentionally kept open within a project
 * (every other Active member of the caller's resolved project, plus
 * every Active Admin so a Worker/Subcontractor can always reach an
 * Admin even though Admin has no user_project_roles row of their own)
 * rather than gated behind a request/accept flow — there is no
 * existing connection-request infrastructure in this schema to extend,
 * and the feature's own fallback requirement is "keep it reasonably
 * open, don't over-restrict."
 */
export async function listProjectContacts(
  supabase: SupabaseClient,
  userId: string,
  requestedProjectId?: string | null
): Promise<ChatContact[]> {
  const { projectId } = await resolveSenderContext(supabase, userId, requestedProjectId);

  const { data: memberRows, error: memberError } = await supabase
    .from("user_project_roles")
    .select("user_id, role, users(first_name, last_name, user_mail)")
    .eq("project_id", projectId)
    .eq("status", "Active")
    .neq("user_id", userId);

  if (memberError) {
    throw new Error(`Failed to load contacts: ${memberError.message}`);
  }

  const { data: adminRows, error: adminError } = await supabase
    .from("users")
    .select("user_id, first_name, last_name, user_mail")
    .eq("user_role", "ADMIN")
    .eq("status", "Active")
    .neq("user_id", userId);

  if (adminError) {
    throw new Error(`Failed to load contacts: ${adminError.message}`);
  }

  // A person can appear from both queries (e.g. an Admin also holding a
  // project role) or more than once in memberRows (more than one
  // Active role row) — contacts are per-person, first occurrence wins.
  const seen = new Set<string>();
  const contacts: ChatContact[] = [];

  for (const row of memberRows ?? []) {
    const uid = row.user_id as string;
    if (seen.has(uid)) continue;
    seen.add(uid);
    const userRow = Array.isArray(row.users) ? row.users[0] : row.users;
    contacts.push({
      userId: uid,
      name: formatUserDisplayName({
        firstName: (userRow?.first_name as string | null) ?? null,
        lastName: (userRow?.last_name as string | null) ?? null,
        email: (userRow?.user_mail as string | null) ?? "",
      }),
      role: row.role as string,
    });
  }

  for (const row of adminRows ?? []) {
    const uid = row.user_id as string;
    if (seen.has(uid)) continue;
    seen.add(uid);
    contacts.push({
      userId: uid,
      name: formatUserDisplayName({
        firstName: row.first_name as string | null,
        lastName: row.last_name as string | null,
        email: (row.user_mail as string | null) ?? "",
      }),
      role: "ADMIN",
    });
  }

  return contacts;
}

/** Every Active direct message between the caller and `peerUserId` in
 * the caller's resolved project, oldest first — mirrors
 * listChatMessages' shape/ordering exactly, just filtered to one
 * conversation instead of the whole project. */
export async function listDirectMessages(
  supabase: SupabaseClient,
  userId: string,
  peerUserId: string,
  requestedProjectId?: string | null
): Promise<ChatMessageRecord[]> {
  const { projectId } = await resolveSenderContext(supabase, userId, requestedProjectId);

  const { data, error } = await supabase
    .from("chat_messages")
    .select("chat_message_id, sender_user_id, sender_name, sender_role, body, created_at")
    .eq("project_id", projectId)
    .eq("status", "Active")
    .or(
      `and(sender_user_id.eq.${userId},recipient_user_id.eq.${peerUserId}),and(sender_user_id.eq.${peerUserId},recipient_user_id.eq.${userId})`
    )
    .order("created_at", { ascending: true })
    .limit(RECENT_LIMIT);

  if (error) {
    throw new Error(`Failed to load messages: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    chatMessageId: row.chat_message_id as string,
    senderName: row.sender_name as string,
    senderRole: row.sender_role as string,
    body: row.body as string,
    createdAt: row.created_at as string,
    isOwn: row.sender_user_id === userId,
  }));
}

/** Posts one private message to `recipientUserId` — same
 * validation/name-resolution as sendChatMessage, plus confirming the
 * recipient is actually one of the caller's permitted contacts (never
 * trust a client-supplied recipient id outright). */
export async function sendDirectMessage(
  supabase: SupabaseClient,
  userId: string,
  recipientUserId: string,
  body: string,
  requestedProjectId?: string | null
): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error("Message cannot be empty.");
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);
  }

  const { projectId, role } = await resolveSenderContext(supabase, userId, requestedProjectId);

  const contacts = await listProjectContacts(supabase, userId, requestedProjectId);
  if (!contacts.some((c) => c.userId === recipientUserId)) {
    throw new Error("You can only message users in your own project.");
  }

  const { data: userRow, error: userError } = await supabase
    .from("users")
    .select("first_name, last_name, user_mail")
    .eq("user_id", userId)
    .maybeSingle();

  if (userError || !userRow) {
    throw new Error("Could not resolve sender identity.");
  }

  const senderName = formatUserDisplayName({
    firstName: userRow.first_name,
    lastName: userRow.last_name,
    email: userRow.user_mail,
  });

  const { error } = await supabase.from("chat_messages").insert({
    project_id: projectId,
    sender_user_id: userId,
    recipient_user_id: recipientUserId,
    sender_name: senderName,
    sender_role: role,
    body: trimmed,
  });

  if (error) {
    throw new Error(`Failed to send message: ${error.message}`);
  }
}
