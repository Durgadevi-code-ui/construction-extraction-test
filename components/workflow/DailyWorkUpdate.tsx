"use client";

import { useState } from "react";
import HandwritingUpload from "@/components/HandwritingUpload";
import VoiceUpload from "@/components/VoiceUpload";
import TextInput from "@/components/TextInput";
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
}: Props) {
  const [lockState, setLockState] = useState(initialLockState);
  const [reviewedText, setReviewedText] = useState<string | null>(null);
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
  const [showOtherMethods, setShowOtherMethods] = useState(false);

  function handleResult(type: InputType, status: "VALID" | "INVALID", normalizedText?: string) {
    setLockState((prev) => applyValidationResult(prev, type, status));
    if (status === "VALID" && normalizedText) {
      setReviewedText(normalizedText);
      setSubmittedMessage(null);
    }
  }

  function handleReset() {
    setLockState(resetLock());
    setReviewedText(null);
  }

  function handleSubmitted() {
    setSubmittedMessage("Progress submitted to Subcontractor.");
    handleReset();
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-foreground">Today&apos;s Update</h2>
        <p className="text-sm text-foreground-secondary">
          Type what you completed today, then review and submit.
        </p>
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
          onResult={(status, text) => handleResult("TEXT", status, text)}
          workItemCode={workItemCode}
          workItemDescription={workItemDescription}
          departmentName={departmentName}
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
              onResult={(status, text) => handleResult("HANDWRITTEN", status, text)}
              workItemCode={workItemCode}
              workItemDescription={workItemDescription}
              departmentName={departmentName}
            />
            <VoiceUpload
              locked={isLocked(lockState, "VOICE")}
              onResult={(status, text) => handleResult("VOICE", status, text)}
              workItemCode={workItemCode}
              workItemDescription={workItemDescription}
              departmentName={departmentName}
            />
          </>
        )}
      </div>

      {reviewedText && (
        <WorkerSubmitForm
          key={reviewedText}
          workerId={workerId}
          workItemId={workItemId}
          plannedQuantity={plannedQuantity}
          unitOfMeasure={unitOfMeasure}
          initialDescription={reviewedText}
          onSubmitted={handleSubmitted}
        />
      )}
    </div>
  );
}
