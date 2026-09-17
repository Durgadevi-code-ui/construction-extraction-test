import type { LucideIcon } from "lucide-react";

/** Shared "nothing here yet" state — small Lucide icon + short text +
 * optional action. No decorative illustrations. */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-line bg-surface px-6 py-10 text-center">
      <Icon className="h-8 w-8 text-foreground-muted" strokeWidth={1.5} aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="max-w-sm text-xs text-foreground-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
