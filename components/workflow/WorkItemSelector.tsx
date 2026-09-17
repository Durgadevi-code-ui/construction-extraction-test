"use client";

import { useRouter } from "next/navigation";
import Card from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";

export type WorkItemOptionView = {
  workItemId: string;
  code: string;
  description: string;
  isCompleted: boolean;
  /** Not completed and every configured prerequisite (if any) is
   * complete — see work_item_dependencies / suggestNextWorkItem. */
  isEligible: boolean;
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
};

/**
 * Lets the Worker submit progress against a work item other than the
 * auto-suggested one — changes which work item every subsequent panel/
 * submission on this page targets via the workItemId query param
 * (identity itself is resolved from the session server-side, see
 * app/workflow/worker/page.tsx; no identity is ever passed here).
 */
export default function WorkItemSelector({
  workItems,
  activeWorkItemId,
  isAutoSuggested,
  suggestionNote,
}: Props) {
  const router = useRouter();

  return (
    <Card className="space-y-2 text-sm">
      <label className="block font-medium text-foreground-secondary mb-1">Work Item</label>
      <Select
        value={activeWorkItemId}
        onChange={(e) => {
          router.push(`/workflow/worker?workItemId=${e.target.value}`);
        }}
      >
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
      {isAutoSuggested && suggestionNote && (
        <p className="text-xs text-foreground-secondary">{suggestionNote}</p>
      )}
    </Card>
  );
}
