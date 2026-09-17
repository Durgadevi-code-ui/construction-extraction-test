import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServiceRoleClient } from "@/lib/supabaseAdmin";
import { getCurrentUser } from "@/lib/session";
import {
  listChatMessages,
  sendChatMessage,
  listProjectContacts,
  listDirectMessages,
  sendDirectMessage,
} from "@/lib/chat";

/**
 * Project Communication / Chat — entirely separate endpoint from the
 * extraction pipeline and the progress workflow, same as
 * app/api/workflow/live-updates/route.ts (see that file's own doc for
 * why the service-role client is used here instead of the anon client
 * most other routes use: chat_messages has no anon-reachable RLS
 * policy at all — see
 * supabase/migrations/00000000000017_chat_messages.sql).
 */

export const runtime = "nodejs";

function errorStatus(message: string): number {
  return message.includes("Select a project") ||
    message.includes("No active project/department assignment") ||
    message.includes("cannot be empty") ||
    message.includes("too long") ||
    message.includes("your own project")
    ? 400
    : 500;
}

export async function GET(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseServiceRoleClient();
  const projectId = request.nextUrl.searchParams.get("projectId");
  const peer = request.nextUrl.searchParams.get("peer");
  const wantsContacts = request.nextUrl.searchParams.get("contacts") === "1";

  try {
    if (wantsContacts) {
      const contacts = await listProjectContacts(supabase, currentUser.userId, projectId);
      return NextResponse.json({ contacts });
    }
    const messages = peer
      ? await listDirectMessages(supabase, currentUser.userId, peer, projectId)
      : await listChatMessages(supabase, currentUser.userId, projectId);
    return NextResponse.json({ messages });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load messages.";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}

export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseServiceRoleClient();

  try {
    const payload = await request.json();
    const text = typeof payload.body === "string" ? payload.body : "";
    const projectId = typeof payload.projectId === "string" ? payload.projectId : null;
    const recipientUserId =
      typeof payload.recipientUserId === "string" ? payload.recipientUserId : null;

    if (recipientUserId) {
      await sendDirectMessage(supabase, currentUser.userId, recipientUserId, text, projectId);
    } else {
      await sendChatMessage(supabase, currentUser.userId, text, projectId);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send message.";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
