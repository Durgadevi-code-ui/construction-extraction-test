"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import ValidationPanel, { type RelevanceCheckResult } from "./ValidationPanel";
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
  /** Selected Work Item context — same role as TextInput's workItemId:
   * lets /api/voice detect several similar assigned work items and ask
   * instead of guessing, and lets it validate a selected Task against
   * the TRANSCRIPT (see detectTaskConflict). Omitted by any caller with
   * no selected work item. */
  workItemId?: string | null;
  taskId?: string | null;
  taskLabel?: string | null;
  workItemCode?: string | null;
  workItemDescription?: string | null;
  departmentName?: string | null;
  /** See TextInput's prop doc — defaults to true (explicit). */
  workItemExplicitlySelected?: boolean;
  /** Hide the audio-file picker — the Worker update flow records voice
   * only (Priority 3: capture-first field workflow). Default false keeps
   * the file picker for other callers (e.g. the extraction test page). */
  recordOnly?: boolean;
  /** Card heading — defaults to the original "Voice / Audio". */
  title?: string;
  /** Present voice as the primary input: a prominent brand Record button
   * (the Worker update flow, where voice comes first). Default false
   * keeps the original neutral button for other callers. */
  primary?: boolean;
};

export default function VoiceUpload({
  locked,
  onResult,
  workItemId,
  taskId,
  taskLabel,
  workItemCode,
  workItemDescription,
  departmentName,
  workItemExplicitlySelected = true,
  recordOnly = false,
  title = "Voice / Audio",
  primary = false,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<"IDLE" | "PROCESSING" | "VALID" | "INVALID">("IDLE");
  const [rawText, setRawText] = useState("");
  const [normalizedText, setNormalizedText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  // Issued with submissionId; /api/user-validation requires it.
  const [reviewToken, setReviewToken] = useState<string | null>(null);
  const [relevance, setRelevance] = useState<RelevanceCheckResult | undefined>(undefined);
  const [userValidation, setUserValidation] = useState<"valid" | null>(null);
  const [userValidationBusy, setUserValidationBusy] = useState(false);
  const [candidates, setCandidates] = useState<ConfirmedWorkItem[] | null>(null);
  const [pickedId, setPickedId] = useState("");
  const [confirmedWorkItem, setConfirmedWorkItem] = useState<ConfirmedWorkItem | null>(null);
  // Strong task conflict — same "ask, don't guess, nothing saved yet"
  // pattern as TextInput's taskConflict (see lib/construction.ts
  // detectTaskConflict), applied to the transcript instead of typed text.
  const [taskConflict, setTaskConflict] = useState<{ selectedTask: TaskRef; suggestedTask: TaskRef } | null>(null);
  const [effectiveTask, setEffectiveTask] = useState<TaskRef | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // One /api/voice request at a time: each call saves an
  // extraction_submissions row, so a second click (or an automatic start
  // racing a manual one) must never send the same recording twice.
  const inFlightRef = useRef(false);
  // The recorder's onstop callback is created when recording STARTS; it
  // calls the latest handleTranscribe through this ref so the automatic
  // transcription uses the current work item/task props, not the ones
  // from when the recording began.
  const transcribeRef = useRef<(audio: File) => void>(() => {});
  useEffect(() => {
    transcribeRef.current = (audio: File) => {
      if (!locked) void handleTranscribe(undefined, undefined, audio);
    };
  });

  async function startRecording() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setError("Recording failed — please try recording again.");
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size === 0) {
          // Nothing was captured — don't send an empty file to /api/voice.
          setFile(null);
          setError("The recording was empty — please record your update again.");
          return;
        }
        const recorded = new File([blob], "recording.webm", { type: "audio/webm" });
        setFile(recorded);
        // The recording is finalized (all data flushed, mic released):
        // start the existing transcription automatically — no separate
        // "Convert to Text" click needed.
        transcribeRef.current(recorded);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError("Microphone access denied or unavailable — use file upload instead.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  async function handleTranscribe(
    confirmedWorkItemId?: string,
    taskConflictDecision?: "keep" | "switch",
    /** The just-finished recording (automatic start) — passed directly
     * because the `file` state set in the same callback isn't visible yet. */
    audio?: File
  ) {
    const audioFile = audio ?? file;
    if (!audioFile) {
      setError("Record or choose an audio file first.");
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStatus("PROCESSING");
    setError("");
    // A new transcription replaces any earlier transcript on screen.
    setRawText("");
    setNormalizedText("");
    setReason("");
    setConfidence(null);
    setRelevance(undefined);
    setUserValidation(null);
    setSubmissionId(null);
    setReviewToken(null);
    setCandidates(null);
    setConfirmedWorkItem(null);
    setTaskConflict(null);
    try {
      const formData = new FormData();
      formData.append("audio", audioFile);
      if (workItemDescription) formData.append("workItemDescription", workItemDescription);
      if (workItemId) formData.append("workItemId", workItemId);
      formData.append("workItemExplicitlySelected", String(workItemExplicitlySelected));
      if (taskId) formData.append("taskId", taskId);
      if (confirmedWorkItemId) formData.append("confirmedWorkItemId", confirmedWorkItemId);
      if (taskConflictDecision) formData.append("taskConflictDecision", taskConflictDecision);
      const res = await fetch("/api/voice", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Transcription failed.");
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
      setReviewToken(typeof data.reviewToken === "string" ? data.reviewToken : null);
      setRelevance(data.relevance);
      if (data.status === "INVALID") {
        onResult("INVALID");
      }
    } catch {
      setError("Transcription request failed — check your connection and retry.");
      setStatus("IDLE");
    } finally {
      inFlightRef.current = false;
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
        body: JSON.stringify({ submissionId, reviewToken, decision: "valid" }),
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
    <div
      className={`bg-surface rounded-lg border shadow-sm p-5 space-y-3 ${primary ? "border-brand/40" : "border-line"} ${locked ? "opacity-50" : ""}`}
    >
      <h2 className="font-semibold text-foreground">{title}</h2>
      <div className="flex items-center gap-2">
        <button
          onClick={recording ? stopRecording : startRecording}
          // No new recording while the previous one is still being
          // transcribed (its result would overwrite the new one's).
          disabled={locked || (!recording && status === "PROCESSING")}
          className={
            primary
              ? `inline-flex items-center gap-2 px-5 py-3 rounded-lg text-sm font-semibold text-white transition-colors duration-150 disabled:opacity-50 ${
                  recording ? "bg-error hover:bg-error/90" : "bg-brand hover:bg-brand-hover"
                }`
              : "px-3 py-2 bg-[#FAFAFA] border border-line text-foreground rounded text-sm font-medium disabled:opacity-50 hover:bg-line-soft"
          }
        >
          {primary && (recording ? <Square className="h-4 w-4" strokeWidth={2} /> : <Mic className="h-4 w-4" strokeWidth={2} />)}
          {recording ? "Stop Recording" : primary ? "Record voice update" : "Record"}
        </button>
        {!recordOnly && (
          <>
            <span className="text-xs text-foreground-muted">or</span>
            <input
              ref={inputRef}
              type="file"
              accept="audio/*"
              disabled={locked}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block max-w-full min-w-0 text-sm text-foreground-muted"
            />
          </>
        )}
      </div>
      {file && status !== "PROCESSING" && <p className="text-xs text-foreground-secondary">Ready: {file.name}</p>}
      {status === "PROCESSING" && (
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm font-medium text-foreground-secondary">
          <LoaderCircle className="h-4 w-4 animate-spin text-brand" strokeWidth={2} aria-hidden />
          Converting your recording to text…
        </p>
      )}
      {/* A recording is transcribed automatically when it stops. The
          button stays for a chosen audio file (callers without
          recordOnly) and, in the record-only Worker flow, appears only
          as Retry after a failed transcription. */}
      {(!recordOnly || (file && error && status === "IDLE")) && (
        <button
          onClick={() => handleTranscribe()}
          disabled={locked || status === "PROCESSING" || recording}
          className="px-4 py-2 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-semibold transition-colors duration-150 disabled:opacity-50"
        >
          {status === "PROCESSING" ? "Transcribing…" : recordOnly ? "Retry transcription" : "Convert to Text"}
        </button>
      )}
      {error && <p role="alert" className="text-error text-sm">{error}</p>}
      {candidates && (
        <fieldset className="text-sm space-y-2 rounded-lg border border-line bg-surface-soft p-3">
          <legend className="px-1 text-sm font-medium text-foreground">
            Several similar work items were found. Please confirm which work item this update belongs to.
          </legend>
          {candidates.map((c) => (
            <label key={c.workItemId} className="flex items-center gap-2 text-foreground">
              <input
                type="radio"
                name="similar-work-item-voice"
                value={c.workItemId}
                checked={pickedId === c.workItemId}
                onChange={() => setPickedId(c.workItemId)}
              />
              {c.code} — {c.description}
            </label>
          ))}
          <button
            type="button"
            onClick={() => handleTranscribe(pickedId)}
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
              onClick={() => handleTranscribe(undefined, "keep")}
              disabled={status === "PROCESSING"}
              className="px-3 py-1.5 bg-brand hover:bg-brand-hover text-white rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              Continue with {taskConflict.selectedTask.label}
            </button>
            <button
              type="button"
              onClick={() => handleTranscribe(undefined, "switch")}
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
            <p className="text-xs font-medium text-foreground-secondary">Raw transcript</p>
            <p className="bg-[#FAFAFA] border border-line text-foreground rounded p-2">{rawText}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-foreground-secondary">Normalized transcript</p>
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
        mediaKind="voice"
        decision={userValidation}
        busy={userValidationBusy}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
