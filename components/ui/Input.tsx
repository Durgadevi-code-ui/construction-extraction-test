import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";

/** Shared text input — consistent height/radius/border, amber focus ring. */
export default function Input({
  error,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { error?: boolean }) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border px-3 py-2.5 text-sm text-foreground placeholder:text-foreground-placeholder transition-colors duration-150 focus:outline-none focus:ring-2 ${
        error
          ? "border-error-border focus:border-error focus:ring-error/20"
          : "border-line focus:border-brand focus:ring-brand/20"
      } ${className}`}
    />
  );
}

/** Shared select — same visual language as Input. */
export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-foreground transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 ${className}`}
    >
      {children}
    </select>
  );
}

/** Size shared by the page-header toolbar controls (DashboardShell's
 * Search box, ProjectSelect, DepartmentSelect) so they line up with one
 * height, font size and width: full width on a phone, a fixed width from
 * sm (long values truncate; the full name is in the select's title). */
export const TOOLBAR_CONTROL_SIZE = "!h-9 !py-0 text-sm";
export const TOOLBAR_CONTROL_WIDTH = "w-full sm:!w-64";

/** Shared field label. */
export function Label({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-foreground-secondary" htmlFor={htmlFor}>
      {children}
    </label>
  );
}
