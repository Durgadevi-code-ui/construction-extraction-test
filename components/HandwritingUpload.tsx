"use client";

import { useRef, useState } from "react";
import { Camera } from "lucide-react";
import ValidationPanel, { type RelevanceCheckResult } from "./ValidationPanel";
import CameraCapture from "./CameraCapture";
import type { ConfirmedWorkItem } from "./TextInput";

type TaskRef = { id: string; label: string };

type Props = {
  locked: boolean;
  onResult: (
    status: "VALID" | "INVALID",
    normalizedText?: string,
    confirmedWorkItem?: ConfirmedWorkItem,
    effectiveTask?: TaskRef
  ) => void;
  /** Selected Work Item context — same role as TextInput's workItemId,
   * applied to the OCR'd note TEXT (see app/api/handwritten/route.ts). */
  workItemId?: string | null;
  taskId?: string | null;
  taskLabel?: string | null;
  workItemCode?: string | null;
  workItemDescription?: string | null;
  departmentName?: string | null;
  /** See TextInput's prop doc — defaults to true (explicit). */
  workItemExplicitlySelected?: boolean;
};

export default function HandwritingUpload({
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
  const [file, setFile] = useState<File | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [status, setStatus] = useState<"IDLE" | "PROCESSING" | "VALID" | "INVALID">("IDLE");
  const [rawText, setRawText] = useState("");
  const [normalizedText, setNormalizedText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [relevance, setRelevance] = useState<RelevanceCheckResult | undefined>(undefined);
  const [userValidation, setUserValidation] = useState<"valid" | null>(null);
  const [userValidationBusy, setUserValidationBusy] = useState(false);
  const [candidates, setCandidates] = useState<ConfirmedWorkItem[] | null>(null);
  const [pickedId, setPickedId] = useState("");
  const [confirmedWorkItem, setConfirmedWorkItem] = useState<ConfirmedWorkItem | null>(null);
  const [taskConflict, setTaskConflict] = useState<{ selectedTask: TaskRef; suggestedTask: TaskRef } | null>(null);
  const [effectiveTask, setEffectiveTask] = useState<TaskRef | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleExtract(confirmedWorkItemId?: string, taskConflictDecision?: "keep" | "switch") {
    if (!file) {
      setError("Choose an image first.");
      return;
    }
    setStatus("PROCESSING");
    setError("");
    setUserValidation(null);
    setSubmissionId(null);
    setCandidates(null);
    setConfirmedWorkItem(null);
    setTaskConflict(null);
    try {
      const formData = new FormData();
      formData.append("image", file);
      if (workItemDescription) formData.append("workItemDescription", workItemDescription);
      if (workItemId) formData.append("workItemId", workItemId);
      formData.append("workItemExplicitlySelected", String(workItemExplicitlySelected));
      if (taskId) formData.append("taskId", taskId);
      if (confirmedWorkItemId) formData.append("confirmedWorkItemId", confirmedWorkItemId);
      if (taskConflictDecision) formData.append("taskConflictDecision", taskConflictDecision);
      const res = await fetch("/api/handwritten", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Extraction failed.");
        setStatus("IDLE");
        return;
      }
      if (data.ambiguity) {
        setCandidates(data.ambiguity.candidates);
        setPickedId("");
        setStatus("IDLE");
        return;
      }
      if (data.taskConflict) {
        setTaskConflict(data.taskConflict);
        setStatus("IDLE");
        return;
      }
      setConfirmedWorkItem(data.confirmedWorkItem ?? null);
      setEffectiveTask(data.task ?? null);
      setRawText(data.rawText);
      setNormalizedText(data.normalizedText);
      setConfidence(data.confidence);
      setReason(data.reason);
      setStatus(data.status);
      setSubmissionId(data.submissionId);
      setRelevance(data.relevance);
      if (data.status === "INVALID") {
        onResult("INVALID");
      }
    } catch {
      setError("Extraction request failed.");
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
      <h2 className="font-semibold text-foreground">Handwritten Image</h2>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          disabled={locked}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block text-sm text-foreground-muted"
        />
        <span className="text-xs text-foreground-muted">or</span>
        <button
          type="button"
          onClick={() => setCameraOpen(true)}
          disabled={locked}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-brand rounded-lg text-sm font-medium text-brand hover:bg-brand-soft disabled:opacity-50"
        >
          <Camera className="h-3.5 w-3.5" strokeWidth={2} />
          Use Camera
        </button>
      </div>
      {cameraOpen && (
        <CameraCapture
          onCapture={(captured) => {
            setFile(captured);
            setCameraOpen(false);
          }}
          onClose={() => setCameraOpen(false)}
        />
      )}
      {file && <p className="text-xs text-foreground-secondary">Ready: {file.name}</p>}
      <button
        onClick={() => handleExtract()}
        disabled={locked || status === "PROCESSING"}
        className="px-4 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-semibold transition-colors duration-150 disabled:opacity-50"
      >
        {status === "PROCESSING" ? "Extracting…" : "Extract Text"}
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
                name="similar-work-item-image"
                value={c.workItemId}
                checked={pickedId === c.workItemId}
                onChange={() => setPickedId(c.workItemId)}
              />
              {c.code} — {c.description}
            </label>
          ))}
          <button
            type="button"
            onClick={() => handleExtract(pickedId)}
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
            Your selected task is &ldquo;{taskConflict.selectedTask.label}&rdquo;, but the text found in this image
            appears to refer to &ldquo;{taskConflict.suggestedTask.label}&rdquo;.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleExtract(undefined, "keep")}
              disabled={status === "PROCESSING"}
              className="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              Continue with {taskConflict.selectedTask.label}
            </button>
            <button
              type="button"
              onClick={() => handleExtract(undefined, "switch")}
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
      {rawText && (
        <div className="space-y-2 text-sm">
          <div>
            <p className="text-xs font-medium text-foreground-secondary">Raw extracted text</p>
            <p className="bg-[#FAFAFA] border border-line text-foreground rounded p-2">{rawText}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-foreground-secondary">Normalized text</p>
            <p className="bg-[#FAFAFA] border border-line text-foreground rounded p-2">{normalizedText}</p>
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
      <ValidationPanel
        status={displayStatus}
        reason={reason}
        confidence={confidence}
        relevance={relevance}
        ownDepartmentName={departmentName}
        workItemCode={workItemCode}
        mediaKind="image"
        decision={userValidation}
        busy={userValidationBusy}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
