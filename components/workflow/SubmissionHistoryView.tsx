"use client";

import { Fragment, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Camera, ChevronDown, History, SearchX, SlidersHorizontal } from "lucide-react";
import { formatDateUS, formatPercent, formatTimeUS, type WorkerSubmissionStatusCode } from "@/lib/format";
import Badge, { type BadgeVariant } from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Input";
import DateInput from "@/components/ui/DateInput";
import type { SubmissionHistoryRow } from "@/components/workflow/SubmissionHistoryTable";
import LiveUpdateFeed from "@/components/workflow/LiveUpdateFeed";
import SortControl, { nextSort, type SortDir } from "@/components/workflow/SortControl";

/** Light status tint per review state — green approved, light red
 * returned, light amber anything still in review. */
const STATUS_VARIANT: Record<WorkerSubmissionStatusCode, BadgeVariant> = {
  APPROVED: "success",
  ROLLED_BACK: "error",
  AWAITING_FOREMAN_REVIEW: "warning",
  AWAITING_SUPERVISOR_APPROVAL: "warning",
};

type SortKey = "date" | "worker" | "workItem" | "submitted" | "status";
type SubmittedFilter = "ALL" | "ADJUSTED" | "AS_SUBMITTED";

/** Direction a column starts in when first clicked — newest first for
 * Date, largest first for Submitted, A–Z for the text columns. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  date: "desc",
  worker: "asc",
  workItem: "asc",
  submitted: "desc",
  status: "asc",
};

/** Same columns, for the "Sort by" control (mobile card layout). */
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "worker", label: "Worker" },
  { key: "workItem", label: "Work Item" },
  { key: "submitted", label: "Submitted" },
  { key: "status", label: "Status & Review" },
];

/** Every filter control (date or dropdown) has this exact height and
 * padding, so the six History filters line up as one row. */
const FILTER_CONTROL = "h-10 !py-0 truncate";

/** Every column heading — sortable or not — uses exactly this style, so
 * no heading reads bolder or lighter than another. */
const HEADING_CLASS = "px-5 py-2.5 font-bold uppercase tracking-wide";

/** A timestamp as two consistent parts — MM/DD/YYYY and h:mm AM — the
 * one date/time presentation used everywhere in this list. */
function DateTime({ value, className = "" }: { value: string; className?: string }) {
  const time = formatTimeUS(value);
  return (
    <span className={`tabular-nums ${className}`}>
      <span className="block">{formatDateUS(value, "/")}</span>
      {time && <span className="block text-xs text-foreground-muted">{time}</span>}
    </span>
  );
}

/** Sortable column header — the whole label is the button; ↑ / ↓ shows
 * the active column's direction, a faint ↕ the others. Every heading
 * has the same weight and color (the thead's); only the arrow marks the
 * active column. */
function SortHeader({
  label,
  column,
  sort,
  onSort,
  align = "left",
}: {
  label: React.ReactNode;
  column: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === column;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className={`${align === "right" ? "text-right" : "text-left"} ${HEADING_CLASS}`}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 uppercase tracking-wide font-bold transition-colors duration-150 hover:text-foreground"
        title={`Sort by ${typeof label === "string" ? label : "this column"}`}
      >
        {label}
        <Icon className={`h-3 w-3 ${active ? "" : "opacity-40"}`} strokeWidth={2.25} aria-hidden />
      </button>
    </th>
  );
}

/** The viewer's own calendar day for a timestamp (yyyy-mm-dd) — the same
 * local day formatDateUS shows in the Date column, so a date filter and
 * the displayed date always agree. */
