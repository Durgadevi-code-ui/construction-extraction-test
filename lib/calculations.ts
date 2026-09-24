/**
 * Single shared source of truth for the Progress % / Estimated Amount
 * business rule. Used by both the API layer (authoritative, recomputed
 * server-side so a submitted percentage can never be spoofed) and by
 * client components (for live preview before submit) — pure functions,
 * no I/O, safe to import from either side. No duplication.
 *
 * Progress % = (Completed Quantity / Planned Quantity) x 100
 * Estimated Amount = Scheduled Value x (Progress % / 100)
 */

const ROUND_DECIMALS = 2;

function round(value: number): number {
  const factor = 10 ** ROUND_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Null when it truly cannot be calculated (missing/zero/negative planned
 * quantity, or missing completed quantity) — callers fall back to manual
 * entry in that case rather than showing 0%/NaN/Infinity.
 */
export function calculateProgressPercentage(
  completedQuantity: number | null | undefined,
  plannedQuantity: number | null | undefined
): number | null {
  if (
    completedQuantity === null ||
    completedQuantity === undefined ||
    !Number.isFinite(completedQuantity) ||
    completedQuantity < 0
  ) {
    return null;
  }
  if (
    plannedQuantity === null ||
    plannedQuantity === undefined ||
    !Number.isFinite(plannedQuantity) ||
    plannedQuantity <= 0
  ) {
    return null;
  }

  const raw = (completedQuantity / plannedQuantity) * 100;
  const clamped = Math.min(100, Math.max(0, raw));
  return round(clamped);
}

/** Null when scheduledValue or progressPercentage isn't known yet. */
export function calculateEstimatedAmount(
  scheduledValue: number | null | undefined,
  progressPercentage: number | null | undefined
): number | null {
  if (
    scheduledValue === null ||
    scheduledValue === undefined ||
    !Number.isFinite(scheduledValue)
  ) {
    return null;
  }
  if (
    progressPercentage === null ||
    progressPercentage === undefined ||
    !Number.isFinite(progressPercentage)
  ) {
    return null;
  }

  return round(scheduledValue * (progressPercentage / 100));
}

/**
 * Inverse of calculateProgressPercentage — the physical quantity that a
 * given percentage represents against a planned quantity. Used whenever
 * a Foreman/Supervisor correction changes the percentage on a work item
 * that has a planned_quantity configured, so the stored quantity stays
 * consistent with the (possibly corrected) percentage instead of
 * silently carrying forward the previous stage's quantity. Null when it
 * truly cannot be calculated (missing/zero/negative planned quantity, or
 * missing percentage) — same "can't calculate" contract as the other
 * functions here.
 */
export function calculateCompletedQuantity(
  progressPercentage: number | null | undefined,
  plannedQuantity: number | null | undefined
): number | null {
  if (
    progressPercentage === null ||
    progressPercentage === undefined ||
    !Number.isFinite(progressPercentage)
  ) {
    return null;
  }
  if (
    plannedQuantity === null ||
    plannedQuantity === undefined ||
    !Number.isFinite(plannedQuantity) ||
    plannedQuantity <= 0
  ) {
    return null;
  }

  const raw = (progressPercentage / 100) * plannedQuantity;
  const clamped = Math.min(plannedQuantity, Math.max(0, raw));
  return round(clamped);
}

/**
 * The monetary value of a quantity of work actually completed, at the
 * work item's own per-unit rate — Scheduled Value / Planned Quantity.
 * Deliberately independent of calculateProgressPercentage/
 * calculateEstimatedAmount: those clamp percentage to 0-100 first,
 * which is correct for "current overall completion" but would distort
 * a single day's earned amount (e.g. two approvals landing on the same
 * day summing to slightly over 100% of the *remaining* portion is
 * still real completed work worth real money — see
 * getWorkerDashboard's todaysEarnedAmount, which is this function
 * applied to that day's approved quantity, never a value derived from
 * a clamped percentage).
 *
 * Null whenever it truly cannot be calculated (missing/non-positive
 * planned quantity, missing scheduled value, or missing/negative
 * completed quantity) — callers should render "—", never a fabricated
 * $0.
 */
export function calculateEarnedAmount(
  completedQuantity: number | null | undefined,
  plannedQuantity: number | null | undefined,
  scheduledValue: number | null | undefined
): number | null {
  if (
    completedQuantity === null ||
    completedQuantity === undefined ||
    !Number.isFinite(completedQuantity) ||
    completedQuantity < 0
  ) {
    return null;
  }
  if (
    plannedQuantity === null ||
    plannedQuantity === undefined ||
    !Number.isFinite(plannedQuantity) ||
    plannedQuantity <= 0
  ) {
    return null;
  }
  if (
    scheduledValue === null ||
    scheduledValue === undefined ||
    !Number.isFinite(scheduledValue)
  ) {
    return null;
  }

  const perUnitValue = scheduledValue / plannedQuantity;
  return round(completedQuantity * perUnitValue);
}

export function isWorkItemComplete(
  progressPercentage: number | null | undefined
): boolean {
  return progressPercentage !== null && progressPercentage !== undefined && progressPercentage >= 100;
}

/**
 * Overall Progress % for a set of Active work items — the one shared
 * definition used by every "Overall Progress" / "Department Progress"
 * figure (Contractor brief, Subcontractor dashboard, Dashboard
 * department roll-ups and KPI), so they can never disagree.
 *
 * Plain (unweighted) average of each work item's own current progress
 * (see lib/workflow.ts getWorkItemCurrentStatus — unchanged). A work
 * item with no approved progress yet (null) counts as 0%, not excluded:
 * it is part of the scope and has no approved work, so leaving it out
 * would overstate progress. Rounded to 1 decimal. Null only when there
 * are no work items at all (nothing to average), never fabricated.
 */
export function calculateOverallProgress(
  progressPercentages: (number | null | undefined)[]
): number | null {
  if (progressPercentages.length === 0) return null;
  const sum = progressPercentages.reduce<number>(
    (total, p) => total + (p !== null && p !== undefined && Number.isFinite(p) ? p : 0),
    0
  );
  return Math.round((sum / progressPercentages.length) * 10) / 10;
}
