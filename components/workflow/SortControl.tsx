"use client";

import { useId } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Select } from "@/components/ui/Input";

export type SortDir = "asc" | "desc";
export type SortState<K extends string> = { key: K; dir: SortDir };

/**
 * The one sorting rule shared by Submission History and the Reviews
 * queues: choosing the active column again flips its direction; a new
 * column starts in its own natural direction (newest first for dates,
 * largest first for numbers, A–Z for text — the caller's `defaultDir`).
 */
export function nextSort<K extends string>(
  prev: SortState<K>,
  key: K,
  defaultDir: Record<K, SortDir>
): SortState<K> {
  return prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir[key] };
}

/**
 * Compact "Sort by" control — a select plus an ↑/↓ direction toggle —
 * for lists without clickable column headings (review cards, History's
 * mobile card layout). Same state shape and behavior as History's
 * sortable table headings, so sorting reads the same everywhere.
 */
export default function SortControl<K extends string>({
  options,
  sort,
  onChange,
  defaultDir,
  className = "",
}: {
  options: { key: K; label: string }[];
  sort: SortState<K>;
  onChange: (next: SortState<K>) => void;
  defaultDir: Record<K, SortDir>;
  className?: string;
}) {
  const id = useId();
  const DirIcon = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <label className="text-xs font-medium text-foreground-secondary whitespace-nowrap" htmlFor={id}>
        Sort by
      </label>
      <Select
        id={id}
        value={sort.key}
        onChange={(e) => onChange({ key: e.target.value as K, dir: defaultDir[e.target.value as K] })}
        className="!w-auto !py-1.5 text-xs"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </Select>
      <button
        type="button"
        onClick={() => onChange(nextSort(sort, sort.key, defaultDir))}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-white text-foreground-secondary transition-colors duration-150 hover:text-foreground"
        aria-label={sort.dir === "asc" ? "Ascending — switch to descending" : "Descending — switch to ascending"}
        title={sort.dir === "asc" ? "Ascending" : "Descending"}
      >
        <DirIcon className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      </button>
    </div>
  );
}
