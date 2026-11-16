"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, RotateCcw } from "lucide-react";
import VoiceUpload from "@/components/VoiceUpload";
import TextInput, { type ConfirmedWorkItem } from "@/components/TextInput";
import WorkerSubmitForm from "@/components/workflow/WorkerSubmitForm";
import LiveUpdateBar from "@/components/workflow/LiveUpdateBar";
import Button from "@/components/ui/Button";
import {
  applyValidationResult,
  initialLockState,
  isLocked,
  resetLock,
  type InputType,
} from "@/lib/locking";

/** The update's existing stages, shown one at a time: capture + validate
 * (VoiceUpload/TextInput), review + submit (WorkerSubmitForm), then the
 * submitted confirmation with the optional photo (LiveUpdateBar). Pure
 * presentation — which stage is current never changes what any stage
 * does or sends. */
export type UpdateStep = "capture" | "review" | "done";

const STEPS: { key: UpdateStep; label: string }[] = [
  { key: "capture", label: "Record & Validate" },
  { key: "review", label: "Review & Submit" },
  { key: "done", label: "Submitted" },
];

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
  /** The current work item's approved total % — passed to the form only
   * when submitting for this same work item (not a different confirmed
   * one, whose approved % isn't loaded here). */
  approvedProgress?: number | null;
  /** Told whenever the visible step changes (and on mount), so the page
   * can show its work item picker only on the first step. */
  onStepChange?: (step: UpdateStep) => void;
};

