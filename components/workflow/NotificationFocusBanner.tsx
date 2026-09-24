"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { formatDateTimeUS } from "@/lib/format";
import {
  cardHighlight,
  cardSubline,
  cardTitle,
  type NotificationItem,
} from "@/components/workflow/NotificationBell";

/**
 * Shown at the top of a Reviews tab opened from a notification's "View
 * Queue" link (?n=<notificationId>): what changed (old → new / submitted
 * %), on which work item, by whom and when — the same wording the bell
 * uses, read from the same /api/workflow/notifications response (the
 * recipient's own notifications only). The record itself is highlighted
 * in the queue below; this says what it is and whether it's still there.
 */
export default function NotificationFocusBanner({
  notificationId,
  recordInQueue,
  missingMessage = "This submission is no longer waiting in this queue — it may already have been handled. See History.",
}: {
  notificationId: string;
  /** Whether the focused submission is currently in this queue. */
  recordInQueue: boolean;
  /** Shown when the focused record isn't on this page (default: the
   * reviewer-queue wording). */
  missingMessage?: string;
}) {
  const [item, setItem] = useState<NotificationItem | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let ignore = false;
    fetch("/api/workflow/notifications")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (ignore || !data) return;
        const found = ((data.notifications ?? []) as NotificationItem[]).find(
          (n) => n.notificationId === notificationId
        );
        setItem(found ?? null);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, [notificationId]);

  if (!item || dismissed) return null;
  const subline = cardSubline(item);

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm">
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs font-medium text-warning">From your notification · {cardTitle(item.type)}</p>
        <p className="font-medium text-foreground">
          {item.workItemCode ? `${item.workItemCode} — ` : ""}
          {item.workItemDescription ?? ""}
        </p>
        <p className="font-semibold text-foreground">{cardHighlight(item)}</p>
        <p className="text-xs text-foreground-secondary">
          {[subline, formatDateTimeUS(item.createdAt)].filter(Boolean).join(" · ")}
        </p>
        {!recordInQueue && (
          <p className="text-xs text-foreground-secondary">{missingMessage}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="rounded p-0.5 text-foreground-muted hover:bg-white/60 hover:text-foreground"
      >
        <X className="h-4 w-4" strokeWidth={2} />
      </button>
    </div>
  );
}
