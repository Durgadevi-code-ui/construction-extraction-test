"use client";

import { useState } from "react";
import ValidationPanel, { type RelevanceCheckResult } from "./ValidationPanel";

export type ConfirmedWorkItem = {
  workItemId: string;
  code: string;
  description: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
};

type TaskRef = { id: string; label: string };

type Props = {
  locked: boolean;
  onResult: (
    status: "VALID" | "INVALID",
    normalizedText?: string,
    confirmedWorkItem?: ConfirmedWorkItem,
    /** The effective Task actually submitted, once any conflict is
     * resolved (see taskConflict below) — same id the worker selected
     * unless they explicitly chose "Use <suggested task>". Undefined
     * when no task was selected at all. */
    effectiveTask?: TaskRef
  ) => void;
  /** The currently selected work item's id — lets /api/text detect
   * several similar assigned work items and ask instead of guessing.
   * Omitted by callers with no selected work item. */
  workItemId?: string | null;
  /** Optional Task context for the selected work item (validated
   * server-side in /api/text). */
  taskId?: string | null;
  taskLabel?: string | null;
  /** The Worker's currently selected work item, if any — passed through
   * to /api/text so the single Validation step can also check the
   * extracted text against it (see lib/construction.ts
   * assessWorkerSubmissionRelevance). Omitted by any caller with no
   * selected work item (e.g. the standalone Extraction Accuracy Test
   * tool). */
  workItemCode?: string | null;
  workItemDescription?: string | null;
  /** The Worker's own department — display-only (the relevance check
   * itself is resolved server-side from the real session, never from
   * this prop); shown in the wrong-department message. */
  departmentName?: string | null;
  /** Whether workItemId is the Worker's own explicit pick (WorkItemSelector)
   * vs. the system's auto-suggested default — see app/api/text/route.ts's
   * hasExplicitSelection doc. Defaults to true (explicit) so existing
   * callers that never pass this (e.g. the standalone Extraction Accuracy
   * Test tool) keep the old behavior. */
  workItemExplicitlySelected?: boolean;
};