/**
 * Worker's daily update: choose one input method, extract/validate it
 * (reusing the existing Extraction Accuracy Test components/APIs
 * unchanged), review the result, then explicitly submit it to the
 * existing Progress Workflow. Extraction success alone never submits
 * anything — only the explicit "Submit Progress" click does.
 *
 * Voice is the primary path (shown first, with the prominent Record
 * button); typed text is the secondary path, always visible directly
 * below it — never hidden behind a toggle, so a Worker who can't speak
 * on site still reaches it immediately. Both run exactly the same
 * validate -> review -> submit flow as before.
 *
 * The stages are shown one step at a time (see UpdateStep): confirming a
 * validated update moves straight to Review & Submit, and submitting moves
 * to the Submitted step. Earlier steps stay mounted (just hidden), so Back
 * returns to them with everything as it was.
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
  approvedProgress,
  onStepChange,
}: Props) {
  const [step, setStep] = useState<UpdateStep>("capture");
  // Bumped by "Record another update" so the capture step starts fresh
  // (empty text, no previous Confirmed result) after a submission.
  const [captureKey, setCaptureKey] = useState(0);
  const stepsRef = useRef<HTMLOListElement>(null);
  const captureGridRef = useRef<HTMLDivElement>(null);
  const prevStep = useRef(step);
  const [lockState, setLockState] = useState(initialLockState);
  const [reviewedText, setReviewedText] = useState<string | null>(null);
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
  // Step 2 (after a successful submit): the work item to offer a photo
  // for — see LiveUpdateBar. Null when no prompt is showing.
  const [photoPromptFor, setPhotoPromptFor] = useState<string | null>(null);
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
      setStep("review");
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
    setPhotoPromptFor(confirmedItem?.workItemId ?? workItemId);
    handleReset();
    setStep("done");
  }

  function handleNewUpdate() {
    setSubmittedMessage(null);
    setCaptureKey((k) => k + 1);
    setStep("capture");
  }

  useEffect(() => {
    onStepChange?.(step);
  }, [step, onStepChange]);

  // A step change replaces the visible content; if the worker had
  // scrolled past the top of this flow (e.g. confirming far down the
  // typed-text card on a phone), bring the new step's top into view and
  // move focus to the step list so assistive tech follows along.
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    const el = stepsRef.current;
    if (!el) return;
    if (el.getBoundingClientRect().top < 0) {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    }
    el.focus({ preventScroll: true });
  }, [step]);

  // Phones stack the voice and typed cards, so a typed update's validation
  // result can land below the fold. When its Confirm & Continue appears,
  // bring it into view ("nearest": no scroll at all if already visible,
  // e.g. on desktop where the cards sit side by side). Display only.
  useEffect(() => {
    const grid = captureGridRef.current;
    if (!grid) return;
    const revealed = new WeakSet<Element>();
    const observer = new MutationObserver(() => {
      for (const btn of grid.querySelectorAll("button")) {
        if (revealed.has(btn) || btn.textContent?.trim() !== "Confirm & Continue") continue;
        revealed.add(btn);
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        btn.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
      }
    });
    observer.observe(grid, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [captureKey]);

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const reviewWorkItem = confirmedItem ?? { code: workItemCode, description: workItemDescription };

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
    <div className={step === "capture" ? "space-y-3" : "space-y-4"}>
      <div>
        <h2 className="font-semibold text-foreground">Today&apos;s Update</h2>
        <p className="text-sm text-foreground-secondary">
          Record what you completed today (or type it), then review and submit.
        </p>
        {submittedTaskId && submittedTaskLabel && (
          <p className="text-xs text-foreground-secondary">Task: {submittedTaskLabel}</p>
        )}
      </div>

      {/* Step indicator — where the worker is and what comes next. Only the
          current step's label is shown on a phone, all three from sm. */}
      <ol
        ref={stepsRef}
        tabIndex={-1}
        aria-label="Update steps"
        className="flex items-center gap-2 scroll-mt-4 focus:outline-none"
      >
        {STEPS.map((s, i) => {
          const state = i < stepIndex ? "done" : i === stepIndex ? "current" : "upcoming";
          return (
            <li
              key={s.key}
              aria-current={state === "current" ? "step" : undefined}
              className={`flex items-center gap-2 ${state === "current" ? "min-w-0" : "shrink-0"}`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  state === "done"
                    ? "bg-success text-white"
                    : state === "current"
                      ? "bg-brand text-white"
                      : "border border-line bg-surface-soft text-foreground-muted"
                }`}
              >
                {state === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden /> : i + 1}
              </span>
              <span
                className={`text-sm truncate ${
                  state === "current" ? "font-semibold text-foreground" : "hidden sm:inline text-foreground-muted"
                }`}
              >
                {s.label}
                {state === "done" && <span className="sr-only"> (completed)</span>}
              </span>
              {i < STEPS.length - 1 && <span className="h-px w-4 sm:w-8 shrink-0 bg-line" aria-hidden />}
            </li>
          );
        })}
      </ol>

      {/* ---------- Step 1: Record & Validate ---------- */}
      <div hidden={step !== "capture"} className="space-y-3">
        {reviewedText && (
          // Came Back from Review: the validated update is still waiting.
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success-border bg-success-soft p-3 text-sm">
            <p className="font-medium text-success">Your validated update is ready to review.</p>
            <Button size="sm" onClick={() => setStep("review")}>
              Continue to Review
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </Button>
          </div>
        )}

        {lockState.acceptedType && !reviewedText && (
          <div className="bg-success-soft border border-success-border text-success rounded-lg p-3 text-sm font-medium">
            One valid input has been accepted. Other input methods are now locked.
            <button onClick={handleReset} className="ml-3 underline text-success transition-colors duration-150">
              Start Over
            </button>
          </div>
        )}

        {/* Step-1-only compaction of the shared Voice/Text cards (their own
            p-5 / space-y-3 and 3-row textarea stay as-is elsewhere). From md
            the two cards sit side by side, so a typed update's validation
            and Confirm & Continue aren't pushed below the whole voice card;
            phones keep the stacked order (voice first). Side by side they
            share one height so the pair reads as a balanced row. */}
        <div
          key={captureKey}
          ref={captureGridRef}
          className="grid gap-4 md:grid-cols-2 md:items-stretch [&>*]:p-4! [&>*]:space-y-2.5! [&_textarea]:h-16"
        >
          {/* 1. Voice — primary. */}
          <VoiceUpload
            recordOnly
            primary
            title="Speak your update"
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

          {/* 2. Text — secondary, always available. */}
          <TextInput
            title="Or type your update"
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
        </div>
      </div>

      {/* ---------- Step 2: Review & Submit ---------- */}
      {reviewedText && (
        <div hidden={step !== "review"} className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success-border bg-success-soft p-3 text-sm">
            <p className="min-w-0 text-success">
              <span className="font-medium">✓ Update validated</span>
              <span className="text-foreground-secondary">
                {" "}
                · {reviewWorkItem.code} — {reviewWorkItem.description}
              </span>
            </p>
            <Button variant="secondary" size="sm" onClick={() => setStep("capture")}>
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Back
            </Button>
          </div>
          <WorkerSubmitForm
            key={`${reviewedText}|${confirmedItem?.workItemId ?? ""}`}
            workerId={workerId}
            workItemId={confirmedItem?.workItemId ?? workItemId}
            plannedQuantity={confirmedItem ? confirmedItem.plannedQuantity : plannedQuantity}
            unitOfMeasure={confirmedItem ? confirmedItem.unitOfMeasure : unitOfMeasure}
            taskId={submittedTaskId}
            approvedProgress={!confirmedItem || confirmedItem.workItemId === workItemId ? approvedProgress : undefined}
            initialDescription={reviewedText}
            onSubmitted={handleSubmitted}
          />
        </div>
      )}

      {/* ---------- Step 3: Submitted (+ optional photo) ---------- */}
      {step === "done" && (
        <div className="space-y-4">
          {submittedMessage && (
            <p className="text-sm text-success bg-success-soft border border-success-border rounded-lg p-3 font-medium">
              {submittedMessage}
            </p>
          )}

          {photoPromptFor ? (
            <LiveUpdateBar workItemId={photoPromptFor} onDone={() => setPhotoPromptFor(null)} />
          ) : (
            <Button onClick={handleNewUpdate}>
              <RotateCcw className="h-4 w-4" strokeWidth={2} aria-hidden />
              Record another update
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
