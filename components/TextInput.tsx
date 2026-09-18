"use client";

import { useState } from "react";
import ValidationPanel, { type RelevanceCheckResult } from "./ValidationPanel";

type Props = {
  locked: boolean;
  onResult: (status: "VALID" | "INVALID", normalizedText?: string) => void;
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
};

export default function TextInput({ locked, onResult, workItemCode, workItemDescription, departmentName }: Props) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"IDLE" | "PROCESSING" | "VALID" | "INVALID">("IDLE");
  const [normalizedText, setNormalizedText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [relevance, setRelevance] = useState<RelevanceCheckResult | undefined>(undefined);
  const [userValidation, setUserValidation] = useState<"valid" | null>(null);
  const [userValidationBusy, setUserValidationBusy] = useState(false);

  async function handleSubmit() {
    setStatus("PROCESSING");
    setError("");
    setUserValidation(null);
    setSubmissionId(null);
    try {
      const res = await fetch("/api/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, workItemDescription: workItemDescription ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Validation failed.");
        setStatus("IDLE");
        return;
      }
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
      onResult("VALID", normalizedText);
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
        onClick={handleSubmit}
        disabled={locked || status === "PROCESSING"}
        className="px-4 py-2 bg-success hover:bg-success/90 text-white rounded-lg text-sm font-semibold transition-colors duration-150 disabled:opacity-50"
      >
        {status === "PROCESSING" ? "Validating…" : "Validate & Normalize"}
      </button>
      {error && <p className="text-red-600 text-sm">{error}</p>}
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
