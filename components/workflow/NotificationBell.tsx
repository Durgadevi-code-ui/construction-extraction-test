"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateTimeUS } from "@/lib/format";

// Mirrors NotificationRecord (lib/notifications.ts) — the API already
// returns every one of these fields (see app/api/workflow/notifications/
// route.ts, which forwards listNotificationsForUser's result as-is);
// this type was previously narrowed to just title/message, so the
// structured fields (previous/new progress, reviewer, remarks, work
// item) were sitting unused in the response. Widening it to the real
// shape is what lets the card below show "50% → 45%" directly instead
// of parsing it back out of a sentence — no backend/API change.
type NotificationItem = {
  notificationId: string;
  type: string;
  title: string;
  message: string;
  workItemId: string | null;
  workItemDescription: string | null;
  submittedProgress: number | null;
  previousApprovedProgress: number | null;
  newApprovedProgress: number | null;
  reviewerName: string | null;
  reviewerRole: string | null;
  remarks: string | null;
  isRead: boolean;
  createdAt: string;
};

const POLL_INTERVAL_MS = 30_000;

/**
 * Short, at-a-glance title per notification type — the mentor's
 * "Instagram-simple" requirement replaces the existing paragraph
 * (n.message) as the PRIMARY presentation; the full sentence is kept
 * only as the fallback for a type this switch doesn't recognize, so an
 * unanticipated future type still shows something rather than nothing.
 */
function cardTitle(type: string): string {
  switch (type) {
    case "PROGRESS_APPROVED":
    case "PROGRESS_APPROVED_WITH_CHANGES":
      return "Work Approved";
    case "PROGRESS_CHANGED":
      return "Progress Changed";
    case "PROGRESS_RETURNED":
      return "Work Returned";
    case "SUBMISSION_FORWARDED":
      return "Submission Forwarded";
    case "SUBMISSION_PENDING_REVIEW":
      return "New Submission";
    default:
      return "Notification";
  }
}

/** The one highlighted line every card needs — old→new progress,
 * approved %, or a plain-language outcome — built only from fields the
 * API already sends for this notification. Never a fabricated value:
 * when the specific field this type needs is missing, falls back to
 * the existing message rather than guessing. */
function cardHighlight(n: NotificationItem): string {
  switch (n.type) {
    case "PROGRESS_CHANGED":
      if (n.previousApprovedProgress !== null && n.newApprovedProgress !== null) {
        return `${n.previousApprovedProgress}% → ${n.newApprovedProgress}%`;
      }
      // A Foreman correcting progress before forwarding (see
      // foremanForwardSubmission in lib/workflow.ts) has no previously
      // APPROVED value yet — nothing has reached approval at that
      // stage, so previousApprovedProgress is null by design there. The
      // real "previous" value for that case is what the worker actually
      // submitted (submittedProgress), which the API already sends on
      // this same notification — reusing it here instead of falling
      // back to the long paragraph.
      if (n.submittedProgress !== null && n.newApprovedProgress !== null) {
        return `${n.submittedProgress}% → ${n.newApprovedProgress}%`;
      }
      return n.message;
    case "PROGRESS_APPROVED":
    case "PROGRESS_APPROVED_WITH_CHANGES":
      return n.newApprovedProgress !== null ? `${n.newApprovedProgress}% approved` : n.message;
    case "PROGRESS_RETURNED":
      return "Your submission was returned for correction.";
    case "SUBMISSION_FORWARDED":
      return n.submittedProgress !== null
        ? `Forwarded for review — ${n.submittedProgress}%`
        : "Forwarded for review.";
    case "SUBMISSION_PENDING_REVIEW":
      return n.submittedProgress !== null
        ? `Submitted — ${n.submittedProgress}%`
        : "New submission awaiting review.";
    default:
      return n.message;
  }
}

/** Who acted + (for a return) the actual reason, if the API sent one —
 * never invented when remarks is null. */
function cardSubline(n: NotificationItem): string | null {
  if (n.type === "PROGRESS_RETURNED") {
    return n.remarks ? `Reason: ${n.remarks}` : null;
  }
  const actor = [n.reviewerRole, n.reviewerName].filter(Boolean).join(" ");
  if (!actor) return null;
  const verb =
    n.type === "PROGRESS_CHANGED" || n.type === "PROGRESS_APPROVED_WITH_CHANGES"
      ? "Reviewed by"
      : n.type === "PROGRESS_APPROVED"
        ? "Approved by"
        : "By";
  return `${verb} ${actor}`;
}

