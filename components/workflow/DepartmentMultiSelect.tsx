"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { TOOLBAR_CONTROL_SIZE, TOOLBAR_CONTROL_WIDTH } from "@/components/ui/Input";

/**
 * Header "Department:" multi-select for the Contractor Dashboard — same
 * place and size as the single DepartmentSelect (which the Subcontractor
 * keeps). A button opens a panel with a search box and a scrollable
 * checkbox list of the options the server returned (the Contractor's
 * authorized departments; see lib/dashboard.ts resolveDashboardScope).
 * The selection lives in the caller (`value`), so it is kept while
 * searching, scrolling, closing/reopening and switching views; an empty
 * selection means "All Departments". Ticking a department twice can't
 * duplicate it (toggle on a de-duplicated list).
 */
export default function DepartmentMultiSelect({
  value,
  options,
  onChange,
  allLabel = "All Departments",
}: {
  value: string[];
  options: { departmentId: string; departmentName: string }[];
  onChange: (departmentIds: string[]) => void;
  allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = new Set(value);
  const nameOf = (id: string) => options.find((o) => o.departmentId === id)?.departmentName ?? id;
  const label =
    value.length === 0 ? allLabel : value.length === 1 ? nameOf(value[0]) : `${value.length} departments`;
  const needle = search.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.departmentName.toLowerCase().includes(needle)) : options;

  function toggle(id: string) {
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...new Set([...value, id])]);
  }

  return (
    <div ref={rootRef} className="relative flex items-center gap-2 min-w-0 max-w-full">
      <span className="text-xs font-medium text-foreground-secondary shrink-0">Department:</span>
      <button
        type="button"
        aria-label="Department"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value.length > 0 ? value.map(nameOf).join(", ") : allLabel}
        onClick={() => setOpen((o) => !o)}
        className={`${TOOLBAR_CONTROL_WIDTH} ${TOOLBAR_CONTROL_SIZE} max-w-full flex items-center justify-between gap-2 rounded-lg border border-line bg-white px-3 text-left text-foreground transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-foreground-muted" aria-hidden />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-surface p-2 shadow-lg">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search departments"
              aria-label="Search departments"
              autoFocus
              className="w-full rounded-md border border-line bg-white py-1.5 pl-8 pr-2 text-sm text-foreground focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-foreground-secondary">
            <span>{value.length === 0 ? "None selected — showing all" : `${value.length} selected`}</span>
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={value.length === 0}
              className="text-brand hover:underline disabled:opacity-40 disabled:no-underline"
            >
              Clear all
            </button>
          </div>
          <ul role="listbox" aria-multiselectable="true" aria-label="Departments" className="mt-1 max-h-64 overflow-y-auto">
            {shown.length === 0 ? (
              <li className="px-2 py-2 text-sm text-foreground-muted">No departments match “{search.trim()}”</li>
            ) : (
              shown.map((o) => {
                const checked = selected.has(o.departmentId);
                return (
                  <li key={o.departmentId} role="option" aria-selected={checked}>
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover ${
                        checked ? "bg-brand-soft font-medium text-foreground" : "text-foreground-secondary"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(o.departmentId)}
                        className="h-4 w-4 accent-brand"
                      />
                      <span className="truncate">{o.departmentName}</span>
                    </label>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
