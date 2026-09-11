"use client";

import { useEffect, useMemo, useState } from "react";
import TabNav from "@/components/workflow/TabNav";
import { formatDateTimeUS, formatDateUS } from "@/lib/format";

type LiveUpdateItem = {
  liveUpdateId: string;
  updateType: "PHOTO" | "VOICE";
  workerName: string;
  workItemCode: string | null;
  workItemDescription: string | null;
  caption: string | null;
  mediaUrl: string | null;
  createdAt: string;
};

// Media URLs returned by GET /api/workflow/live-updates are short-lived
// signed URLs (SIGNED_URL_TTL_SECONDS = 300s in lib/liveUpdates.ts) into
// the private live-updates storage bucket — they stop working after 5
// minutes. Refreshing at 4 minutes keeps them valid with a safety margin
// while a reviewer leaves this tab open, without polling anywhere near
// as often as NotificationBell's 30s interval (nothing here needs
// near-real-time freshness, only the media links need to stay alive).
const REFRESH_INTERVAL_MS = 4 * 60 * 1000;

/** Local-calendar-day key ("2026-9-11") for `date`, using the SAME
 * "full timestamp -> local Date getters" convention lib/format.ts's
 * formatDateUS already documents and relies on for full timestamps
 * (only date-ONLY strings need the UTC-avoidance regex path there) —
 * `live_updates.created_at` is a full timestamptz, so this is the
 * correct, consistent way to answer "what calendar day did this happen
 * on for the person looking at the screen," not the raw UTC day. */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Reviewer-facing feed of Worker-posted live/review updates (see
 * lib/liveUpdates.ts) — supporting evidence for "what's happening right
 * now," entirely separate from the progress-review queue
 * (ForemanQueue/SupervisorPanel). A live update is never approved,
 * rejected, or counted toward progress; this feed is read-only.
 * Self-fetching (same ignore-flag + interval pattern as
 * NotificationBell) so it can be dropped into either ForemanTabs or
 * ContractorTabs without any change to those pages' existing
 * server-side data fetching.
 *
 * Display is split into "Today's Updates" (default) and "History"
 * (grouped by local calendar day, newest day first) — a pure client-side
 * re-presentation of the same GET response; no new endpoint, no new
 * table/column, nothing deleted. The API already returns every Active
 * live_updates row for this reviewer's department (see
 * listLiveUpdatesForReviewer), newest first — this component only
 * partitions that same array by day for display.
 */
export default function LiveUpdateFeed() {
  const [items, setItems] = useState<LiveUpdateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"today" | "history">("today");

  useEffect(() => {
    let ignore = false;

    // `background` = a periodic refresh (re-signing already-loaded
    // media URLs before they expire), not the initial load — its
    // failure must never blank out an already-working feed with an
    // error message; the previously-loaded (now possibly stale) items
    // just stay on screen until the next successful refresh. The
    // selected tab (`view`) is separate state, untouched by any refresh.
    async function load(background: boolean) {
      try {
        const res = await fetch("/api/workflow/live-updates");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load live updates.");
        if (!ignore) {
          setItems(data.updates ?? []);
          setError(null);
        }
      } catch (err) {
        if (!ignore && !background) {
          setError(err instanceof Error ? err.message : "Failed to load live updates.");
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load(false);
    const interval = setInterval(() => load(true), REFRESH_INTERVAL_MS);
    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, []);

  const { todayItems, historyGroups } = useMemo(() => {
    const todayKey = localDayKey(new Date());
    const today: LiveUpdateItem[] = [];
    // Map preserves insertion order — items arrive newest-first from the
    // API, so the first time each day-key is seen is already in
    // newest-day-first order; no separate re-sort of groups needed.
    const groups = new Map<string, LiveUpdateItem[]>();

    for (const item of items) {
      const day = localDayKey(new Date(item.createdAt));
      if (day === todayKey) {
        today.push(item);
      } else {
        const group = groups.get(day) ?? [];
        group.push(item);
        groups.set(day, group);
      }
    }

    return { todayItems: today, historyGroups: groups };
  }, [items]);

  const historyCount = items.length - todayItems.length;

  if (loading) {
    return <p className="text-sm text-foreground-muted">Loading live updates…</p>;
  }
  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  return (
    <div className="space-y-3">
      <TabNav
        tabs={[
          { key: "today", label: `Today's Updates (${todayItems.length})` },
          { key: "history", label: `History (${historyCount})` },
        ]}
        active={view}
        onChange={(key) => setView(key as "today" | "history")}
      />

      {view === "today" ? (
        todayItems.length === 0 ? (
          <EmptyState message="No live updates for today." />
        ) : (
          <div className="space-y-3">
            {todayItems.map((item) => (
              <LiveUpdateCard key={item.liveUpdateId} item={item} />
            ))}
          </div>
        )
      ) : historyGroups.size === 0 ? (
        <EmptyState message="No older live updates yet." />
      ) : (
        <div className="space-y-5">
          {Array.from(historyGroups.entries()).map(([day, dayItems]) => (
            <div key={day} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
                {formatDateUS(dayItems[0].createdAt)}
              </p>
              <div className="space-y-3">
                {dayItems.map((item) => (
                  <LiveUpdateCard key={item.liveUpdateId} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <p className="text-sm text-foreground-muted bg-surface rounded-lg border border-line p-4">
      {message}
    </p>
  );
}

function LiveUpdateCard({ item }: { item: LiveUpdateItem }) {
  return (
    <div className="bg-surface rounded-lg border border-line shadow-sm p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">
          {item.workerName}
          {item.workItemDescription && (
            <span className="font-normal text-foreground-muted"> — {item.workItemDescription}</span>
          )}
        </span>
        <span className="shrink-0 text-xs text-foreground-muted">{formatDateTimeUS(item.createdAt)}</span>
      </div>

      {item.updateType === "PHOTO" && item.mediaUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- signed URL from a private bucket, not a static asset next/image can optimize
        <img
          src={item.mediaUrl}
          alt={`Live update photo from ${item.workerName}`}
          className="max-h-56 w-auto rounded-md border border-line"
        />
      )}
      {item.updateType === "VOICE" && item.mediaUrl && (
        <audio controls src={item.mediaUrl} className="w-full" />
      )}
      {item.caption && <p className="text-sm text-foreground-secondary">{item.caption}</p>}
    </div>
  );
}
