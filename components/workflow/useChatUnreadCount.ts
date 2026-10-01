"use client";

import { useEffect, useState } from "react";

/** Same order of magnitude as ChatPanel's own message polling. */
const POLL_INTERVAL_MS = 15000;

/** Per user AND project, so switching accounts/projects in one browser
 * never mixes counts. */
function storageKey(userId: string, projectId: string): string {
  return `chat:lastRead:${userId}:${projectId}`;
}

function readLastRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLastRead(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode etc.) — the badge just won't clear
    // across reloads; nothing else depends on it.
  }
}

/**
 * Unread message count for the Communication tab badge (Contractor and
 * Subcontractor). The server counts messages this user RECEIVED in the
 * given project after their last-read point (see lib/chat.ts
 * countUnreadChatMessages, via GET /api/workflow/chat?unread=1) — never
 * their own messages, never another project's. There is no read-receipt
 * table in this schema, so the last-read point is kept in this browser
 * (localStorage), set to the newest received message's SERVER timestamp.
 *
 * While `active` (the Communication tab is open) every poll marks
 * everything read and the count is 0; on other tabs it polls and
 * reports new messages. Display only — never affects messages.
 */
export function useChatUnreadCount({
  userId,
  projectId,
  active,
}: {
  userId: string;
  projectId: string;
  active: boolean;
}): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let ignore = false;
    const key = storageKey(userId, projectId);

    async function poll() {
      try {
        const qs = new URLSearchParams({ unread: "1", projectId });
        const since = readLastRead(key);
        if (since) qs.set("since", since);
        const res = await fetch(`/api/workflow/chat?${qs.toString()}`);
        if (!res.ok) return;
        const data = (await res.json()) as { count?: number; latestAt?: string | null };
        if (ignore) return;
        if (active) {
          if (data.latestAt) writeLastRead(key, data.latestAt);
          setCount(0);
        } else {
          setCount(data.count ?? 0);
        }
      } catch {
        // A failed poll leaves the last known count; the next poll retries.
      }
    }

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [userId, projectId, active]);

  return active ? 0 : count;
}
