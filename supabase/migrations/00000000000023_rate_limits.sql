-- ============================================================
-- Shared rate-limit counter for lib/rateLimit.ts.
--
-- NOT YET APPLIED ANYWHERE — review, then apply to staging before
-- production. After applying, set RATE_LIMIT_BACKEND=supabase in the
-- deployment's environment to turn enforcement on (it stays off until
-- then, so applying this migration alone changes no behavior).
--
-- One row per (rule, hashed identifier). rate_limit_hit() increments it
-- atomically (a single INSERT ... ON CONFLICT DO UPDATE, so concurrent
-- serverless instances can't lose or double-count a hit), starting a new
-- window once the old one has expired, and returns the new count plus
-- when the window resets. Identifiers are hashed by the app before they
-- get here; no raw IP address or email is stored.
--
-- Reachable only with the service-role key: RLS on with no policy, all
-- table privileges revoked from anon/authenticated, and EXECUTE on the
-- function granted to service_role only.
-- ============================================================

create table if not exists public.rate_limit_counters (
  key text primary key,
  window_start timestamptz not null,
  hit_count integer not null
);

alter table public.rate_limit_counters enable row level security;
revoke all on table public.rate_limit_counters from anon, authenticated;

create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer)
returns table (hit_count integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := clock_timestamp();
  v_window interval := make_interval(secs => p_window_seconds);
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 200 then
    raise exception 'invalid rate limit key';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit window';
  end if;

  return query
  insert into public.rate_limit_counters as c (key, window_start, hit_count)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set window_start = case when c.window_start + v_window <= v_now then v_now else c.window_start end,
        hit_count    = case when c.window_start + v_window <= v_now then 1 else c.hit_count + 1 end
  returning c.hit_count, c.window_start + v_window;

  -- Occasional cleanup of long-expired windows (no scheduler needed).
  if random() < 0.01 then
    delete from public.rate_limit_counters where window_start < v_now - interval '2 days';
  end if;
end;
$$;

revoke all on function public.rate_limit_hit(text, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer) to service_role;
