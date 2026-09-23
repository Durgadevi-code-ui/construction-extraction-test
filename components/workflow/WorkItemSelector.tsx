"use client";

import Card from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";

/** One task/activity option for a work item: data from the work item's
 * own definitions (work_items.additional_fields.__tasks), never listed here. */
export type WorkItemTaskView = { id: string; label: string; conditional: boolean };

export type WorkItemOptionView = {
  workItemId: string;
  code: string;
  description: string;
  isCompleted: boolean;
  /** Not completed and every configured prerequisite (if any) is
   * complete — see work_item_dependencies / suggestNextWorkItem. */
  isEligible: boolean;
  tasks: WorkItemTaskView[];
};

type Props = {
  workItems: WorkItemOptionView[];
  activeWorkItemId: string;
  /** True when activeWorkItemId was chosen automatically (next-task
   * suggestion or the default first item), not picked by the worker. */
  isAutoSuggested: boolean;
  /** Caption explaining the auto-suggestion, or null when nothing
   * useful to say (e.g. not auto-suggested). Built by the caller since
   * it depends on how many work items are currently eligible. */
  suggestionNote: string | null;
  /** The worker's own Active project assignments (user_project_roles —
   * see getUserContext's availableProjects). Drives the Project filter;
   * no entries hides it. */
  projects?: { projectId: string; projectName: string }[];
  activeProjectId?: string;
  /** The worker's current task pick and the work item it was made for. */
  taskSelection?: { workItemId: string; taskId: string };
  onTaskChange?: (workItemId: string, taskId: string) => void;
  /** Set (by WorkerTabs) while a Project/Work Item change is still being
   * loaded by the server. The controls then show the NEW choice at once:
   * the task options for any assigned work item of the current project
   * are already in `workItems`, so nothing is fetched to show them. */
  pending?: { kind: "project" | "workItem"; workItemId: string; projectId?: string } | null;
  onNavigate: (
    url: string,
    pending: { kind: "project" | "workItem"; workItemId: string; projectId?: string }
  ) => void;
};

/**
 * Lets the Worker submit progress against a work item other than the
 * auto-suggested one — changes which work item every subsequent panel/
 * submission on this page targets via the workItemId query param
 * (identity itself is resolved from the session server-side, see
 * app/workflow/worker/page.tsx; no identity is ever passed here).
 *
 * Also hosts the Project filter: the option list is whatever projects
 * the worker is actually assigned to (database-driven), and the work
 * item list below is already scoped server-side to the selected
 * project. Both selects keep projectId in the URL so switching one
 * never silently resets the other.
 */
export default function WorkItemSelector({
  workItems,
  activeWorkItemId,
  isAutoSuggested,
  suggestionNote,
  projects = [],
  activeProjectId,
  taskSelection,
  onTaskChange,
  pending = null,
  onNavigate,
}: Props) {
  function go(
    params: { projectId?: string; workItemId?: string },
    kind: "project" | "workItem"
  ) {
    const query = new URLSearchParams();
    if (params.projectId) query.set("projectId", params.projectId);
    if (params.workItemId) query.set("workItemId", params.workItemId);
    const qs = query.toString();
    onNavigate(qs ? `/workflow/worker?${qs}` : "/workflow/worker", {
      kind,
      workItemId: params.workItemId ?? "",
      projectId: params.projectId,
    });
  }

  // What the controls show: the pending choice while the server catches
  // up, otherwise what the server rendered. Task options are read from
  // the already-loaded work item list, so they are available immediately.
  const projectPending = pending?.kind === "project";
  const displayItemId = pending ? pending.workItemId : isAutoSuggested ? "" : activeWorkItemId;
  const noItem = displayItemId === "";
  const tasks = workItems.find((w) => w.workItemId === displayItemId)?.tasks ?? [];
  const taskValue = taskSelection?.workItemId === displayItemId ? taskSelection.taskId : "";

  return (
    <Card className="space-y-2 text-sm">
      {projects.length > 0 && (
        <div>
          <label className="block font-medium text-foreground-secondary mb-1">Project</label>
          <Select
            value={(projectPending ? pending?.projectId : activeProjectId) ?? ""}
            onChange={(e) => go({ projectId: e.target.value }, "project")}
          >
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.projectName}
              </option>
            ))}
          </Select>
        </div>
      )}
      <label className="block font-medium text-foreground-secondary mb-1">Work Item</label>
      <Select
        value={displayItemId}
        disabled={projectPending}
        onChange={(e) => go({ projectId: activeProjectId, workItemId: e.target.value }, "workItem")}
      >
        <option value="">All assigned — suggested item</option>
        {workItems.map((item) => (
          <option key={item.workItemId} value={item.workItemId}>
            {item.code} — {item.description}
            {item.isCompleted
              ? " (Completed)"
              : item.isEligible
                ? " (Ready)"
                : " (Waiting on prerequisites)"}
          </option>
        ))}
      </Select>
      <label className="block font-medium text-foreground-secondary mb-1">
        Task <span className="font-normal text-foreground-muted">(for the selected work item)</span>
      </label>
      <Select
        value={taskValue}
        disabled={noItem || projectPending || tasks.length === 0}
        onChange={(e) => onTaskChange?.(displayItemId, e.target.value)}
      >
        <option value="">
          {noItem || projectPending
            ? "Select a work item first"
            : tasks.length === 0
              ? "No tasks available"
              : "All tasks"}
        </option>
        {tasks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
            {t.conditional ? " (if applicable)" : ""}
          </option>
        ))}
      </Select>
      {!noItem && !projectPending && tasks.length === 0 && (
        <p className="text-xs text-foreground-secondary">
          No task options configured for this work item.
        </p>
      )}
      {isAutoSuggested && suggestionNote && (
        <p className="text-xs text-foreground-secondary">{suggestionNote}</p>
      )}
    </Card>
  );
}
