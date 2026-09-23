"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  /** Called with the captured photo — the caller feeds it into the
   * exact same extraction pipeline an uploaded file would go through
   * (see HandwritingUpload.tsx), no separate processing path. */
  onCapture: (file: File) => void;
  onClose: () => void;
};

/**
 * Live device camera capture — genuinely opens the camera (getUserMedia
 * video stream) and lets the Worker snap a photo, as opposed to the
 * HTML `<input capture>` attribute (see LiveUpdateBar.tsx's old
 * behavior), which most desktop browsers silently treat as a plain file
 * picker. Mirrors the same getUserMedia/permission pattern this app
 * already uses for audio recording (see VoiceUpload.tsx startRecording)
 * — same error handling shape, just video instead of audio.
 */
export default function CameraCapture({ onCapture, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setReady(true);
      } catch {
        setError("Camera access denied or unavailable. Use Upload instead.");
      }
    }
    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  function handleCapture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.92
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md space-y-3 rounded-lg bg-surface p-4 shadow-lg">
        <h3 className="text-sm font-semibold text-foreground">Camera</h3>
        {error ? (
          <p className="text-sm text-error">{error}</p>
        ) : (
          <div className="overflow-hidden rounded-lg bg-black">
            <video ref={videoRef} playsInline muted className="w-full h-auto" />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 border border-line rounded-lg text-sm font-medium text-foreground-secondary"
          >
            Cancel
          </button>
          {!error && (
            <button
              type="button"
              onClick={handleCapture}
              disabled={!ready}
              className="px-4 py-1.5 bg-success hover:bg-success/90 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              Capture Photo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
