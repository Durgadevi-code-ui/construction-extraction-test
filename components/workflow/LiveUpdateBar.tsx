"use client";

import { useRef, useState } from "react";

type Props = {
  /** Optional — associates the live update with the worker's current
   * work item for reviewer context. Never required: a live update is
   * informational, not a progress claim against any specific item. */
  workItemId?: string | null;
};

/**
 * "Review / Live Update" capture — visually its own small highlighted
 * panel (a live-status dot + heading + two action pills), NOT the
 * extraction pipeline (see components/workflow/DailyWorkUpdate.tsx for
 * that; its Handwriting/Voice inputs feed OCR/STT -> validation ->
 * progress submission and are completely untouched by this component).
 * A photo or voice note captured here goes straight to
 * /api/workflow/live-updates, is stored in its own live_updates table
 * (see lib/liveUpdates.ts), and never becomes a progress submission,
 * never enters validation/approval, and never affects progress %.
 *
 * Deliberately compact by requirement: one small card, no upload
 * modal, no dedicated page — visually distinct from "Today's Update"
 * above it, but never competing with it for attention.
 */
export default function LiveUpdateBar({ workItemId }: Props) {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [voiceMenuOpen, setVoiceMenuOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<"idle" | "uploading" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function upload(file: File, type: "PHOTO" | "VOICE") {
    setStatus("uploading");
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", type);
      if (workItemId) formData.append("workItemId", workItemId);

      const res = await fetch("/api/workflow/live-updates", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to send live update.");

      setStatus("sent");
      setMessage(type === "PHOTO" ? "Photo sent to your reviewer." : "Voice note sent to your reviewer.");
      setTimeout(() => setStatus((prev) => (prev === "sent" ? "idle" : prev)), 4000);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to send live update.");
    }
  }

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) upload(file, "PHOTO");
  }

  async function startRecording() {
    setMessage(null);
    setVoiceMenuOpen(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());
        upload(new File([blob], "live-update.webm", { type: "audio/webm" }), "VOICE");
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      setStatus("error");
      setMessage("Microphone access denied or unavailable.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  const busy = status === "uploading";

  return (
    <div className="rounded-xl border border-orange-200 bg-gradient-to-br from-brand-soft to-surface-soft p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
          </span>
          <h3 className="text-sm font-semibold tracking-wide text-foreground">Live Update</h3>
          <span className="text-xs text-foreground-muted">(optional)</span>
        </div>
        {busy && <span className="text-xs text-foreground-muted">Sending…</span>}
      </div>

      <p className="text-xs text-foreground-secondary mb-3">
        Share a quick photo or voice note from the field — separate from your typed update above.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          onChange={handlePhotoChange}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => photoInputRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-white px-3.5 py-1.5 text-sm font-medium text-foreground-secondary shadow-sm transition-colors hover:border-brand hover:bg-brand hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
        >
          📷 Photo
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => (recording ? stopRecording() : setVoiceMenuOpen((v) => !v))}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50 ${
              recording
                ? "border-red-300 bg-red-50 text-red-700"
                : "border-orange-200 bg-white text-foreground-secondary hover:border-brand hover:bg-brand hover:text-white"
            }`}
          >
            🎤 {recording ? "Stop" : "Voice"}
          </button>

          {voiceMenuOpen && !recording && (
            <div className="absolute z-10 mt-1 w-36 rounded-lg border border-line bg-surface p-1 shadow-lg">
              <button
                type="button"
                onClick={startRecording}
                className="block w-full rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-gray-50"
              >
                Start recording
              </button>
            </div>
          )}
        </div>

        {message && status !== "uploading" && (
          <span className={`text-xs ${status === "error" ? "text-red-600" : "text-green-700"}`}>
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
