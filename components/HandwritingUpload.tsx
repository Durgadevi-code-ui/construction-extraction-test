"use client";

import { useRef, useState } from "react";
import ValidationPanel, { type RelevanceCheckResult } from "./ValidationPanel";

type Props = {
  locked: boolean;
  onResult: (status: "VALID" | "INVALID", normalizedText?: string) => void;
  workItemCode?: string | null;
  workItemDescription?: string | null;
  departmentName?: string | null;
};

export default function HandwritingUpload({
  locked,
  onResult,
  workItemCode,
  workItemDescription,
  departmentName,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
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
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleExtract() {
    if (!file) {
      setError("Choose an image first.");
      return;
    }
    setStatus("PROCESSING");
    setError("");
    setUserValidation(null);
    setSubmissionId(null);
    try {
      const formData = new FormData();
      formData.append("image", file);
      if (workItemDescription) formData.append("workItemDescription", workItemDescription);
      const res = await fetch("/api/handwritten", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Extraction failed.");
        setStatus("IDLE");
        return;
      }
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
      <h2 className="font-semibold text-foreground">Handwritten Image</h2>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        disabled={locked}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-sm text-foreground-muted"
      />
      <button
        onClick={handleExtract}
        disabled={locked || status === "PROCESSING"}
        className="px-4 py-2 bg-success hover:bg-success/90 text-white rounded-lg text-sm font-semibold transition-colors duration-150 disabled:opacity-50"
      >
        {status === "PROCESSING" ? "Extracting…" : "Extract Text"}
      </button>
      {error && <p className="text-red-600 text-sm">{error}</p>}
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
