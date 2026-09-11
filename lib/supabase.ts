/**
 * Supabase client — anon key only.
 *
 * STALE-COMMENT FIX (this doc previously said the app has no auth at
 * all and no service-role client — both are now false): real Supabase
 * Auth is wired up (see lib/session.ts getCurrentUser()/
 * requireCurrentUser(), lib/supabaseServer.ts for the cookie-aware
 * client behind it, and proxy.ts for session refresh), and a genuinely
 * privileged service-role client exists at lib/supabaseAdmin.ts.
 * Authorization itself is enforced in application code — lib/authContext.ts
 * (getUserContext/isAdminUser/assertRole), lib/delegation.ts, and every
 * lib/workflow.ts action — keyed off the server-verified user id
 * getCurrentUser() returns, never a client-supplied one.
 *
 * What genuinely has NOT changed: every table this client (getSupabaseClient(),
 * the plain anon-key client below) reads/writes still has a fully-open
 * RLS policy for the anon role (see the WARNING in
 * supabase/migrations/00000000000001_schema.sql), because this client
 * carries no per-request Postgres identity for RLS to key on — the anon
 * key is public (safe to ship to the browser) and RLS cannot distinguish
 * this app's own server calling with it from anyone else doing the same.
 * Authorization for all of those tables is therefore enforced entirely
 * in the application code above, not by the database. Tightening that
 * to real per-table RLS would require switching every existing route to
 * the service-role client — a large change intentionally not done here;
 * see lib/liveUpdates.ts / app/api/workflow/live-updates/route.ts for the
 * one table (live_updates) that WAS given this stricter treatment, as a
 * template for doing the same to the rest later if that's ever required.
 */
import { createClient } from "@supabase/supabase-js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getSupabaseClient() {
  return createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY")
  );
}

export const STORAGE_BUCKETS = {
  HANDWRITTEN: "handwritten",
  VOICE: "voice",
} as const;
