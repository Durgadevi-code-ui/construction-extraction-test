import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Attributes for the Supabase session cookies, shared by both server
 * clients that write them (lib/supabaseServer.ts and proxy.ts).
 *   - httpOnly: no browser code reads the session — every component talks
 *     to /api/*, never to Supabase directly — so page scripts never need
 *     it, and an injected script can't read the session tokens.
 *   - secure: on Vercel (always HTTPS); a local `next start` is plain http.
 * Everything else keeps @supabase/ssr's defaults (path "/", SameSite=Lax).
 */
export const SESSION_COOKIE_OPTIONS: CookieOptionsWithName = {
  httpOnly: true,
  secure: process.env.VERCEL === "1",
};
