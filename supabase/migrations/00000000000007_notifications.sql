-- ============================================================
-- Worker progress-review notifications.
--
-- Persistent, per-recipient record of every time a worker's progress
-- submission is reviewed/changed/approved/returned by an authorized
-- reviewer (Subcontractor forwarding with a correction, Contractor
-- approving/editing/rolling back — see lib/workflow.ts, which is the
-- only writer of this table). Denormalized submitted/previous-approved/
-- new-approved progress + reviewer name/role are stored directly on the
-- row (not re-derived at read time) so a notification's content never
-- changes retroactively if the underlying submission/validation is
-- edited again later — it's a point-in-time record of what happened.
--
-- Same fully-open RLS policy as every other table in this schema (see
-- WARNING in 00000000000001_schema.sql / lib/supabase.ts) — this app
-- has no login, so the actual authorization check (a caller only ever
-- sees/marks-read notifications for the exact recipient_user_id it
-- supplies) happens server-side in lib/notifications.ts, the same
-- place every other ownership check in this app already happens.
-- ============================================================

create table public.notifications (
  notification_id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.users(user_id) on delete cascade,
  project_id uuid references public.projects(project_id) on delete cascade,
  department_id uuid references public.departments(department_id) on delete cascade,
  work_item_id uuid references public.work_items(work_item_id) on delete cascade,
  submission_id uuid references public.extraction_submissions(extraction_submission_id) on delete cascade,
  validation_id uuid references public.user_validations(user_validations_id) on delete cascade,
  type text not null check (type in (
    'PROGRESS_APPROVED',
    'PROGRESS_APPROVED_WITH_CHANGES',
    'PROGRESS_CHANGED',
    'PROGRESS_RETURNED'
  )),
  title text not null,
  message text not null,
  submitted_progress numeric,
  previous_approved_progress numeric,
  new_approved_progress numeric,
  reviewer_user_id uuid references public.users(user_id),
  reviewer_name text,
  reviewer_role text,
  remarks text,
  is_read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- Powers "unread notifications for this recipient, newest first" — the
-- one query this table is read through (see
-- lib/notifications.ts listNotificationsForUser / getUnreadNotificationCount).
create index idx_notifications_recipient
  on public.notifications(recipient_user_id, is_read, created_at desc);

alter table public.notifications enable row level security;

-- Fully open policy — see WARNING above.
create policy "notifications_open_anon" on public.notifications
  for all using (true) with check (true);
