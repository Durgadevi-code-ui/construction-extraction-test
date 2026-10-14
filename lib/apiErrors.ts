import { NextResponse } from "next/server";
import { PERMISSION_MESSAGE } from "./apiClient";

const GENERIC_SERVER_ERROR = "Something went wrong on the server. Please try again.";

/**
 * The `{ error }` text an API route may send for a failure. 4xx messages
 * (validation, permission, session) are returned unchanged — the UI
 * shows them. For a 5xx, internal detail is withheld:
 *   - "Failed to <do X>: <database message>" -> "Failed to <do X>. Please
 *     try again." — exactly what lib/apiClient.ts userFacingError already
 *     displayed for it, so the screen text is unchanged; only the raw
 *     database text no longer leaves the server.
 *   - "<Thing> not found: <database message>" -> "<Thing> not found."
 *   - configuration / network failures -> a generic message.
 * Everything else (plain business messages) is passed through, as before.
 * The original message is logged server-side whenever it is altered.
 */
export function publicErrorMessage(message: string, status: number): string {
  if (status < 500) return message;

  let safe = message;
  const failed = /^(Failed to [^:]+):\s/.exec(message);
  const notFound = /^([A-Z][A-Za-z ]* not found):\s/.exec(message);
  if (failed) {
    safe = `${failed[1]}. Please try again.`;
  } else if (notFound) {
    safe = `${notFound[1]}.`;
  } else if (/Missing required environment variable|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    safe = GENERIC_SERVER_ERROR;
  }

  if (safe !== message) {
    console.error(`API ${status} (detail withheld from client):`, message);
  }
  return safe;
}

/** An authorization refusal thrown by lib/: "<role> <user id> is not
 * authorized …" (assertRole, assertAdminRole, assertCanReviewProgress, …),
 * a worker outside their own assignment or department (lib/workflow.ts
 * resolveWorkItemForWorker), or a caller with no Active role at all
 * (lib/authContext.ts getUserContext). */
const AUTHORIZATION_FAILURE =
  /\bis not authorized\b|\bis not assigned to worker\b|\bdoes not belong to department\b|^No active project\/department assignment found\b/i;

/** `NextResponse.json({ error }, { status })` with publicErrorMessage applied.
 * An authorization refusal is always a 403 with the generic permission text
 * the UI already shows for it (lib/apiClient.ts userFacingError) — never a
 * 500, and never the caller's role and user id, which are logged here. */
export function jsonError(message: string, status: number): NextResponse {
  if (AUTHORIZATION_FAILURE.test(message)) {
    console.warn("API 403 (detail withheld from client):", message);
    return NextResponse.json({ error: PERMISSION_MESSAGE }, { status: 403 });
  }
  return NextResponse.json({ error: publicErrorMessage(message, status) }, { status });
}
