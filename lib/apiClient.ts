/**
 * Client-side helpers for reading this app's own JSON API responses and
 * turning a failure into a message that is safe to show a user.
 *
 * The API routes answer `{ error }` with the thrown Error's message.
 * Many of those come from lib/workflow.ts as "Failed to <do X>: <raw
 * database message>", and permission rejections carry internal role
 * codes and user ids ("FOREMAN <uuid> is not authorized …"). Neither
 * belongs on screen: the database detail and ids are dropped (the full
 * text still goes to the browser console for developers), while plain
 * business messages ("This work item is inactive — activate it before
 * assigning workers.") are shown as-is.
 */

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const PERMISSION_MESSAGE = "You don't have permission to do this.";
export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again.";

/** User-facing text for an API failure (see module doc). */
export function userFacingError(status: number, serverMessage: unknown, fallback: string): string {
  const message = typeof serverMessage === "string" ? serverMessage.trim() : "";
  if (status === 401) return SESSION_EXPIRED_MESSAGE;
  if (status === 403 || /not authorized/i.test(message)) return PERMISSION_MESSAGE;
  if (!message) return fallback;
  // "Failed to load X: <database detail>" -> "Failed to load X."
  if (/^failed to /i.test(message) && message.includes(": ")) {
    return `${message.slice(0, message.indexOf(": "))}. Please try again.`;
  }
  if (UUID_PATTERN.test(message)) return fallback;
  return message;
}

/**
 * Parses a JSON API response, throwing an Error with a user-facing
 * message when the request failed or the body isn't JSON (e.g. an HTML
 * error page from a crashed route) — instead of a raw
 * "Unexpected token <" parse error.
 */
export async function readApiJson<T = Record<string, unknown>>(res: Response, fallback: string): Promise<T> {
  let data: Record<string, unknown> | null = null;
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  if (!res.ok || data === null) {
    const raw = data?.error;
    console.error(`API request failed (HTTP ${res.status}): ${res.url}`, raw ?? "(no JSON body)");
    throw new Error(userFacingError(res.status, raw, fallback));
  }
  return data as T;
}

/** A caught value's message, or the fallback when it isn't an Error —
 * for catch blocks around readApiJson. A network failure (fetch itself
 * rejecting) gets a connection message rather than "Failed to fetch". */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
  return err instanceof Error && err.message ? err.message : fallback;
}
