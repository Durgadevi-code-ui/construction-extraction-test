"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { extractCompletedQuantity, extractProgressPercentage } from "@/lib/progressParsing";
import { calculateProgressPercentage } from "@/lib/calculations";
import { formatPercent, formatQuantity } from "@/lib/format";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Badge from "@/components/ui/Badge";

type Props = {
  workerId: string;
  workItemId: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  initialDescription: string;
  onSubmitted: () => void;
  /** Optional Task context, sent with the submission; the server
   * re-verifies it belongs to this work item. */
  taskId?: string | null;
};

export default function WorkerSubmitForm({
  workerId,
  workItemId,
  plannedQuantity,
  unitOfMeasure,
  initialDescription,
  onSubmitted,
  taskId = null,
}: Props) {
  const router = useRouter();

  // Progress is calculated automatically whenever the work item has a
  // planned quantity configured — the worker only enters what they
  // completed, never the percentage itself. Work items without a
  // planned quantity configured yet fall back to the original manual
  // "%" entry so nothing breaks for unconfigured items.
  const hasPlannedQuantity = plannedQuantity !== null && plannedQuantity > 0;

  const [detectedPercentage] = useState(() => extractProgressPercentage(initialDescription));
  const [detectedQuantity] = useState(() =>
    extractCompletedQuantity(initialDescription, unitOfMeasure)
  );
  const [completedQuantity, setCompletedQuantity] = useState<number | null>(detectedQuantity);
  const [progress, setProgress] = useState<number | null>(detectedPercentage);
  const [description, setDescription] = useState(initialDescription);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const calculatedProgress = hasPlannedQuantity
    ? calculateProgressPercentage(completedQuantity, plannedQuantity)
    : null;
  const effectiveProgress = hasPlannedQuantity ? calculatedProgress : progress;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (hasPlannedQuantity) {
      if (completedQuantity === null) {
        setError(`Enter today's completed quantity (${unitOfMeasure ?? "units"}).`);
        return;
      }
    } else if (progress === null) {
      setError("Enter today's progress percentage.");
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/workflow/worker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workerId,
          workItemId,
          taskId: taskId ?? undefined,
          completedQuantity: hasPlannedQuantity ? completedQuantity : undefined,
          progressPercentage: hasPlannedQuantity ? calculatedProgress ?? 0 : progress,
          description,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Submit failed.");
      }
      router.refresh();
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-surface rounded-lg border border-line shadow-sm p-4">
      <h3 className="text-sm font-semibold text-foreground">
        Review &amp; Submit to Progress Workflow
      </h3>

      {hasPlannedQuantity ? (
        <>
          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-1">
              Completed Quantity today ({unitOfMeasure ?? "units"})
            </label>
            <Input
              type="number"
              min={0}
              step="any"
              value={completedQuantity ?? ""}
              onChange={(e) =>
                setCompletedQuantity(e.target.value === "" ? null : Number(e.target.value))
              }
            />
            {detectedQuantity !== null ? (
              <p className="text-xs text-foreground-secondary mt-1">
                Detected from your update: {formatQuantity(detectedQuantity)} {unitOfMeasure}. You
                can edit this value before submitting.
              </p>
            ) : (
              <p className="text-xs text-foreground-secondary mt-1">
                Planned quantity for this work item: {formatQuantity(plannedQuantity)} {unitOfMeasure}.
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-1">
              Progress Today (%)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-foreground tabular-nums">
                {formatPercent(calculatedProgress)}
              </span>
              <Badge variant="info">Calculated</Badge>
            </div>
            <p className="text-xs text-foreground-secondary mt-1">
              Automatically calculated as Completed Quantity ÷ Planned Quantity × 100.
            </p>
          </div>
        </>
      ) : (
        <div>
          <label className="block text-sm font-medium text-foreground-secondary mb-1">
            Progress today (%)
          </label>
          <Input
            type="number"
            min={0}
            max={100}
            value={progress ?? ""}
            onChange={(e) => setProgress(e.target.value === "" ? null : Number(e.target.value))}
          />
          {detectedPercentage !== null ? (
            <p className="text-xs text-foreground-secondary mt-1">
              Detected from your update: {detectedPercentage}%. You can edit this value before
              submitting.
            </p>
          ) : (
            <p className="text-xs text-foreground-secondary mt-1">
              Enter today&apos;s progress percentage. (No planned quantity is configured for this
              work item yet — set one in Admin Setup to calculate this automatically.)
            </p>
          )}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1">
          Extracted Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-line bg-white text-foreground px-3 py-2.5 text-sm placeholder:text-foreground-placeholder transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
      </div>
      <Button type="submit" disabled={submitting || effectiveProgress === null}>
        {submitting ? "Submitting…" : "Submit Progress"}
      </Button>
      {error && (
        <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
      )}
    </form>
  );
}
