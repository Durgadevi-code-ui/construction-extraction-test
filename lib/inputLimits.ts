/**
 * Server-side maximum lengths for free text a caller sends us — checked
 * in the API route before any processing or database write, so an
 * oversized body is rejected with a clear 400 instead of being stored
 * (never silently truncated).
 *
 * Deliberately generous: the UI sets no limit on these fields, and a
 * Worker description can be a whole voice-recording transcript (there is
 * no recording time limit — see components/VoiceUpload.tsx), so these
 * only stop abuse, never a real update. Chat (2,000) and task notes
 * (1,000) already have their own, stricter limits in lib/chat.ts and
 * lib/workflow.ts.
 */

/** Worker progress description, /api/text input, and a reviewer's edit
 * of that description (~1 hour of transcribed speech). */
export const MAX_DESCRIPTION_LENGTH = 50_000;
/** Subcontractor/Contractor review comments. */
export const MAX_COMMENT_LENGTH = 5_000;
/** Live-update photo/voice caption. */
export const MAX_CAPTION_LENGTH = 1_000;

/** The 400 message for `value` when it is a string longer than `max`,
 * otherwise null (non-strings are left to the route's own type checks). */
export function tooLongError(value: unknown, max: number, label: string): string | null {
  if (typeof value !== "string" || value.length <= max) return null;
  return `${label} is too long (max ${max.toLocaleString("en-US")} characters).`;
}
