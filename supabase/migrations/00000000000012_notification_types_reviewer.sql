-- ============================================================
-- Extends notifications.type to cover the reviewer side of the
-- pipeline. Until now, notifications only ever flowed back to the
-- originating Worker (see lib/notifications.ts) — nobody was ever
-- notified that something is WAITING for their review. Additive only:
-- existing rows/values are untouched, this only widens the check
-- constraint so two new values become valid.
--
--   SUBMISSION_PENDING_REVIEW — Worker submitted; sent to every
--     Active FOREMAN in that department/project (the "responsible
--     reviewer" per the workflow spec).
--   SUBMISSION_FORWARDED — Foreman forwarded a submission; sent to
--     every Active SUPERVISOR/MANAGER in that department/project (the
--     next-level reviewer).
-- ============================================================

-- "notifications_type_check" is Postgres's default auto-generated name
-- for the unnamed `check (type in (...))` constraint in
-- 00000000000007_notifications.sql (the standard "<table>_<column>_check"
-- pattern) — not a name this migration invented. IF EXISTS makes the
-- drop safe to re-run (whether the constraint is still the original
-- narrower definition or was already widened by a prior run of this
-- same migration, it's dropped and this immediately re-adds the exact
-- same widened definition either way).
alter table public.notifications drop constraint if exists notifications_type_check;

alter table public.notifications add constraint notifications_type_check
  check (type in (
    'PROGRESS_APPROVED',
    'PROGRESS_APPROVED_WITH_CHANGES',
    'PROGRESS_CHANGED',
    'PROGRESS_RETURNED',
    'SUBMISSION_PENDING_REVIEW',
    'SUBMISSION_FORWARDED'
  ));
