import type { ButtonHTMLAttributes } from "react";

/**
 * Shared button primitive. Primary = amber brand action; secondary =
 * neutral/outline; danger = restrained (white/soft-red, never a solid
 * red block) — destructive actions like Remove/Rollback/Revoke must
 * never visually dominate over the primary action on the same row.
 */
export type ButtonVariant = "primary" | "secondary" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover disabled:bg-brand/50",
  secondary:
    "bg-white text-foreground-secondary border border-line hover:bg-surface-hover hover:text-foreground disabled:opacity-50",
  danger:
    "bg-white text-error border border-error-border hover:bg-error-soft disabled:opacity-50",
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-4 py-2",
};

export default function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 ${VARIANT_STYLES[variant]} ${SIZE_STYLES[size]} ${className}`}
    />
  );
}
