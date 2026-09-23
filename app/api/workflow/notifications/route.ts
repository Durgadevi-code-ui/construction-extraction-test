import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/session";
import { resolveActorRole } from "@/lib/authContext";
import {
  getUnreadNotificationCount,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications";

export const runtime = "nodejs";

/**
 * GET returns every notification for the CALLER's own server-verified
 * identity (getCurrentUser()) — a userId query param, if a caller sends
 * one, is never read. This closes the exact "must never access another
 * user's notifications" gap: previously ?userId= was trusted directly
 * from the request, so anyone could read/mark-read anyone else's
 * notifications by editing the URL.
 */
export async function GET(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();
  const unreadOnly = request.nextUrl.searchParams.get("unreadOnly") === "true";

  try {
    // Role is used only to pick each notification's navigation target
    // (see resolveNotificationTarget) — never to widen which rows are
    // returned; that's still ownership alone (recipient_user_id).
    const recipientRole = await resolveActorRole(supabase, currentUser.userId);
    const [notifications, unreadCount] = await Promise.all([
      listNotificationsForUser(supabase, currentUser.userId, recipientRole, { unreadOnly, limit: 50 }),
      getUnreadNotificationCount(supabase, currentUser.userId),
    ]);
    return NextResponse.json({ notifications, unreadCount });
  } catch (err) {
    console.error("Failed to load notifications:", err);
    const message = err instanceof Error ? err.message : "Failed to load notifications.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const action: unknown = body?.action;

    if (action === "markRead") {
      const notificationId: unknown = body?.notificationId;
      if (typeof notificationId !== "string" || !notificationId) {
        return NextResponse.json({ error: "notificationId is required." }, { status: 400 });
      }
      await markNotificationRead(supabase, { userId: currentUser.userId, notificationId });
      return NextResponse.json({ ok: true });
    }

    if (action === "markAllRead") {
      await markAllNotificationsRead(supabase, currentUser.userId);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    console.error("Notification action failed:", err);
    const message = err instanceof Error ? err.message : "Action failed.";
    // markNotificationRead's ownership check (see lib/notifications.ts)
    // throws this exact message for a notificationId that doesn't
    // belong to the caller — surfaced as 403, not a generic 500, so a
    // crafted cross-user request reads as "forbidden" rather than
    // "server error".
    const forbidden = message === "Notification not found for this user.";
    return NextResponse.json({ error: message }, { status: forbidden ? 403 : 500 });
  }
}
