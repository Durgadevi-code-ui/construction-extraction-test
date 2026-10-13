import "server-only";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Proof that the caller of /api/user-validation is the signed-in user
 * who created that extraction submission.
 *
 * extraction_submissions has no "submitted by" column — its worker_id is
 * the synthetic test worker resolveConstructionContext() picks
 * (lib/construction.ts getOrCreateTestWorker), not the session user — so
 * ownership can't be read back from the row. Instead /api/text, /voice and
 * /handwritten return this token alongside the new submissionId: an HMAC
 * over (submissionId, the session's users.user_id, expiry), keyed by a
 * server-only secret. /api/user-validation recomputes it for the CURRENT
 * session's user id, so a submission id alone (or another user's token)
 * is not enough. Nothing in the token is trusted from the client except
 * as input to that comparison.
 *
 * Secret: SUBMISSION_TOKEN_SECRET if set, otherwise a key derived (HMAC,
 * with a fixed purpose label) from SUPABASE_SERVICE_ROLE_KEY, which every
 * deployment of this app already has and which never leaves the server.
 * Rotating either invalidates outstanding tokens, i.e. pending
 * confirmations must simply be resubmitted.
 */

/** A confirmation is a step taken right after the extraction result is
 * shown; a day is ample. */
export const REVIEW_TOKEN_TTL_SECONDS = 24 * 60 * 60;

function secretKey(): Buffer {
  const dedicated = process.env.SUBMISSION_TOKEN_SECRET;
  if (dedicated && dedicated.length >= 32) return Buffer.from(dedicated, "utf8");
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY");
  return createHmac("sha256", base).update("construction-extraction:submission-review-token:v1").digest();
}

function signature(submissionId: string, userId: string, expiresAt: number): Buffer {
  return createHmac("sha256", secretKey()).update(`${submissionId}\n${userId}\n${expiresAt}`).digest();
}

export function createReviewToken(
  submissionId: string,
  userId: string,
  nowMs: number = Date.now()
): string {
  const expiresAt = Math.floor(nowMs / 1000) + REVIEW_TOKEN_TTL_SECONDS;
  return `${expiresAt}.${signature(submissionId, userId, expiresAt).toString("base64url")}`;
}

export function verifyReviewToken(
  token: unknown,
  submissionId: string,
  userId: string,
  nowMs: number = Date.now()
): boolean {
  if (typeof token !== "string" || token.length > 200) return false;
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (expiresAt < Math.floor(nowMs / 1000)) return false;
  const given = Buffer.from(match[2], "base64url");
  const expected = signature(submissionId, userId, expiresAt);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
