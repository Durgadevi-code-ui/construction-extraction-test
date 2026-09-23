/**
 * Shared status indicator — small dot + compact label (Vercel-style
 * restraint), never a large colored pill/block. One source of truth for
 * the success/warning/error/info/neutral/brand semantic colors used
 * throughout the app.
 */
export type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral" | "brand";

const VARIANT_STYLES: Record<BadgeVariant, string> = {
  success: "bg-success-soft text-success border-success-border",
  warning: "bg-warning-soft text-warning border-warning-border",
  error: "bg-error-soft text-error border-error-border",
  info: "bg-info-soft text-info border-info-border",
  neutral: "bg-surface-soft text-foreground-muted border-line",
  brand: "bg-brand-soft text-brand border-brand-border",
};

const DOT_STYLES: Record<BadgeVariant, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  info: "bg-info",
  neutral: "bg-foreground-muted",
  brand: "bg-brand",
};

export default function Badge({
  variant = "neutral",
  children,
  dot = true,
}: {
  variant?: BadgeVariant;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${VARIANT_STYLES[variant]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_STYLES[variant]}`} />}
      {children}
    </span>
  );
}
