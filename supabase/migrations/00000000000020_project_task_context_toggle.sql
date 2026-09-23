-- ============================================================
-- Admin-controlled on/off switch for the Project -> Work Item -> Task
-- SELECTION UI on the Worker Dashboard (WorkItemSelector: the Project
-- filter, Work Item dropdown, and Task dropdown, presented together as
-- one card/feature). This does NOT gate the underlying work item
-- assignment/eligibility/auto-suggestion logic (work_item_assignments,
-- work_item_dependencies, suggestNextWorkItem) - that always runs, so a
-- Worker with one eligible work item is still auto-routed to it either
-- way. Disabling this only hides the manual pickers so a Worker is never
-- forced to choose anything; Today's Update / Live Updates / Text /
-- Voice / Image submission continue exactly as before, with no Task
-- context attached.
--
-- Per-project (not a single global switch) so a multi-project Admin can
-- enable this for one project's rollout without affecting every other
-- project - the same project-scoped pattern this schema already uses for
-- everything else (departments, work_items, reporting_periods, ...).
--
-- Defaults to true: this UI is already live in production for every
-- existing project, so a plain column add must not silently hide it for
-- anyone until an Admin explicitly turns it off.
-- ============================================================

alter table public.projects
  add column if not exists task_context_enabled boolean not null default true;

comment on column public.projects.task_context_enabled is
  'Admin-controlled: whether the Worker Dashboard shows the Project/Work Item/Task selection UI for this project. Never gates the underlying work-item assignment/eligibility/auto-suggestion logic, which always runs regardless.';
