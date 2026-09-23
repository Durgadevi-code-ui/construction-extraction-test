"use client";

import { useState } from "react";
import HandwritingUpload from "@/components/HandwritingUpload";
import VoiceUpload from "@/components/VoiceUpload";
import TextInput, { type ConfirmedWorkItem } from "@/components/TextInput";
import WorkerSubmitForm from "@/components/workflow/WorkerSubmitForm";
import {
  applyValidationResult,
  initialLockState,
  isLocked,
  resetLock,
  type InputType,
} from "@/lib/locking";

type Props = {
  workerId: string;
  workItemId: string;
  workItemCode: string;
  workItemDescription: string;
  departmentName: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  /** Optional Task context picked for this work item (server re-verifies). */
  taskId?: string | null;
  taskLabel?: string | null;
  /** Whether workItemId is the Worker's own explicit pick in
   * WorkItemSelector, vs. the system's own auto-suggested default (see
   * app/workflow/worker/page.tsx isAutoSuggested) — passed through to
   * every input method so the similar-work-item ambiguity check
   * (lib/construction.ts resolveWorkItemAmbiguity) only trusts the
   * current work item silently when the Worker actually chose it.
   * Defaults to true so any other caller keeps the old behavior. */
  workItemExplicitlySelected?: boolean;
};

/**
 * Worker's daily update: choose one input method, extract/validate it
 * (reusing the existing Extraction Accuracy Test components/APIs
 * unchanged), review the result, then explicitly submit it to the
 * existing Progress Workflow. Extraction success alone never submits
 * anything — only the explicit "Submit Progress" click does.
 *
 * Typed text is the primary, immediately-visible path (see AGENTS.md
 * master prompt section 3/13: "typed text must remain available...
 * immediately accessible... do not force the Worker through
 * Handwriting -> Voice -> Text... before reaching the actual work
 * update"). Handwriting/Voice remain fully functional but sit behind a
 * collapsed "Other ways to update" toggle, not the default view.
 */
