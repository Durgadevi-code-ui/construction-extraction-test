/**
 * The Supabase client every API route / server module uses for the
 * app's own tables and the handwritten/voice storage buckets.
 *
 * Server-only, and backed by the SERVICE-ROLE key (lib/supabaseAdmin.ts).
 * It used to be a plain anon-key client, which meant every table it
 * touched needed a fully-open `using (true)` RLS policy for the anon
 * role — so anyone holding the (by design non-secret) anon key could
 * read and write those tables through Supabase's REST API directly,
 * bypassing every check below. Authorization was, and still is,
 * enforced in application code — lib/authContext.ts
 * (getUserContext/isAdminUser/assertRole), lib/delegation.ts, and every
 * lib/workflow.ts action — keyed off the server-verified user id
 * getCurrentUser() returns (lib/session.ts), never a client-supplied one.
 *
 * Moving this client to the service role is the code half of the same
 * lockdown already done for live_updates (00000000000014) and the 8
 * tables in 00000000000016: with the app no longer depending on anon
 * access, supabase/migrations/00000000000022_lock_core_tables_service_role_only.sql
 * can drop the remaining anon-open policies. Until that migration is
 * applied nothing changes in behavior (the service role bypasses RLS,
 * and the anon policies it replaces were unconditional anyway).
 *
 * Nothing in the browser talks to Supabase directly (every component
 * goes through /api/*), and "server-only" makes importing this from a
 * client component a build error.
 */
import "server-only";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";

export function getSupabaseClient() {
  return getSupabaseServiceRoleClient();
}

export const STORAGE_BUCKETS = {
  HANDWRITTEN: "handwritten",
  VOICE: "voice",
} as const;
