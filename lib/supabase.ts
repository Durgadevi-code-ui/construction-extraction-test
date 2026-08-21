/**
 * Supabase client — anon key only, by design.
 *
 * This app intentionally has NO auth/authorization (see project spec).
 * The anon key is not secret and is safe in the browser; what would
 * normally protect data is RLS, and the migration in
 * supabase/migrations/ enables RLS with a permissive open policy so
 * this test app works with zero login. That permissiveness is a
 * deliberate, documented simplification for a local accuracy-testing
 * tool — tighten the policies before using this schema for anything
 * real (see the warning comment in the migration file).
 *
 * Safe to import from both client and server code — there is no
 * service-role client anywhere in this app.
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
