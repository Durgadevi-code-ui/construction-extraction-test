"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ImageOff } from "lucide-react";
import TabNav from "@/components/workflow/TabNav";
import { formatDateTimeUS, formatDateUS } from "@/lib/format";
import EmptyState from "@/components/ui/EmptyState";
import { SkeletonRows } from "@/components/ui/Skeleton";
import Card from "@/components/ui/Card";

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
 * Two distinct uses, controlled by `mode` (NOT two different
 * components, since both share every bit of fetching/day-grouping
 * logic below):
 *   - "normal" (default) — the general Live Updates tab both roles
 *     already have in their sidebar nav. Shows every media type
 *     (image AND voice) for this reviewer's scope, unfiltered by
 *     default. This is the one place voice notes are browsable after
 *     the fact — never make this mode image-only.
 *   - "imageOnly" — the two special, scoped entry points (Contractor's
 *     per-Work-Item button, Subcontractor's per-Department button, see
 *     DashboardPanel.tsx / AssignmentManager.tsx). Images only, no
 *     voice. This does NOT touch worker submission/storage: VOICE rows
 *     are still created and kept exactly as before (see
 *     lib/liveUpdates.ts createLiveUpdate); they're simply not
 *     rendered in this one filtered view.
 *
 * Display is split into "Today's Updates" (default) and "History"
 * (grouped by local calendar day, newest day first) — a pure client-side
 * re-presentation of the same GET response; no new endpoint, no new
 * table/column, nothing deleted. The API already returns every Active
 * live_updates row for this reviewer's department (see
 * listLiveUpdatesForReviewer), newest first — this component only
 * partitions that same array by day for display.
 */
export default function LiveUpdateFeed({
  mode = "normal",
  initialFilterCode = null,
}: {
  mode?: "normal" | "imageOnly";
  /** When set, restricts the feed to this one work item's updates
   * (e.g. Contractor clicking "View Live Updates" on a specific Work
   * Items row) — pure client-side filter of the same reviewer-scoped
   * payload this component already fetches, no API/schema change.
   * Clearable from the UI; defaults to showing everything in scope. */
  initialFilterCode?: string | null;
}) {
  const [items, setItems] = useState<LiveUpdateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"today" | "history">("today");
  // No effect needed to keep this in sync with a later prop change: this
  // component only exists while its parent's "liveUpdates" tab is
  // active, so a new initialFilterCode (from clicking a different Work
  // Item's "View Live Updates") always arrives via a fresh mount, never
  // a re-render of an already-mounted instance.
  const [filterCode, setFilterCode] = useState<string | null>(initialFilterCode);

  // The page's project context (?projectId=, set by the Contractor/Worker
  // project switcher) — forwarded so a user with roles on several
  // projects sees only the current project's field updates.
  const contextProjectId = useSearchParams().get("projectId");

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
        const res = await fetch(
          contextProjectId
            ? `/api/workflow/live-updates?projectId=${encodeURIComponent(contextProjectId)}`
            : "/api/workflow/live-updates"
        );
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
  }, [contextProjectId]);

  const { todayItems, historyGroups, scopedCount } = useMemo(() => {
    const todayKey = localDayKey(new Date());
    const today: LiveUpdateItem[] = [];
    // Map preserves insertion order — items arrive newest-first from the
    // API, so the first time each day-key is seen is already in
    // newest-day-first order; no separate re-sort of groups needed.
    const groups = new Map<string, LiveUpdateItem[]>();

    const byType = mode === "imageOnly" ? items.filter((item) => item.updateType === "PHOTO") : items;
    const scoped = filterCode ? byType.filter((item) => item.workItemCode === filterCode) : byType;

    for (const item of scoped) {
      const day = localDayKey(new Date(item.createdAt));
      if (day === todayKey) {
        today.push(item);
      } else {
        const group = groups.get(day) ?? [];
        group.push(item);
        groups.set(day, group);
      }
    }

    return { todayItems: today, historyGroups: groups, scopedCount: scoped.length };
  }, [items, filterCode, mode]);

  const historyCount = scopedCount - todayItems.length;

  if (loading) {
    return <SkeletonRows count={3} rowHeight="h-24" />;
  }
  if (error) {
    return (
      <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
    );
  }

  return (
    <div className="space-y-3">
      {filterCode &&
        (mode === "imageOnly" ? (
          // The two special image-only entry points are a dedicated
          // per-work-item/per-department view, not a general browser
          // with an optional filter — no "Show all" escape hatch, so
          // this can never end up displaying a different work item's
          // images than the one the reviewer opened.
          <p className="text-xs text-foreground-secondary">
            Images for <span className="font-medium text-foreground">{filterCode}</span>
          </p>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-brand-border bg-brand-soft px-3 py-1.5 text-xs text-foreground-secondary w-fit">
            <span>
              Filtered: <span className="font-medium text-foreground">{filterCode}</span>
            </span>
            <button
              type="button"
              onClick={() => setFilterCode(null)}
              className="font-medium text-brand transition-colors duration-150 hover:underline"
            >
              Show all
            </button>
          </div>
        ))}
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
          <EmptyState icon={ImageOff} title="No live updates for today" />
        ) : (
          <div className="space-y-3">
            {todayItems.map((item) => (
              <LiveUpdateCard key={item.liveUpdateId} item={item} />
            ))}
          </div>
        )
      ) : historyGroups.size === 0 ? (
        <EmptyState icon={ImageOff} title="No older live updates yet" />
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

function LiveUpdateCard({ item }: { item: LiveUpdateItem }) {
  return (
    <Card className="!p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-foreground">
          {item.workerName}
          {item.workItemDescription && (
            <span className="font-normal text-foreground-muted"> — {item.workItemDescription}</span>
          )}
        </span>
        <span className="shrink-0 text-xs text-foreground-muted tabular-nums">
          {formatDateTimeUS(item.createdAt)}
        </span>
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
    </Card>
  );
}
