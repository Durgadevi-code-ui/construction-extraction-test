/**
 * Blocking/locking rule — pure logic, framework-agnostic, so it's
 * testable without React and reusable if the UI changes.
 *
 * Rule: once ANY ONE input type becomes VALID, that type is
 * "accepted" and the other two are locked (disabled) for the rest of
 * this session. An INVALID result never locks anything — the other
 * input methods (and another attempt at the same one) stay available.
 *
 * There is no database-backed concurrency concern here (no accounts,
 * no multi-request race to guard against) — this is single-session,
 * single-browser-tab UI state, matching the "no auth / no accounts"
 * scope of this test app.
 */

export type InputType = "HANDWRITTEN" | "VOICE" | "TEXT";

export type LockState = {
  acceptedType: InputType | null;
};

export const initialLockState: LockState = { acceptedType: null };

export function isLocked(state: LockState, type: InputType): boolean {
  return state.acceptedType !== null && state.acceptedType !== type;
}

/** Call this whenever a validation result comes back for `type`. */
export function applyValidationResult(
  state: LockState,
  type: InputType,
  status: "VALID" | "INVALID"
): LockState {
  if (status === "VALID" && state.acceptedType === null) {
    return { acceptedType: type };
  }
  // INVALID never changes lock state; a VALID result when something
  // is already accepted is unreachable in the UI (that input would
  // already be disabled), but resolved as a no-op here for safety.
  return state;
}

export function resetLock(): LockState {
  return { ...initialLockState };
}
