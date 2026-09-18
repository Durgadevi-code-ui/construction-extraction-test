type Status = "IDLE" | "PROCESSING" | "VALID" | "INVALID" | "LOCKED";

const STATUS_STYLES: Record<Status, string> = {
  IDLE: "bg-gray-100 text-gray-600",
  PROCESSING: "bg-blue-50 text-blue-700",
  VALID: "bg-green-50 text-green-700",
  INVALID: "bg-red-50 text-red-700",
  LOCKED: "bg-gray-50 text-gray-400",
};

const STATUS_LABELS: Record<Status, string> = {
  IDLE: "Not tested",
  PROCESSING: "Processing…",
  VALID: "Extraction looks good",
  INVALID: "Extraction failed",
  LOCKED: "LOCKED",
};

/** Mirrors lib/construction.ts's RelevanceCheckResult — declared locally
 * because that module is `server-only` and can't be imported into this
 * client component; the API response's `relevance` field is exactly
 * this shape. "notChecked" = no real Worker session to check against
 * (e.g. the standalone Extraction Accuracy Test tool) — treated the
 * same as the old "nothing to report" case, Confirm still offered. */
export type RelevanceCheckResult =
  | { status: "notChecked" }
  | { status: "valid" }
  | { status: "wrongDepartment"; matchedDepartmentName: string | null }
  | { status: "vague" }
  | { status: "workItemMismatch" }
  /** Image path only: the classifier/provider itself failed to run
   * (network/auth/rate-limit/quota/unexpected error) — distinct from
   * "vague" (a completed but inconclusive classification). In
   * practice the API routes reject this before returning 200, so this
   * case is rendered here only defensively. */
  | { status: "checkFailed" };

type Props = {
  status: Status;
  reason?: string;
  confidence?: number | null;
  /** Department + work-item relevance for THIS worker's real session —
   * see lib/construction.ts assessWorkerSubmissionRelevance. Only
   * rendered once `status === "VALID"` (nothing to check on a failed
   * extraction). */
  relevance?: RelevanceCheckResult;
  /** The worker's own department — used only for the wrongDepartment
   * message ("...work performed for the Electrical department"). */
  ownDepartmentName?: string | null;
  workItemCode?: string | null;
  /** Which input method this panel belongs to — only affects the
   * wording of the wrongDepartment message ("this input"/"enter work
   * performed" vs "this image"/"upload an image showing" vs "this
   * recording"/"record a voice update about"). Defaults to "text",
   * preserving the exact wording already in place for typed input. */
  mediaKind?: "text" | "image" | "voice";
  /** The worker's own confirm decision on this ONE combined review —
   * recorded via the same /api/user-validation call this app already
   * had (see app/api/user-validation/route.ts), just no longer
   * presented as a separate "User Validation" step after a distinct
   * "AI Validation" step: both checks above and this decision are one
   * single Validation panel. There is no reject/"Start Over" action —
   * a blocked or not-yet-confirmed result simply shows its message;
   * the worker corrects the input and re-validates through the normal
   * input flow above (the textarea/file picker is never disabled by a
   * blocked result — see lib/locking.ts: only an ACCEPTED result locks
   * anything). */
  decision: "valid" | null;
  busy: boolean;
  onConfirm: () => void;
};

/** Whether relevance rules out confirming at all — wrong department,
 * too vague to judge, or a confident work-item mismatch are NOT
 * accepted as a valid work update (per the department/work-item
 * relevance business rule). No action is offered for these; the
 * worker edits their input and validates again through the normal
 * flow. "valid" and "notChecked" (nothing conclusive to block on) both
 * allow Confirm, exactly as before this relevance check existed. */
function blocksConfirm(relevance: RelevanceCheckResult | undefined): boolean {
  return (
    relevance?.status === "wrongDepartment" ||
    relevance?.status === "vague" ||
    relevance?.status === "workItemMismatch" ||
    relevance?.status === "checkFailed"
  );
}

/** Wording for the wrongDepartment message's noun ("this input"/"this
 * image"/"this recording") and its closing instruction — see
 * mediaKind's doc on Props. `ownDepartmentName` already includes the
 * word "Department" (e.g. "Electrical Department"), so each closing
 * clause is built to end cleanly on that name rather than appending a
 * second, redundant "department". */
const MEDIA_NOUN: Record<"text" | "image" | "voice", string> = {
  text: "input",
  image: "image",
  voice: "recording",
};

