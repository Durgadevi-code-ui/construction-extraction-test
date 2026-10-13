/**
 * A post-login / post-email-link `next` destination, accepted only when
 * it is a path on THIS site — otherwise `fallback`. Used by the login
 * action (app/login/actions.ts) and the email-link handler
 * (app/auth/confirm/route.ts), both of which take `next` from the URL,
 * so an unchecked value would turn either into an open redirect:
 *   - "//evil.example" or "/\evil.example" — browsers read both as a
 *     link to another host;
 *   - "@evil.example" — appended to the origin it becomes
 *     "https://app@evil.example", i.e. host evil.example;
 *   - tabs/newlines are stripped by URL parsing, so "/\t/evil.example"
 *     is "//evil.example" again.
 */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  // Final guard: resolved against a placeholder origin, the result must
  // still be on that origin.
  try {
    const base = "http://same-origin.invalid";
    if (new URL(next, base).origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return next;
}
