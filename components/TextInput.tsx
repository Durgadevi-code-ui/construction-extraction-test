"use client";

import { useState } from "react";
import ValidationStatus from "./ValidationStatus";

type Props = {
  locked: boolean;
  onResult: (status: "VALID" | "INVALID", normalizedText?: string) => void;
};

export default function TextInput({ locked, onResult }: Props) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"IDLE" | "PROCESSING" | "VALID" | "INVALID">("IDLE");
  const [normalizedText, setNormalizedText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [userValidation, setUserValidation] = useState<"valid" | "invalid" | null>(null);
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
        body: JSON.stringify({ text }),
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
      if (data.status === "INVALID") {
        onResult("INVALID");
      }
    } catch {
      setError("Request failed.");
      setStatus("IDLE");
    }
  }

  async function handleUserValidation(decision: "valid" | "invalid") {
    if (!submissionId) return;
    setUserValidationBusy(true);
    setError("");
    try {
      const res = await fetch("/api/user-validation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId, decision }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "User validation failed.");
        return;
      }
      setUserValidation(decision);
      onResult(
        decision === "valid" ? "VALID" : "INVALID",
        decision === "valid" ? normalizedText : undefined
      );
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
        className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium disabled:opacity-50"
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
      <ValidationStatus status={displayStatus} reason={reason} confidence={null} />
      {!locked && status === "VALID" && (
        <div className="border-t border-line pt-3 space-y-2">
          {userValidation === null ? (
            <>
              <p className="text-xs font-medium text-foreground-secondary">User Validation</p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleUserValidation("valid")}
                  disabled={userValidationBusy}
                  className="px-3 py-1.5 bg-green-600 text-white rounded text-sm font-medium disabled:opacity-50"
                >
                  Valid
                </button>
                <button
                  onClick={() => handleUserValidation("invalid")}
                  disabled={userValidationBusy}
                  className="px-3 py-1.5 bg-red-600 text-white rounded text-sm font-medium disabled:opacity-50"
                >
                  Invalid
                </button>
              </div>
            </>
          ) : userValidation === "valid" ? (
            <p className="text-sm font-medium text-green-700">
              User Validation: VALID — Accepted
            </p>
          ) : (
            <p className="text-sm font-medium text-red-700">
              User Validation: INVALID — enter a new attempt.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