export default function TextInput({
  locked,
  onResult,
  workItemId,
  taskId,
  taskLabel,
  workItemCode,
  workItemDescription,
  departmentName,
  workItemExplicitlySelected = true,
}: Props) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"IDLE" | "PROCESSING" | "VALID" | "INVALID">("IDLE");
  const [normalizedText, setNormalizedText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [relevance, setRelevance] = useState<RelevanceCheckResult | undefined>(undefined);
  const [userValidation, setUserValidation] = useState<"valid" | null>(null);
  const [userValidationBusy, setUserValidationBusy] = useState(false);
  const [candidates, setCandidates] = useState<ConfirmedWorkItem[] | null>(null);
  const [pickedId, setPickedId] = useState("");
  const [confirmedWorkItem, setConfirmedWorkItem] = useState<ConfirmedWorkItem | null>(null);
  // Strong task conflict (see lib/construction.ts detectTaskConflict) —
  // set only when the server has strong evidence the typed text names a
  // DIFFERENT task than the one selected. Mirrors the work-item
  // ambiguity pattern above (ask, never guess, nothing saved yet), just
  // a single suggested task instead of several tied candidates.
  const [taskConflict, setTaskConflict] = useState<{ selectedTask: TaskRef; suggestedTask: TaskRef } | null>(null);
  const [effectiveTask, setEffectiveTask] = useState<TaskRef | null>(null);

  async function handleSubmit(confirmedWorkItemId?: string, taskConflictDecision?: "keep" | "switch") {
    setStatus("PROCESSING");
    setError("");
    setUserValidation(null);
    setSubmissionId(null);
    setCandidates(null);
    setConfirmedWorkItem(null);
    setTaskConflict(null);
    try {
      const res = await fetch("/api/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          workItemDescription: workItemDescription ?? undefined,
          workItemId: workItemId ?? undefined,
          workItemExplicitlySelected,
          taskId: taskId ?? undefined,
          confirmedWorkItemId,
          taskConflictDecision,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Validation failed.");
        setStatus("IDLE");
        return;
      }
      // Several similar work items matched — ask, don't guess. Nothing
      // has been saved yet; the worker's pick re-sends the same text.
      if (data.ambiguity) {
        setCandidates(data.ambiguity.candidates);
        setPickedId("");
        setStatus("IDLE");
        return;
      }
      // Strong task conflict — same "ask, don't guess, nothing saved
      // yet" contract as the work-item ambiguity above. The worker
      // picks Continue/Use suggested/Cancel below.
      if (data.taskConflict) {
        setTaskConflict(data.taskConflict);
        setStatus("IDLE");
        return;
      }
      setConfirmedWorkItem(data.confirmedWorkItem ?? null);
      setEffectiveTask(data.task ?? null);
      setNormalizedText(data.normalizedText);
      setReason(data.reason);
      setStatus(data.status);
      setSubmissionId(data.submissionId);
      setRelevance(data.relevance);
      if (data.status === "INVALID") {
        onResult("INVALID");
      }
    } catch {
      setError("Request failed.");
      setStatus("IDLE");
    }
  }

  async function handleConfirm() {
    if (!submissionId) return;
    setUserValidationBusy(true);
    setError("");
    try {
      const res = await fetch("/api/user-validation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId, decision: "valid" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "User validation failed.");
        return;
      }
      setUserValidation("valid");
      onResult("VALID", normalizedText, confirmedWorkItem ?? undefined, effectiveTask ?? undefined);
    } catch {
      setError("User validation request failed.");
    } finally {
      setUserValidationBusy(false);
    }
  }

  const displayStatus = locked ? "LOCKED" : status;

  return (
    <div className={`bg-surface rounded-lg border border-line shadow-sm p-5 space-y-3 ${locked ? "opacity-50" : ""}`}>
      <h2 className="font-semibold text-foreground">Normal Typed Text</h2>
      <textarea
        value={text}
        disabled={locked}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a construction update, e.g. Plot 1034, wiring 4 of 7 rooms complete"
        rows={3}
        className="w-full border border-line bg-white text-foreground placeholder:text-foreground-muted rounded p-2 text-sm disabled:bg-[#FAFAFA]"
      />
      <button
        onClick={() => handleSubmit()}
        disabled={locked || status === "PROCESSING"}
        className="px-4 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-semibold transition-colors duration-150 disabled:opacity-50"
      >
        {status === "PROCESSING" ? "Validating…" : "Validate & Normalize"}
      </button>
      {error && <p className="text-error text-sm">{error}</p>}
      {candidates && (
        <fieldset className="text-sm space-y-2 rounded-lg border border-line bg-surface-soft p-3">
          <legend className="px-1 text-sm font-medium text-foreground">
            Several similar work items were found. Please confirm which work item this update belongs to.
          </legend>
          {candidates.map((c) => (
            <label key={c.workItemId} className="flex items-center gap-2 text-foreground">
              <input
                type="radio"
                name="similar-work-item"
                value={c.workItemId}
                checked={pickedId === c.workItemId}
                onChange={() => setPickedId(c.workItemId)}
              />
              {c.code} — {c.description}
            </label>
          ))}
          <button
            type="button"
            onClick={() => handleSubmit(pickedId)}
            disabled={!pickedId || status === "PROCESSING"}
            className="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            Confirm
          </button>
        </fieldset>
      )}
      {taskConflict && (
        <div className="text-sm space-y-2 rounded-lg border border-warning-border bg-warning-soft p-3">
          <p className="font-medium text-foreground">
            Your selected task is &ldquo;{taskConflict.selectedTask.label}&rdquo;, but your update appears to refer
            to &ldquo;{taskConflict.suggestedTask.label}&rdquo;.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleSubmit(undefined, "keep")}
              disabled={status === "PROCESSING"}
              className="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              Continue with {taskConflict.selectedTask.label}
            </button>
            <button
              type="button"
              onClick={() => handleSubmit(undefined, "switch")}
              disabled={status === "PROCESSING"}
              className="px-3 py-1.5 bg-info hover:bg-info/90 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              Use {taskConflict.suggestedTask.label}
            </button>
            <button
              type="button"
              onClick={() => setTaskConflict(null)}
              disabled={status === "PROCESSING"}
              className="px-3 py-1.5 border border-line rounded-lg text-sm font-medium text-foreground-secondary disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {confirmedWorkItem && confirmedWorkItem.workItemId !== workItemId && (
        <p className="text-xs text-foreground-secondary">
          Identified as {confirmedWorkItem.code} — {confirmedWorkItem.description}.
        </p>
      )}
      {effectiveTask && taskId && effectiveTask.id !== taskId && (
        <p className="text-xs text-foreground-secondary">Task: {effectiveTask.label} (switched from {taskLabel ?? "the selected task"}).</p>
      )}
      {normalizedText && (
        <div className="text-sm">
          <p className="text-xs font-medium text-foreground-secondary">Normalized text</p>
          <p className="bg-[#FAFAFA] border border-line text-foreground rounded p-2">{normalizedText}</p>
        </div>
      )}
      <ValidationPanel
        status={displayStatus}
        reason={reason}
        confidence={null}
        relevance={relevance}
        ownDepartmentName={departmentName}
        workItemCode={workItemCode}
        decision={userValidation}
        busy={userValidationBusy}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
