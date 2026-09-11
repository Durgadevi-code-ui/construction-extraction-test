"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatQuantity } from "@/lib/format";

type Props = {
  actorUserId: string;
  workItemId: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
};

/**
 * Inline Planned Quantity editor — the "simplified" permission: the
 * work item's own Subcontractor/Contractor (or Admin) can adjust this
 * one field directly, no separate Admin approval step (see
 * lib/workflow.ts updatePlannedQuantity / app/api/workflow/planned-quantity).
 * Reused wherever a Foreman/Supervisor/delegated-Contractor already
 * sees a work item list (AssignmentManager, SupervisorPanel,
 * DelegatedAdminPanel) — one editor, one API call, never duplicated.
 */
export default function PlannedQuantityEditor({
  actorUserId,
  workItemId,
  plannedQuantity,
  unitOfMeasure,
}: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [quantity, setQuantity] = useState(plannedQuantity?.toString() ?? "");
  const [unit, setUnit] = useState(unitOfMeasure ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/workflow/planned-quantity", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorUserId,
          workItemId,
          plannedQuantity: quantity === "" ? null : Number(quantity),
          unitOfMeasure: unit.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update Planned Quantity.");
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update Planned Quantity.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span>
          {plannedQuantity !== null ? formatQuantity(plannedQuantity) : "Not set"} {unitOfMeasure ?? ""}
        </span>
        <button
          onClick={() => {
            setQuantity(plannedQuantity?.toString() ?? "");
            setUnit(unitOfMeasure ?? "");
            setEditing(true);
          }}
          className="text-xs px-1.5 py-0.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
        >
          Edit
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <input
        type="number"
        min={0}
        step="any"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className="w-20 rounded border border-line px-1.5 py-0.5 text-xs"
      />
      <input
        type="text"
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
        placeholder="unit"
        className="w-16 rounded border border-line px-1.5 py-0.5 text-xs"
      />
      <button
        onClick={handleSave}
        disabled={submitting}
        className="text-xs px-1.5 py-0.5 rounded bg-brand text-white disabled:opacity-50"
      >
        {submitting ? "Saving…" : "Save"}
      </button>
      <button
        onClick={() => setEditing(false)}
        disabled={submitting}
        className="text-xs px-1.5 py-0.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-600 basis-full">{error}</span>}
    </span>
  );
}
