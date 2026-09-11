"use client";

import { useRef, useState } from "react";
import ValidationStatus from "./ValidationStatus";

type Props = {
  locked: boolean;
  onResult: (status: "VALID" | "INVALID", normalizedText?: string) => void;
};

export default function VoiceUpload({ locked, onResult }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [recording, setRecording] = useState(false);
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
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function startRecording() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setFile(new File([blob], "recording.webm", { type: "audio/webm" }));
        stream.getTracks().forEach((t) => t.stop());
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

  async function handleTranscribe() {
    if (!file) {
      setError("Record or choose an audio file first.");
      return;
    }
    setStatus("PROCESSING");
    setError("");
    setUserValidation(null);
    setSubmissionId(null);
    try {
      const formData = new FormData();
      formData.append("audio", file);
      const res = await fetch("/api/voice", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Transcription failed.");
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
      setError("Transcription request failed.");
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
      <h2 className="font-semibold text-foreground">Voice / Audio</h2>
      <div className="flex items-center gap-2">
        <button
          onClick={recording ? stopRecording : startRecording}
          disabled={locked}
          className="px-3 py-2 bg-[#FAFAFA] border border-line text-foreground rounded text-sm font-medium disabled:opacity-50 hover:bg-line-soft"
        >
          {recording ? "Stop Recording" : "Record"}
        </button>
        <span className="text-xs text-foreground-muted">or</span>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          disabled={locked}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block text-sm text-foreground-muted"
        />
      </div>
      {file && <p className="text-xs text-foreground-secondary">Ready: {file.name}</p>}
      <button
        onClick={handleTranscribe}
        disabled={locked || status === "PROCESSING"}
        className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium disabled:opacity-50"
      >
        {status === "PROCESSING" ? "Transcribing…" : "Convert to Text"}
      </button>
      {error && <p className="text-red-600 text-sm">{error}</p>}
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
      <ValidationStatus status={displayStatus} reason={reason} confidence={confidence} />
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
              User Validation: INVALID — record a new attempt.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
