import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Auth-aware Supabase client for Server Components, Server Actions, and
 * Route Handlers — reads/writes the Supabase session from Next's cookie
 * jar via @supabase/ssr, so `supabase.auth.getUser()` reflects the
 * actual logged-in browser making the request.
 *
 * Deliberately separate from lib/supabase.ts's getSupabaseClient()
 * (the plain anon client, no cookies, used by every existing page/API
 * route today) — that function is untouched and keeps working exactly
 * as before during the Phase 0/1 parallel-run period (see AGENTS.md
 * migration plan). This client is additive, not yet wired into any
 * existing route.
 *
 * Still uses only the public anon key, same as getSupabaseClient() —
 * auth.getUser() and RLS (once hardened, a later phase) are what make
 * this safe, not a privileged key. See lib/supabaseAdmin.ts for the
 * separate, genuinely privileged service-role client.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component render, which can't set
            // cookies — safe to ignore here because proxy.ts refreshes
            // the session on every request instead.
          }
        },
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
