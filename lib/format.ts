/**
 * Pure display-formatting helpers shared by server (lib/workflow.ts) and
 * client (components/workflow/*) code. No data access here — just turning
 * raw values already fetched from Supabase into role-friendly UI text.
 */

export function formatUserDisplayName(input: {
  firstName?: string | null;
  lastName?: string | null;
  email: string;
}): string {
  const full = [input.firstName, input.lastName].filter(Boolean).join(" ").trim();
  if (full) return full;

  const prefix = input.email.split("@")[0] || input.email;
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

const APPROVAL_STATUS_LABELS: Record<string, string> = {
  APPROVED: "Approved",
  ROLLED_BACK: "Rolled Back",
};

/** Humanizes a user_validations.approval_status value. Null means not yet approved. */
export function humanizeApprovalStatus(status: string | null): string {
  if (status === null) return "Pending Approval";
  return APPROVAL_STATUS_LABELS[status] ?? status;
}

export type WorkerSubmissionStatusCode =
  | "AWAITING_FOREMAN_REVIEW"
  | "AWAITING_SUPERVISOR_APPROVAL"
  | "APPROVED"
  | "ROLLED_BACK";

/** Display text only — WorkerSubmissionStatusCode keys (internal, used
 * for routing/logic elsewhere) are unchanged. */
const WORKER_SUBMISSION_STATUS_LABELS: Record<WorkerSubmissionStatusCode, string> = {
  AWAITING_FOREMAN_REVIEW: "Submitted — Awaiting Subcontractor Review",
  AWAITING_SUPERVISOR_APPROVAL: "Forwarded to Contractor — Awaiting Approval",
  APPROVED: "Approved",
  ROLLED_BACK: "Rolled Back",
};

export function humanizeWorkerSubmissionStatus(
  code: WorkerSubmissionStatusCode
): string {
  return WORKER_SUBMISSION_STATUS_LABELS[code];
}

/** Display label for a users.user_role / user_project_roles.role value —
 * shared by notification text (lib/notifications.ts) and anywhere else
 * a role needs to read as the construction-industry term this app uses
 * elsewhere (e.g. CONTRACTOR_ROLES = Contractor, FOREMAN = Subcontractor). */
const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Admin",
  SUPERVISOR: "Contractor",
  MANAGER: "Contractor",
  FOREMAN: "Subcontractor",
  WORKER: "Worker",
};

export function humanizeRole(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/**
 * Display-only quantity formatter — fixes floating-point artifacts
 * (e.g. 219.98000000000002 from summing decimal quantities in JS)
 * without touching the underlying value anywhere it's stored or
 * calculated. Rounds to at most 2 decimal places and never shows
 * trailing zeros (220.50 -> "220.5", 300.00 -> "300"), matching every
 * other quantity/amount already formatted this way in this app (see
 * money() in components/workflow/DashboardPanel.tsx). Never call this
 * before storing/comparing a value — only when rendering it.
 */
export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Display-only percentage formatter — same rounding/trailing-zero
 * rule as formatQuantity above, plus the trailing "%". The underlying
 * progress calculation (lib/calculations.ts calculateProgressPercentage)
 * already rounds to 2 decimals before this is ever called; this exists
 * so every percentage on screen goes through one consistent formatter
 * rather than ad hoc `${value}%` template strings scattered around the
 * UI, and so a percentage computed elsewhere without that rounding
 * (e.g. summed/averaged client-side) still displays cleanly.
 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

/**
 * US date format (MM-DD-YYYY, 4-digit year) for every user-facing date
 * in this app — display only, never touches how a date is stored
 * (still ISO/timestamptz in the database) or compared/queried.
 * `input` accepts an ISO date/timestamp string, a Date, or
 * null/undefined (returns "—", never a fabricated date).
 *
 * Date-only strings (`YYYY-MM-DD` — e.g. a native `<input type="date">`
 * value, or any bare "date" field with no time component) are parsed
 * directly from their calendar digits, NOT via `new Date(...)` +
 * local getters: per the ECMA-262 spec, `new Date("2026-09-09")` is
 * parsed as UTC midnight, and reading it back with `.getMonth()`/
 * `.getDate()` (both local-timezone) rolls it back to the PREVIOUS
 * calendar day in any timezone behind UTC — most of the US. That
 * would turn 09-09-2026 into 09-08-2026, exactly the bug this
 * function must avoid.
 *
 * A full timestamp (has a time/zone component) or a `Date` instance
 * IS a genuine point in time, not a bare calendar date — converting
 * it to the viewer's own local calendar day via local getters is the
 * correct, intentional behavior there (e.g. "approved at 11pm UTC"
 * should read as whatever day that is for the viewer), so that path
 * is unchanged.
 */
export function formatDateUS(input: string | Date | null | undefined): string {
  if (!input) return "—";

  if (typeof input === "string") {
    const dateOnly = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      const [, yyyy, mm, dd] = dateOnly;
      return `${mm}-${dd}-${yyyy}`;
    }
  }

  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return "—";
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

/**
 * US date + time (e.g. "9/9/2026, 10:59 AM") for a genuine point-in-time
 * timestamp — notification cards (see NotificationBell.tsx) are the one
 * place in this app that shows a time alongside the date, since "when
 * did this happen" matters for a live event feed the way it doesn't for
 * a plain calendar date elsewhere. Locale is pinned to "en-US" rather
 * than left to the runtime default: an unpinned `toLocaleString()` reads
 * the server/browser's own locale, which is exactly what produced the
 * DD-MM-YYYY bug this app already fixed once for date-only values (see
 * formatDateUS above) — pinning here avoids reintroducing that same bug
 * for timestamps.
 */
export function formatDateTimeUS(input: string | Date | null | undefined): string {
  if (!input) return "—";
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
