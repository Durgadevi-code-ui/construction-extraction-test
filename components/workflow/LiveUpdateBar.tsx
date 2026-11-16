"use client";

import { useRef, useState } from "react";
import { Camera } from "lucide-react";
import CameraCapture from "@/components/CameraCapture";

type Props = {
  /** The work item the worker just submitted progress for — the photo is
   * attached to it so reviewers see it on that item's review card. */
  workItemId: string;
  /** Called when the worker is finished with the prompt (declined, or the
   * photo was sent). */
  onDone: () => void;
};

/**
 * Second step of the Worker update (Priority 3 "Live Updates final flow"):
 * after progress is submitted, ask "Do you want to capture a picture?".
 *   - Yes → camera capture first (CameraCapture, rear camera); a small
 *     "choose a photo" link remains only as a fallback for devices where
 *     the in-page camera is unavailable (on phones the file picker still
 *     offers the camera via capture="environment").
 *   - No → continue, nothing sent.
 * A photo goes to the existing /api/workflow/live-updates endpoint and
 * live_updates table (lib/liveUpdates.ts) exactly as before — it shows up
 * on the Subcontractor/Contractor review cards and Work Items, never
 * becomes a progress submission and never affects progress %.
 */
export default function LiveUpdateBar({ workItemId, onDone }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [status, setStatus] = useState<"ask" | "uploading" | "sent" | "error">("ask");
  const [message, setMessage] = useState<string | null>(null);

  async function upload(file: File) {
    setStatus("uploading");
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", "PHOTO");
      formData.append("workItemId", workItemId);
      const res = await fetch("/api/workflow/live-updates", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to send the photo.");
      setStatus("sent");
      setMessage("Photo sent to your reviewer.");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to send the photo.");
    }
  }

  function handleCameraCapture(file: File) {
    setCameraOpen(false);
    upload(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) upload(file);
  }

  return (
    <div className="rounded-lg border border-info-border bg-info-soft p-4 text-sm space-y-3">
      {cameraOpen && <CameraCapture onCapture={handleCameraCapture} onClose={() => setCameraOpen(false)} />}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        className="hidden"
      />

      {status === "sent" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium text-success">{message}</p>
          <button type="button" onClick={onDone} className="text-xs font-medium text-brand hover:underline">
            Done
          </button>
        </div>
      ) : (
        <>
          <p className="font-medium text-foreground">Do you want to capture a picture?</p>
          <p className="text-xs text-foreground-secondary">
            Optional — a photo helps your Subcontractor and Contractor review this work.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setCameraOpen(true)}
              disabled={status === "uploading"}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition-colors duration-150 hover:bg-brand-hover disabled:opacity-50"
            >
              <Camera className="h-4 w-4" strokeWidth={2} />
              {status === "uploading" ? "Sending…" : "Yes, capture photo"}
            </button>
            <button
              type="button"
              onClick={onDone}
              disabled={status === "uploading"}
              className="rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium text-foreground-secondary transition-colors duration-150 hover:bg-surface-hover disabled:opacity-50"
            >
              No, continue
            </button>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={status === "uploading"}
            className="text-xs text-foreground-muted hover:text-foreground-secondary hover:underline disabled:opacity-50"
          >
            Camera not working? Choose a photo instead
          </button>
          {status === "error" && message && <p className="text-xs text-error">{message}</p>}
        </>
      )}
    </div>
  );
}