/**
 * Worker-facing notification bell: unread count + a dropdown list of
 * every notification for `userId` (see app/api/workflow/notifications).
 * Polling, not realtime — this app has no realtime infrastructure
 * anywhere else (see lib/supabase.ts), so a reliable 30s poll is the
 * simplest mechanism that satisfies "notifications must not disappear
 * on refresh and should update without a manual reload," without
 * introducing a new dependency for one feature.
 */
export default function NotificationBell({ userId }: { userId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Inline fetch-with-cleanup-flag (not a separately declared callback
  // invoked directly in the effect body) so a poll response that
  // resolves after this effect re-runs (userId changed / unmount) never
  // overwrites state with stale data.
  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        // The API resolves the recipient from the server-verified
        // session (see app/api/workflow/notifications/route.ts) — no
        // identity is ever sent from the client here.
        const res = await fetch(`/api/workflow/notifications`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load notifications.");
        if (ignore) return;
        setNotifications(data.notifications ?? []);
        setUnreadCount(data.unreadCount ?? 0);
        setError(null);
      } catch (err) {
        if (!ignore) {
          setError(err instanceof Error ? err.message : "Failed to load notifications.");
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, [userId]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  async function markRead(notificationId: string) {
    setNotifications((prev) =>
      prev.map((n) => (n.notificationId === notificationId ? { ...n, isRead: true } : n))
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));
    try {
      await fetch("/api/workflow/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action: "markRead", notificationId }),
      });
    } catch {
      // Best-effort — a failed mark-read retries on the next poll's
      // natural reconciliation rather than blocking navigation.
    }
  }

  async function markAllRead() {
    const previous = notifications;
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      const res = await fetch("/api/workflow/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action: "markAllRead" }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setNotifications(previous);
      setError("Failed to mark all as read.");
    }
  }

  // Only the Worker-facing outcome types (a review decision reported
  // back to the submitter) navigate anywhere — those always belong on
  // /workflow/worker. The reviewer-facing types (SUBMISSION_PENDING_REVIEW/
  // SUBMISSION_FORWARDED) are shown to Foremen/Supervisors, who also
  // render this same bell on their own dashboards (app/workflow/foreman,
  // supervisor pages) — navigating them to /workflow/worker would just
  // bounce them straight back out (that page redirects non-Workers away).
  // The item they'd want is already on the queue below on their own
  // page, so clicking just marks it read.
  const WORKER_FACING_TYPES = new Set([
    "PROGRESS_APPROVED",
    "PROGRESS_APPROVED_WITH_CHANGES",
    "PROGRESS_CHANGED",
    "PROGRESS_RETURNED",
  ]);

  function handleClick(notification: NotificationItem) {
    if (!notification.isRead) markRead(notification.notificationId);
    setOpen(false);
    if (notification.workItemId && WORKER_FACING_TYPES.has(notification.type)) {
      // Destination is resolved from the session server-side (see
      // app/workflow/worker/page.tsx) — this only ever carries
      // workItemId, never an identity.
      router.push(`/workflow/worker?workItemId=${notification.workItemId}`);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        className="relative rounded-full p-2 text-foreground-secondary hover:bg-gray-100 hover:text-foreground"
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 max-w-[90vw] rounded-lg border border-line bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-brand hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <p className="px-3 py-6 text-center text-sm text-foreground-muted">Loading…</p>
            ) : error ? (
              <p className="px-3 py-6 text-center text-sm text-red-600">{error}</p>
            ) : notifications.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-foreground-muted">
                No notifications yet.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {notifications.map((n) => {
                  const subline = cardSubline(n);
                  return (
                    <li key={n.notificationId}>
                      <button
                        onClick={() => handleClick(n)}
                        className={`block w-full px-3 py-2.5 text-left transition-colors hover:bg-gray-50 ${
                          n.isRead ? "" : "bg-brand-soft"
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          {!n.isRead && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
                          <span aria-hidden="true">🔔</span>
                          <span className="text-sm font-semibold text-foreground">{cardTitle(n.type)}</span>
                        </div>
                        {n.workItemDescription && (
                          <p className="mt-1 text-xs text-foreground-secondary">{n.workItemDescription}</p>
                        )}
                        <p className="mt-0.5 text-sm font-medium text-foreground">{cardHighlight(n)}</p>
                        {subline && <p className="mt-0.5 text-xs text-foreground-secondary">{subline}</p>}
                        <p className="mt-1 text-[11px] text-foreground-muted">{formatDateTimeUS(n.createdAt)}</p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-5 w-5"
    >
      <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
    </svg>
  );
}