function closingInstruction(mediaKind: "text" | "image" | "voice", ownDepartmentName?: string | null): string {
  const dept = ownDepartmentName ?? "your own department";
  switch (mediaKind) {
    case "image":
      return `Please upload an image showing ${dept} work.`;
    case "voice":
      return `Please record a voice update about ${dept} work.`;
    case "text":
    default:
      return `Please describe work performed for ${dept}.`;
  }
}

function RelevanceMessage({
  relevance,
  ownDepartmentName,
  workItemCode,
  mediaKind = "text",
}: {
  relevance: RelevanceCheckResult;
  ownDepartmentName?: string | null;
  workItemCode?: string | null;
  mediaKind?: "text" | "image" | "voice";
}) {
  switch (relevance.status) {
    case "valid":
      return (
        <div className="space-y-0.5">
          <p className="text-xs font-medium text-green-700">✓ Department matches{ownDepartmentName ? ` (${ownDepartmentName})` : ""}.</p>
          {workItemCode && <p className="text-xs font-medium text-green-700">✓ Matches selected work item ({workItemCode}).</p>}
        </div>
      );
    case "wrongDepartment":
      return (
        <p className="text-xs font-medium text-error">
          ✕ This {MEDIA_NOUN[mediaKind]} appears to be related to
          {relevance.matchedDepartmentName ? ` ${relevance.matchedDepartmentName}` : " another department"},
          not{ownDepartmentName ? ` ${ownDepartmentName}` : " your department"}.{" "}
          {closingInstruction(mediaKind, ownDepartmentName)}
        </p>
      );
    case "vague":
      return (
        <p className="text-xs font-medium text-amber-700">
          ⚠ More information is required. Please describe what work was completed.
        </p>
      );
    case "workItemMismatch":
      return (
        <p className="text-xs font-medium text-error">
          ✕ This update does not appear to match the selected work item{workItemCode ? ` (${workItemCode})` : ""}.
        </p>
      );
    case "checkFailed":
      return (
        <p className="text-xs font-medium text-amber-700">
          ⚠ We couldn&apos;t verify this {MEDIA_NOUN[mediaKind]} right now. Please try again.
        </p>
      );
    case "notChecked":
      return null;
  }
}

/**
 * ONE combined Validation step — replaces the old two-stage UI (an
 * "AI Validation" status display, then, once that passed, a visually
 * separate "User Validation" heading with its own Valid/Invalid
 * buttons). Extraction quality, department relevance, and work-item
 * relevance are all reported together, and the worker's own
 * confirm action is the single decision point — nothing about any
 * underlying check was removed, only how many distinct steps a worker
 * has to click through. A wrong-department, too-vague, or
 * work-item-mismatch result blocks Confirm entirely (see
 * blocksConfirm) and offers no action at all — the worker corrects
 * their input and re-validates through the normal input flow, rather
 * than clicking a separate "Start Over" action.
 */
export default function ValidationPanel({
  status,
  reason,
  confidence,
  relevance,
  ownDepartmentName,
  workItemCode,
  mediaKind = "text",
  decision,
  busy,
  onConfirm,
}: Props) {
  const blocked = status === "VALID" && blocksConfirm(relevance);

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="text-xs font-medium text-foreground-secondary">Validation</p>

      <div className="space-y-1">
        <span className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${STATUS_STYLES[status]}`}>
          {STATUS_LABELS[status]}
        </span>
        {confidence !== undefined && confidence !== null && (
          <p className="text-xs text-foreground-muted">Confidence: {confidence.toFixed(2)}</p>
        )}
        {reason && <p className="text-xs text-foreground-muted">{reason}</p>}
      </div>

      {status === "VALID" && relevance && (
        <RelevanceMessage
          relevance={relevance}
          ownDepartmentName={ownDepartmentName}
          workItemCode={workItemCode}
          mediaKind={mediaKind}
        />
      )}

      {status === "VALID" &&
        (decision === "valid" ? (
          <p className="text-sm font-medium text-green-700">Confirmed — continuing to submit.</p>
        ) : blocked ? null : (
          <div className="flex gap-2 pt-1">
            <button
              onClick={onConfirm}
              disabled={busy}
              className="px-3 py-1.5 bg-green-600 text-white rounded text-sm font-medium disabled:opacity-50"
            >
              Confirm &amp; Continue
            </button>
          </div>
        ))}
    </div>
  );
}
