import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS entirely, so it must
 * NEVER be imported by anything that can end up in a client bundle
 * (the "server-only" import above makes that a build error, not just a
 * convention) and must never be exposed through a NEXT_PUBLIC_* env
 * var. Used only for genuinely privileged operations Supabase's anon
 * key cannot do at all, regardless of RLS policy. Three concrete uses
 * in this app:
 *   1. Creating an auth.users account for an existing demo public.users
 *      row and setting/resetting that account's password server-side
 *      (see app/api/admin/link-auth/route.ts).
 *   2. app/api/workflow/live-updates/route.ts — the live_updates table
 *      and its storage bucket have NO anon-reachable RLS/storage policy
 *      at all (see supabase/migrations/00000000000014_live_updates_service_role_only.sql),
 *      unlike every other table in this app (still anon-open, protected
 *      only by application-layer checks — see lib/supabase.ts). This is
 *      the one place in the app where the database itself, not just the
 *      Next.js server, enforces "only this app's server can touch this
 *      data" — every query still runs the same getUserContext/assertRole
 *      checks as everywhere else; the service-role client only removes
 *      the anon-key-direct-access path around those checks.
 * A general Invite/Link UI for real Admin provisioning (use #1's natural
 * next step) is still NOT built.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY, a server-only secret (unlike
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, which is safe to be public) — add it to
 * .env.local only, never commit it, and never reference it from a "use
 * client" file or an API response.
 */
export function getSupabaseServiceRoleClient() {
  return createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
