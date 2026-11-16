"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatQuantity } from "@/lib/format";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

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
        <span className="tabular-nums">
          {plannedQuantity !== null ? formatQuantity(plannedQuantity) : "Not set"} {unitOfMeasure ?? ""}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="!px-1.5 !py-0.5 !text-xs"
          onClick={() => {
            setQuantity(plannedQuantity?.toString() ?? "");
            setUnit(unitOfMeasure ?? "");
            setEditing(true);
          }}
        >
          Edit
        </Button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap rounded-lg border border-brand-border bg-brand-soft px-2 py-1.5">
      <Input
        type="number"
        min={0}
        step="any"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className="w-20 !py-1 !text-xs tabular-nums"
      />
      <Input
        type="text"
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
        placeholder="unit"
        className="w-16 !py-1 !text-xs"
      />
      <Button size="sm" className="!px-2 !py-1 !text-xs" onClick={handleSave} disabled={submitting}>
        {submitting ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className="!px-2 !py-1 !text-xs"
        onClick={() => setEditing(false)}
        disabled={submitting}
      >
        Cancel
      </Button>
      {error && (
        <span className="basis-full rounded border border-error-border bg-error-soft px-1.5 py-1 text-xs text-error">
          {error}
        </span>
      )}
    </span>
  );
}
