type Props = {
  status: "IDLE" | "PROCESSING" | "VALID" | "INVALID" | "LOCKED";
  reason?: string;
  confidence?: number | null;
};

const STYLES: Record<Props["status"], string> = {
  IDLE: "bg-gray-100 text-gray-500",
  PROCESSING: "bg-blue-100 text-blue-700",
  VALID: "bg-green-100 text-green-700",
  INVALID: "bg-red-100 text-red-700",
  LOCKED: "bg-gray-200 text-gray-400",
};

const LABELS: Record<Props["status"], string> = {
  IDLE: "Not tested",
  PROCESSING: "Processing…",
  VALID: "VALID",
  INVALID: "INVALID",
  LOCKED: "LOCKED",
};

export default function ValidationStatus({ status, reason, confidence }: Props) {
  return (
    <div className="space-y-1">
      <span className={`inline-block px-3 py-1 rounded-full text-sm font-semibold ${STYLES[status]}`}>
        {LABELS[status]}
      </span>
      {confidence !== undefined && confidence !== null && (
        <p className="text-xs text-gray-500">Confidence: {confidence.toFixed(2)}</p>
      )}
      {reason && <p className="text-xs text-gray-500">{reason}</p>}
    </div>
  );
}
