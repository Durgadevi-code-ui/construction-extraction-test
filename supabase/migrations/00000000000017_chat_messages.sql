-- ============================================================
-- Project Communication / Chat — a simple project-scoped message
-- board so authorized users (Worker/Subcontractor/Contractor/Admin)
-- can communicate about a project. Entirely separate from the
-- extraction/progress pipeline and from live_updates — never read by
-- any progress/approval/notification logic.
--
-- Locked to the service-role client from the start (see
-- 00000000000014_live_updates_service_role_only.sql for the reasoning
-- behind this pattern for new tables, vs. the fully-open anon policy
-- older tables in this schema still carry): RLS is enabled with no
-- anon/authenticated policy at all, so only
-- app/api/workflow/chat/route.ts (via lib/supabaseAdmin.ts
-- getSupabaseServiceRoleClient()) can reach this table. Authorization
-- (which project a caller may read/post to) is enforced in
-- lib/chat.ts, the same server-side pattern every other table in this
-- schema uses.
-- ============================================================

create table public.chat_messages (
  chat_message_id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(project_id) on delete cascade,
  sender_user_id uuid not null references public.users(user_id) on delete cascade,
  sender_name text not null,
  sender_role text not null,
  body text not null,
  status text not null default 'Active' check (status in ('Active', 'Removed')),
  created_at timestamptz not null default now()
);

-- Powers "every message in this project, oldest first" — the one
-- query lib/chat.ts reads through.
create index idx_chat_messages_project on public.chat_messages(project_id, created_at asc);

alter table public.chat_messages enable row level security;

-- No anon/authenticated policy — reachable only via the service-role
-- client (see module doc above).
