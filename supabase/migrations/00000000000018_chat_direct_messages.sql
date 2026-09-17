-- ============================================================
-- Private 1:1 Communication — additive extension of chat_messages
-- (00000000000017_chat_messages.sql). Adds an optional recipient so a
-- message can target one other user instead of the whole project.
--
-- Existing rows and any future message with recipient_user_id left
-- null keep behaving exactly as before: a project-wide broadcast,
-- surfaced in the UI as the "Team" conversation. No existing data is
-- touched or reinterpreted — this is purely additive.
--
-- Same access pattern as the base table: RLS stays enabled with no
-- anon/authenticated policy, reachable only via the service-role
-- client through app/api/workflow/chat/route.ts. Authorization (who
-- may message whom) is enforced in lib/chat.ts, not RLS.
-- ============================================================

alter table public.chat_messages
  add column recipient_user_id uuid references public.users(user_id) on delete cascade;

-- Powers "every direct message between these two users in this
-- project, oldest first" — the one new query lib/chat.ts adds for a
-- DM thread, alongside the existing project-wide index.
create index idx_chat_messages_dm
  on public.chat_messages(project_id, sender_user_id, recipient_user_id, created_at);
