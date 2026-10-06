"use client";

import { Select } from "@/components/ui/Input";

/**
 * Compact header "Department:" dropdown — sits right after the Project
 * control in the page toolbar (DashboardShell `actions`), with the same
 * size and styling as ProjectSelect. Shared by the Subcontractor and
 * Contractor dashboards; each page keeps its own filtering behavior and
 * only passes the value/options/handler in.
 */
export default function DepartmentSelect({
  value,
  options,
  onChange,
  disabled = false,
  allLabel,
}: {
  value: string;
  options: { departmentId: string; departmentName: string }[];
  onChange: (departmentId: string) => void;
  disabled?: boolean;
  /** Adds a first "all" option (value "") with this label. */
  allLabel?: string;
}) {
  return (
    <label className="flex items-center gap-2 min-w-0 max-w-full">
      <span className="text-xs font-medium text-foreground-secondary shrink-0">Department:</span>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label="Department"
        className="!w-48 max-w-full !py-1.5 text-xs truncate"
      >
        {allLabel !== undefined && <option value="">{allLabel}</option>}
        {options.map((o) => (
          <option key={o.departmentId} value={o.departmentId}>
            {o.departmentName}
          </option>
        ))}
      </Select>
    </label>
  );
}