export default function DailyWorkUpdate({
  workerId,
  workItemId,
  workItemCode,
  workItemDescription,
  departmentName,
  plannedQuantity,
  unitOfMeasure,
  taskId = null,
  taskLabel = null,
  workItemExplicitlySelected = true,
}: Props) {
  const [lockState, setLockState] = useState(initialLockState);
  const [reviewedText, setReviewedText] = useState<string | null>(null);
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
  const [showOtherMethods, setShowOtherMethods] = useState(false);
  // Set only when the worker picked one of several similar work items
  // (see TextInput) — the submission then targets that item instead of
  // the dropdown's selection. Server re-verifies assignment on submit.
  const [confirmedItem, setConfirmedItem] = useState<ConfirmedWorkItem | null>(null);
  // Set when the worker explicitly resolved a strong task conflict by
  // choosing "Use <suggested task>" (see TextInput's taskConflict UI) —
  // the submission then targets THAT task instead of the dropdown's
  // original selection. Server re-verifies it belongs to the work item
  // on submit, same as every other task id.
  const [confirmedTask, setConfirmedTask] = useState<{ id: string; label: string } | null>(null);

  function handleResult(
    type: InputType,
    status: "VALID" | "INVALID",
    normalizedText?: string,
    confirmed?: ConfirmedWorkItem,
    effectiveTask?: { id: string; label: string }
  ) {
    setLockState((prev) => applyValidationResult(prev, type, status));
    if (status === "VALID" && normalizedText) {
      setConfirmedItem(confirmed ?? null);
      setConfirmedTask(effectiveTask ?? null);
      setReviewedText(normalizedText);
      setSubmittedMessage(null);
    }
  }

  function handleReset() {
    setLockState(resetLock());
    setReviewedText(null);
    setConfirmedItem(null);
    setConfirmedTask(null);
  }

  function handleSubmitted() {
    setSubmittedMessage("Progress submitted to Subcontractor.");
    handleReset();
  }

  // A task belongs to the work item it was picked under; if the worker
  // confirmed a DIFFERENT similar work item, the task no longer applies.
  const effectiveTaskId =
    taskId && (!confirmedItem || confirmedItem.workItemId === workItemId) ? taskId : null;

  // Once the worker resolves a strong task conflict by choosing "Use
  // <suggested task>" (see TextInput's taskConflict UI), THAT task is
  // what actually gets submitted — never silently overridden back to
  // the dropdown's original selection.
  const submittedTaskId = confirmedTask?.id ?? effectiveTaskId;
  const submittedTaskLabel = confirmedTask?.label ?? taskLabel;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-foreground">Today&apos;s Update</h2>
        <p className="text-sm text-foreground-secondary">
          Type what you completed today, then review and submit.
        </p>
        {submittedTaskId && submittedTaskLabel && (
          <p className="text-xs text-foreground-secondary">Task: {submittedTaskLabel}</p>
        )}
      </div>

      {submittedMessage && (
        <p className="text-sm text-success bg-success-soft border border-success-border rounded-lg p-3 font-medium">
          {submittedMessage}
        </p>
      )}

      {lockState.acceptedType && !reviewedText && (
        <div className="bg-success-soft border border-success-border text-success rounded-lg p-4 text-sm font-medium">
          One valid input has been accepted. Other input methods are now locked.
          <button onClick={handleReset} className="ml-3 underline text-success transition-colors duration-150">
            Start Over
          </button>
        </div>
      )}

      <div className="grid gap-4">
        <TextInput
          locked={isLocked(lockState, "TEXT")}
          onResult={(status, text, confirmed, task) => handleResult("TEXT", status, text, confirmed, task)}
          workItemId={workItemId}
          taskId={effectiveTaskId}
          taskLabel={taskLabel}
          workItemCode={workItemCode}
          workItemDescription={workItemDescription}
          departmentName={departmentName}
          workItemExplicitlySelected={workItemExplicitlySelected}
        />

        {!showOtherMethods ? (
          <button
            type="button"
            onClick={() => setShowOtherMethods(true)}
            className="text-xs text-foreground-muted hover:text-foreground-secondary hover:underline self-start"
          >
            Other ways to update (photo, voice) ▾
          </button>
        ) : (
          <>
            <HandwritingUpload
              locked={isLocked(lockState, "HANDWRITTEN")}
              onResult={(status, text, confirmed, task) => handleResult("HANDWRITTEN", status, text, confirmed, task)}
              workItemId={workItemId}
              taskId={effectiveTaskId}
              taskLabel={taskLabel}
              workItemCode={workItemCode}
              workItemDescription={workItemDescription}
              departmentName={departmentName}
              workItemExplicitlySelected={workItemExplicitlySelected}
            />
            <VoiceUpload
              locked={isLocked(lockState, "VOICE")}
              onResult={(status, text, confirmed, task) => handleResult("VOICE", status, text, confirmed, task)}
              workItemId={workItemId}
              taskId={effectiveTaskId}
              taskLabel={taskLabel}
              workItemCode={workItemCode}
              workItemDescription={workItemDescription}
              departmentName={departmentName}
              workItemExplicitlySelected={workItemExplicitlySelected}
            />
          </>
        )}
      </div>

      {reviewedText && (
        <WorkerSubmitForm
          key={`${reviewedText}|${confirmedItem?.workItemId ?? ""}`}
          workerId={workerId}
          workItemId={confirmedItem?.workItemId ?? workItemId}
          plannedQuantity={confirmedItem ? confirmedItem.plannedQuantity : plannedQuantity}
          unitOfMeasure={confirmedItem ? confirmedItem.unitOfMeasure : unitOfMeasure}
          taskId={submittedTaskId}
          initialDescription={reviewedText}
          onSubmitted={handleSubmitted}
        />
      )}
    </div>
  );
}