function localDay(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The number the Submitted column shows: the quantity when the
 * submission has one, otherwise its percentage. */
function submittedValue(item: SubmissionHistoryRow): number {
  return item.submittedQuantity ?? item.submittedProgress;
}

function wasAdjusted(item: SubmissionHistoryRow): boolean {
  return item.correctedProgress != null && item.correctedProgress !== item.submittedProgress;
}

/**
 * Submission History table with filters (Date, Worker, Work Item,
 * Submitted, Status & Review) and ↑/↓ column sorting (Date, Worker, Work
 * Item, Submitted, Status & Review) — client-side over the rows the
 * server already scoped to the caller's current project/department
 * (lib/workflow.ts getSubmissionHistory), so a filter can only ever
 * narrow what this user may see, never widen it. Filter options come
 * from the loaded rows themselves: worker names, work item codes and
 * the existing review statuses — nothing invented.
 */
export default function SubmissionHistoryView({
  items,
  initialWorkItem = "",
  focusSubmissionId = null,
  query = "",
}: {
  items: SubmissionHistoryRow[];
  /** Work item pre-selected in the Work Item filter (e.g. opened from a
   * work item's History action). */
  initialWorkItem?: string;
  /** Submission a notification points at — highlighted, marked
   * data-focused for the page's scroll-into-view. */
  focusSubmissionId?: string | null;
  /** The page's universal search text (header toolbar, next to Project)
   * — narrows the records the same way a filter does, on top of them:
   * worker, work item code/name, task, department, status or comment. */
  query?: string;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [worker, setWorker] = useState("");
  const [workItem, setWorkItem] = useState(initialWorkItem);
  const [submitted, setSubmitted] = useState<SubmittedFilter>("ALL");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  // Same column again flips the direction; a new column starts in its
  // natural direction.
  function toggleSort(key: SortKey) {
    setSort((prev) => nextSort(prev, key, DEFAULT_DIR));
  }
  // Mobile only: the filter fields fold away behind one "Filters" button
  // so the records stay in view; always open from the sm breakpoint up.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Which row's Live Updates are open (one at a time).
  const [liveUpdatesFor, setLiveUpdatesFor] = useState<string | null>(null);

  const workerOptions = useMemo(
    () => [...new Set(items.map((i) => i.workerName))].sort((a, b) => a.localeCompare(b)),
    [items]
  );
  const workItemOptions = useMemo(
    () =>
      [...new Map(items.map((i) => [i.workItemCode, i.workItemDescription])).entries()].sort(([a], [b]) =>
        a.localeCompare(b, undefined, { numeric: true })
      ),
    [items]
  );
  // Status key = the existing review status code when present, else its label.
  const statusOptions = useMemo(
    () => [...new Map(items.map((i) => [i.reviewStatusCode ?? i.reviewStatusLabel, i.reviewStatusLabel])).entries()],
    [items]
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = items.filter((i) => {
      if (
        needle &&
        ![
          i.workerName,
          i.departmentName,
          i.workItemCode,
          i.workItemDescription,
          i.taskLabel,
          i.reviewStatusLabel,
          i.approvalComments,
          i.approvedBy,
        ].some((t) => (t ?? "").toLowerCase().includes(needle))
      ) {
        return false;
      }
      const day = localDay(i.submittedAt);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (worker && i.workerName !== worker) return false;
      if (workItem && i.workItemCode !== workItem) return false;
      if (submitted === "ADJUSTED" && !wasAdjusted(i)) return false;
      if (submitted === "AS_SUBMITTED" && wasAdjusted(i)) return false;
      if (status && (i.reviewStatusCode ?? i.reviewStatusLabel) !== status) return false;
      return true;
    });
    // Sorts the rows exactly as displayed (worker name, work item code,
    // submitted amount, status label, submitted date); ties fall back to
    // newest first.
    const byDate = (a: SubmissionHistoryRow, b: SubmissionHistoryRow) => a.submittedAt.localeCompare(b.submittedAt);
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let primary: number;
      switch (sort.key) {
        case "worker":
          primary = a.workerName.localeCompare(b.workerName);
          break;
        case "workItem":
          primary = a.workItemCode.localeCompare(b.workItemCode, undefined, { numeric: true });
          break;
        case "submitted":
          primary = submittedValue(a) - submittedValue(b);
          break;
        case "status":
          primary = a.reviewStatusLabel.localeCompare(b.reviewStatusLabel);
          break;
        default:
          return sign * byDate(a, b);
      }
      return sign * primary || byDate(b, a);
    });
  }, [items, query, from, to, worker, workItem, submitted, status, sort]);

  const activeFilterCount = [from, to, worker, workItem, status, submitted !== "ALL"].filter(Boolean).length;
  const filtersActive = activeFilterCount > 0;
  function clearFilters() {
    setFrom("");
    setTo("");
    setWorker("");
    setWorkItem("");
    setSubmitted("ALL");
    setStatus("");
  }

  if (items.length === 0) {
    return (
      <Card className="!p-0 overflow-hidden">
        <EmptyState icon={History} title="No submissions found" />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-surface p-4 text-sm shadow-sm">
        <div className="flex items-center justify-between gap-2">
          {/* Mobile: a toggle with the active-filter count; sm+: a plain heading. */}
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            className="sm:hidden inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold text-foreground"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${filtersOpen ? "rotate-180" : ""}`} strokeWidth={2} aria-hidden />
          </button>
          <p className="hidden sm:block font-semibold text-foreground">Filters</p>
          <span className="text-xs text-foreground-muted tabular-nums">
            {shown.length === items.length ? `${items.length} records` : `${shown.length} of ${items.length} records`}
          </span>
        </div>
        <div className={`${filtersOpen ? "grid" : "hidden"} sm:grid mt-3 grid-cols-1 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-x-3 gap-y-3`}>
          <div>
            <label className="block text-xs font-bold text-foreground mb-1.5">From</label>
            <DateInput value={from} onChange={setFrom} label="From" />
          </div>
          <div>
            <label className="block text-xs font-bold text-foreground mb-1.5">To</label>
            <DateInput value={to} onChange={setTo} label="To" />
          </div>
          <div>
            <label className="block text-xs font-bold text-foreground mb-1.5">Worker</label>
            <Select className={FILTER_CONTROL} value={worker} onChange={(e) => setWorker(e.target.value)}>
              <option value="">All Workers</option>
              {workerOptions.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs font-bold text-foreground mb-1.5">Work Item</label>
            <Select className={FILTER_CONTROL} value={workItem} onChange={(e) => setWorkItem(e.target.value)}>
              <option value="">All Work Items</option>
              {workItemOptions.map(([code, description]) => (
                <option key={code} value={code}>
                  {code} — {description}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-xs font-bold text-foreground mb-1.5">Submitted</label>
            <Select className={FILTER_CONTROL} value={submitted} onChange={(e) => setSubmitted(e.target.value as SubmittedFilter)}>
              <option value="ALL">All</option>
              <option value="AS_SUBMITTED">As submitted</option>
              <option value="ADJUSTED">Adjusted by reviewer</option>
            </Select>
          </div>
          <div>
            <label className="block text-xs font-bold text-foreground mb-1.5">Status &amp; Review</label>
            <Select className={FILTER_CONTROL} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All Statuses</option>
              {statusOptions.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="mt-3 text-xs font-medium text-brand transition-colors duration-150 hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Mobile sort — the table's sortable headings aren't shown in the
          card layout, so the same sort is offered here. */}
      {shown.length > 0 && (
        <SortControl
          className="md:hidden"
          options={SORT_OPTIONS}
          sort={sort}
          onChange={setSort}
          defaultDir={DEFAULT_DIR}
        />
      )}

      <Card className="!p-0 overflow-hidden">
        {shown.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="No history records match the selected filters."
            action={
              <button
                type="button"
                onClick={clearFilters}
                className="text-sm font-medium text-brand transition-colors duration-150 hover:underline"
              >
                Clear filters
              </button>
            }
          />
        ) : (
          <>
          {/* Mobile: one card per record (same data, same actions). */}
          <ul className="md:hidden divide-y divide-line">
            {shown.map((item) => (
              <li
                key={item.submissionId}
                data-focused={item.submissionId === focusSubmissionId ? "true" : undefined}
                className={`scroll-mt-4 p-4 space-y-2 text-sm ${
                  item.submissionId === focusSubmissionId ? "bg-warning-soft/40 ring-2 ring-inset ring-warning-border" : ""
                }`}
              >
                {item.submissionId === focusSubmissionId && <Badge variant="warning">From your notification</Badge>}
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0">
                    <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
                    <span className="font-medium">{item.workItemDescription}</span>
                    {item.taskLabel && (
                      <span className="block text-xs text-foreground-secondary">Task: {item.taskLabel}</span>
                    )}
                  </p>
                  <DateTime value={item.submittedAt} className="shrink-0 text-right text-xs text-foreground-secondary" />
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="font-bold uppercase tracking-wide text-foreground-secondary">Worker</dt>
                  <dd>
                    {item.workerName} <span className="text-foreground-muted">({item.departmentName})</span>
                  </dd>
                  <dt className="font-bold uppercase tracking-wide text-foreground-secondary">Submitted</dt>
                  <dd className="tabular-nums">
                    {item.submittedQuantity !== null
                      ? `${item.submittedQuantity} ${item.unit ?? ""}`.trim()
                      : `${item.submittedProgress}%`}
                    {wasAdjusted(item) && (
                      <span className="text-foreground-secondary"> · adjusted to {formatPercent(item.correctedProgress)}</span>
                    )}
                  </dd>
                  <dt className="font-bold uppercase tracking-wide text-foreground-secondary">Status</dt>
                  <dd className="space-y-0.5">
                    {item.reviewStatusCode ? (
                      <Badge variant={STATUS_VARIANT[item.reviewStatusCode]}>{item.reviewStatusLabel}</Badge>
                    ) : (
                      item.reviewStatusLabel
                    )}
                    {item.approvedBy && (
                      <span className="block text-foreground-secondary">
                        Approved by {item.approvedBy}
                        {item.approvedAt ? ` · ${formatDateUS(item.approvedAt, "/")} ${formatTimeUS(item.approvedAt)}` : ""}
                      </span>
                    )}
                    {item.approvalComments && (
                      <span className="block text-foreground-secondary">Comment: {item.approvalComments}</span>
                    )}
                  </dd>
                </dl>
                <Button
                  variant={liveUpdatesFor === item.submissionId ? "primary" : "secondary"}
                  size="sm"
                  className="w-full"
                  onClick={() => setLiveUpdatesFor((prev) => (prev === item.submissionId ? null : item.submissionId))}
                  aria-expanded={liveUpdatesFor === item.submissionId}
                >
                  <Camera className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  {liveUpdatesFor === item.submissionId ? "Hide Updates" : "View Updates"}
                </Button>
                {liveUpdatesFor === item.submissionId && (
                  <div className="rounded-lg bg-surface-soft p-3">
                    <LiveUpdateFeed mode="imageOnly" initialFilterCode={item.workItemCode} />
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-soft text-[11px] uppercase tracking-wide text-foreground">
                <tr>
                  <SortHeader label="Date" column="date" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Worker" column="worker" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Work Item" column="workItem" sort={sort} onSort={toggleSort} />
                  <SortHeader label="Submitted" column="submitted" sort={sort} onSort={toggleSort} align="right" />
                  <SortHeader label={"Status & Review"} column="status" sort={sort} onSort={toggleSort} />
                  <th className={`text-left ${HEADING_CLASS}`}>Updates</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((item) => (
                  <Fragment key={item.submissionId}>
                  <tr
                    data-focused={item.submissionId === focusSubmissionId ? "true" : undefined}
                    className={`scroll-mt-4 transition-colors duration-150 hover:bg-surface-hover ${
                      item.submissionId === focusSubmissionId ? "bg-warning-soft/40 ring-2 ring-inset ring-warning-border" : ""
                    }`}
                  >
                    <td className="px-5 py-3 whitespace-nowrap text-foreground-secondary">
                      <DateTime value={item.submittedAt} />
                      {item.submissionId === focusSubmissionId && (
                        <span className="block mt-1">
                          <Badge variant="warning">From your notification</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="font-medium">{item.workerName}</span>{" "}
                      <span className="text-foreground-muted">({item.departmentName})</span>
                    </td>
                    <td className="px-5 py-3">
                      <span className="text-foreground-secondary">{item.workItemCode}</span>{" "}
                      {item.workItemDescription}
                      {item.taskLabel && (
                        <span className="block text-xs text-foreground-secondary">Task: {item.taskLabel}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right font-medium tabular-nums whitespace-nowrap">
                      {item.submittedQuantity !== null
                        ? `${item.submittedQuantity} ${item.unit ?? ""}`.trim()
                        : `${item.submittedProgress}%`}
                      {wasAdjusted(item) && (
                        <span className="block text-xs font-normal text-foreground-secondary">
                          adjusted to {formatPercent(item.correctedProgress)}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 space-y-0.5">
                      {item.reviewStatusCode ? (
                        <Badge variant={STATUS_VARIANT[item.reviewStatusCode]}>{item.reviewStatusLabel}</Badge>
                      ) : (
                        item.reviewStatusLabel
                      )}
                      {item.approvedBy && (
                        <span className="block text-xs text-foreground-secondary">
                          Approved by {item.approvedBy}
                          {item.approvedAt ? ` · ${formatDateUS(item.approvedAt, "/")} ${formatTimeUS(item.approvedAt)}` : ""}
                        </span>
                      )}
                      {item.approvalComments && (
                        <span className="block text-xs text-foreground-secondary">Comment: {item.approvalComments}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-left">
                      <Button
                        variant={liveUpdatesFor === item.submissionId ? "primary" : "secondary"}
                        size="sm"
                        className="whitespace-nowrap"
                        onClick={() =>
                          setLiveUpdatesFor((prev) => (prev === item.submissionId ? null : item.submissionId))
                        }
                        aria-expanded={liveUpdatesFor === item.submissionId}
                      >
                        <Camera className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                        {liveUpdatesFor === item.submissionId ? "Hide Updates" : "View Updates"}
                      </Button>
                    </td>
                  </tr>
                  {/* This row's work item Live Updates, directly under it —
                      the existing image-only feed, fetched server-scoped to
                      this user's own access (a Worker sees only their own
                      updates; reviewers their department's). */}
                  {liveUpdatesFor === item.submissionId && (
                    <tr>
                      <td colSpan={6} className="bg-surface-soft px-5 py-4">
                        <LiveUpdateFeed mode="imageOnly" initialFilterCode={item.workItemCode} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

    </div>
  );
}
