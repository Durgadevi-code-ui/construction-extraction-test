"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Input";

export type ProjectOption = {
  projectId: string;
  projectName: string;
  departmentId: string;
  departmentName: string;
  /** The page this option opens (the user's role there) — defaults to
   * this dropdown's `basePath`. See lib/authContext.ts
   * projectSwitchOptions. */
  path?: string;
  /** That role's display name, shown when the options span roles. */
  roleLabel?: string;
};

/**
 * Header "Project" dropdown shared by the Contractor and Subcontractor
 * pages — replaces the row of per-project links with one select. The
 * options are built server-side by each page from the signed-in user's
 * OWN active role rows (never every project — see lib/authContext.ts
 * projectSwitchOptions), one per project + department; a project with
 * more than one department lists each as "Project — Department". Rows
 * for another role (e.g. Subcontractor on one project, Contractor on
 * another) open that role's page and are labelled with the role, so the
 * user can always switch back.
 *
 * Choosing one navigates with the same ?projectId=&departmentId= the
 * links used, keeping the current tab on the same page. The page then resolves that pair
 * server-side with getUserContext, which only ever selects among the
 * user's own Active roles — a hand-edited id can't reach another
 * project; this control is navigation only, not the security boundary.
 * With a single option it still shows the current project (read-only),
 * so Project is in the same header place on every page and role.
 */
export default function ProjectSelect({
  basePath,
  options,
  projectId,
  departmentId,
  tab,
}: {
  /** The page to reload in the chosen context, e.g. "/workflow/supervisor". */
  basePath: string;
  options: ProjectOption[];
  /** The page's current (server-resolved) project/department. */
  projectId: string;
  departmentId: string;
  /** Current tab, kept across the switch. */
  tab?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (options.length === 0) return null;

  const pathOf = (o: { path?: string }) => o.path ?? basePath;
  const perProject = new Map<string, number>();
  for (const o of options) {
    const k = `${pathOf(o)}:${o.projectId}`;
    perProject.set(k, (perProject.get(k) ?? 0) + 1);
  }
  // Role is only worth naming when the options open different pages.
  const mixedRoles = new Set(options.map(pathOf)).size > 1;
  const keyOf = (o: { projectId: string; departmentId: string; path?: string }) =>
    `${pathOf(o)}:${o.projectId}:${o.departmentId}`;

  const labelOf = (o: ProjectOption) =>
    `${(perProject.get(`${pathOf(o)}:${o.projectId}`) ?? 0) > 1 ? `${o.projectName} — ${o.departmentName}` : o.projectName}${
      mixedRoles && o.roleLabel ? ` (${o.roleLabel})` : ""
    }`;
  const current = options.find((o) => keyOf(o) === keyOf({ projectId, departmentId }));
  // One project: nothing to switch to — the same control, read-only.
  if (options.length === 1 && !current) return null;
  const readOnly = options.length === 1;

  function handleChange(value: string) {
    const next = options.find((o) => keyOf(o) === value);
    if (!next) return;
    const qs = new URLSearchParams({ projectId: next.projectId, departmentId: next.departmentId });
    // Keep the tab only within the same page (another role's page has its
    // own default tab).
    if (tab && pathOf(next) === basePath) qs.set("tab", tab);
    startTransition(() => router.push(`${pathOf(next)}?${qs.toString()}`));
  }

  return (
    <label className="flex items-center gap-2 min-w-0 max-w-full">
      <span className="text-xs font-medium text-foreground-secondary shrink-0">Project:</span>
      <Select
        value={keyOf({ projectId, departmentId })}
        onChange={(e) => handleChange(e.target.value)}
        disabled={pending || readOnly}
        aria-label="Current project"
        title={current ? labelOf(current) : undefined}
        // Fixed width, so the header controls don't shift with the
        // selected project's name length (long names truncate).
        className="!w-56 max-w-full !py-1.5 text-xs truncate"
      >
        {options.map((o) => (
          <option key={keyOf(o)} value={keyOf(o)}>
            {labelOf(o)}
          </option>
        ))}
      </Select>
    </label>
  );
}
