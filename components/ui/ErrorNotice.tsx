import { AlertTriangle, RotateCw } from "lucide-react";

/** Shared inline error — the same error tint used across the app, with
 * an optional Retry for a failed load. Only the failed section shows
 * it; the rest of the page stays usable. */
export default function ErrorNotice({
  message,
  onRetry,
  className = "",
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-2 rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error ${className}`}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
      <span className="flex-1 min-w-0">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-md border border-error-border bg-white px-2 py-1 text-xs font-medium text-error transition-colors duration-150 hover:bg-error-soft"
        >
          <RotateCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}
