"use client";

export type TabDef = { key: string; label: string };

/**
 * Compact horizontal pill tab bar, shared by the Worker/Subcontractor/
 * Contractor dashboards so their role-specific sections stay reachable
 * without scrolling and without a page navigation — the parent owns
 * which tab is active and what renders below; this component is purely
 * the control.
 */
export default function TabNav({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex gap-1 bg-surface-soft border border-line-soft rounded-lg p-1 w-fit max-w-full overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          aria-current={active === tab.key ? "page" : undefined}
          className={`px-3.5 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
            active === tab.key
              ? "bg-brand text-white shadow-sm"
              : "text-foreground-secondary hover:text-foreground"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
