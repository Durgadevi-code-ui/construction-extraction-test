-- ============================================================
-- Hardens live_updates (table + its storage bucket) to be reachable
-- ONLY through the service-role client (lib/supabaseAdmin.ts), not the
-- anon key every other table in this app is still read/written through.
--
-- Context — why every OTHER table stays as-is:
-- Every table in this schema prior to live_updates is deliberately left
-- fully open to the anon role (see WARNING in 00000000000001_schema.sql)
-- because this app's server code has always talked to Supabase using
-- the plain anon-key client (lib/supabase.ts getSupabaseClient()), which
-- carries no per-request Postgres identity — RLS has no way to
-- distinguish "this app's own Next.js server calling with the anon key"
-- from "anyone else calling with that same publicly-shipped anon key."
-- Rewriting those tables' RLS to be restrictive would require switching
-- every existing route to the service-role client first — a large,
-- high-risk change to already-working functionality, out of scope here.
-- Migrations 00000000000001-00000000000013 are NOT touched by this one.
--
-- Why live_updates IS different:
-- live_updates is a narrowly-scoped, standalone table (see
-- 00000000000013_live_updates.sql / lib/liveUpdates.ts) with exactly one
-- reader/writer: app/api/workflow/live-updates/route.ts. That route (and
-- lib/liveUpdates.ts's callers) now construct their Supabase client via
-- getSupabaseServiceRoleClient() instead of getSupabaseClient() — the
-- service-role key always bypasses RLS, so the app keeps working exactly
-- as before with no behavior change, while dropping the anon-open
-- policies below means a caller holding only the public anon key (i.e.
-- literally anyone, since that key ships to the browser) can no longer
-- read or write this table or its storage objects directly against
-- Supabase's REST/Storage API, bypassing the app entirely.
-- ============================================================

drop policy if exists "live_updates_open_anon" on public.live_updates;
drop policy if exists "live_updates_anon_insert" on storage.objects;
drop policy if exists "live_updates_anon_select" on storage.objects;

-- RLS was already enabled on public.live_updates (00000000000013) and is
-- enabled on storage.objects by Supabase by default. With the anon
-- policies above dropped and no anon/authenticated replacement policy
-- added, both are now unreachable by the anon or authenticated
-- Postgres roles — only the service_role key (which bypasses RLS
-- entirely, by design in Postgres/Supabase) can read or write them.
