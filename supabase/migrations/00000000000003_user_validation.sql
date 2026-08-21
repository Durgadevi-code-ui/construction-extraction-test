-- ============================================================
-- Adds the second (human) validation stage on top of the existing
-- AI validation already stored in submissions.status.
--
-- NULL    -> user has not validated yet
-- 'valid'   -> user accepted the AI-validated result
-- 'invalid' -> user rejected the AI-validated result
-- ============================================================

alter table public.submissions
  add column user_validation text
    check (user_validation in ('valid', 'invalid'));
