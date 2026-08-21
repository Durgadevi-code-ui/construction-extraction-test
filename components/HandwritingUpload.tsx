"use client";

import { useRef, useState } from "react";
import ValidationStatus from "./ValidationStatus";

type Props = {
  locked: boolean;
  onResult: (status: "VALID" | "INVALID") => void;
};

export default function HandwritingUpload({ locked, onResult }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"IDLE" | "PROCESSING" | "VALID" | "INVALID">("IDLE");
  const [rawText, setRawText] = useState("");
  const [normalizedText, setNormalizedText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [userValidation, setUserValidation] = useState<"valid" | "invalid" | null>(null);
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
      if (data.status === "INVALID") {
        onResult("INVALID");
      }
    } catch {
      setError("Extraction request failed.");
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
      onResult(decision === "valid" ? "VALID" : "INVALID");
    } catch {
      setError("User validation request failed.");
    } finally {
      setUserValidationBusy(false);
    }
  }

  const displayStatus = locked ? "LOCKED" : status;

  return (
    <div className={`bg-white rounded-lg border p-5 space-y-3 ${locked ? "opacity-50" : ""}`}>
      <h2 className="font-semibold text-gray-800">Handwritten Image</h2>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        disabled={locked}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-sm text-gray-600"
      />
      <button
        onClick={handleExtract}
        disabled={locked || status === "PROCESSING"}
        className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium disabled:opacity-50"
      >
        {status === "PROCESSING" ? "Extracting…" : "Extract Text"}
      </button>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {rawText && (
        <div className="space-y-2 text-sm">
          <div>
            <p className="text-xs font-medium text-gray-500">Raw extracted text</p>
            <p className="bg-gray-50 border rounded p-2">{rawText}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500">Normalized text</p>
            <p className="bg-gray-50 border rounded p-2">{normalizedText}</p>
          </div>
        </div>
      )}
      <ValidationStatus status={displayStatus} reason={reason} confidence={confidence} />
      {!locked && status === "VALID" && (
        <div className="border-t pt-3 space-y-2">
          {userValidation === null ? (
            <>
              <p className="text-xs font-medium text-gray-500">User Validation</p>
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
              User Validation: INVALID — upload a new attempt.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
