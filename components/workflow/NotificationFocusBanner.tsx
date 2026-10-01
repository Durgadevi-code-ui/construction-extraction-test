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
import type { ReviewFocusState } from "@/lib/workflow";

/** User-facing text for a focus state that means "not in this queue" —
 * never a raw server/database message. */
function focusStateMessage(state: ReviewFocusState): { text: string; tone: "info" | "error" } | null {
  switch (state.kind) {
    case "found":
      return {
        text: `This submission is no longer waiting for review — it is now "${state.statusLabel}". Please check History.`,
        tone: "info",
      };
    case "notFound":
      return { text: "Submission could not be found.", tone: "error" };
    case "forbidden":
      return { text: "You don't have access to this submission.", tone: "error" };
    case "otherContext":
      return {
        text: "This submission belongs to a different project or department than the one you're viewing.",
        tone: "info",
      };
    case "error":
      return { text: "We couldn't check this submission right now. Please try again.", tone: "error" };
  }
}

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
  focusState = null,
  onOpenHistory,
}: {
  notificationId: string;
  /** Whether the focused submission is currently in this queue. */
  recordInQueue: boolean;
  /** Shown when the focused record isn't on this page (default: the
   * reviewer-queue wording). */
  missingMessage?: string;
  /** Server-checked state of the focused submission (reviewer pages —
   * see lib/workflow.ts getReviewFocusState). When present and the
   * record isn't in the queue, its message replaces missingMessage and
   * is shown even if the notification itself couldn't be loaded. */
  focusState?: ReviewFocusState | null;
  /** Adds an "Open History" action to the "no longer waiting" message. */
  onOpenHistory?: () => void;
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

  const stateMessage = !recordInQueue && focusState ? focusStateMessage(focusState) : null;
  if (dismissed || (!item && !stateMessage)) return null;
  const isError = stateMessage?.tone === "error";

  return (
    <div
      role={isError ? "alert" : undefined}
      className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
        isError ? "border-error-border bg-error-soft" : "border-warning-border bg-warning-soft"
      }`}
    >
      <div className="min-w-0 space-y-0.5">
        <p className={`text-xs font-medium ${isError ? "text-error" : "text-warning"}`}>
          From your notification{item ? ` · ${cardTitle(item.type)}` : ""}
        </p>
        {item && (
          <>
            <p className="font-medium text-foreground">
              {item.workItemCode ? `${item.workItemCode} — ` : ""}
              {item.workItemDescription ?? ""}
            </p>
            <p className="font-semibold text-foreground">{cardHighlight(item)}</p>
            <p className="text-xs text-foreground-secondary">
              {[cardSubline(item), formatDateTimeUS(item.createdAt)].filter(Boolean).join(" · ")}
            </p>
          </>
        )}
        {stateMessage ? (
          <p className={isError ? "font-medium text-error" : "text-foreground"}>
            {stateMessage.text}
            {focusState?.kind === "found" && onOpenHistory && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={onOpenHistory}
                  className="font-medium text-brand transition-colors duration-150 hover:underline"
                >
                  Open History
                </button>
              </>
            )}
          </p>
        ) : (
          !recordInQueue && <p className="text-xs text-foreground-secondary">{missingMessage}</p>
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
