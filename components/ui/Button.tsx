import type { ButtonHTMLAttributes } from "react";

/**
 * Shared button primitive, per the project's UI Style Guide reference:
 * primary = solid teal brand action; secondary = white with a teal
 * border/text (View/Details/Cancel/Back-style actions, never filled);
 * success/warning/danger = solid, for an explicit approve/pending/
 * destructive action (Approve, Pending, Delete/Remove/Reject).
 */
export type ButtonVariant = "primary" | "secondary" | "success" | "warning" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:bg-brand-hover disabled:bg-brand/50",
  secondary:
    "bg-white text-brand border border-brand hover:bg-brand-soft disabled:opacity-50",
  success: "bg-success text-white hover:bg-success/90 disabled:bg-success/50",
  // Light status tints (not solid blocks) — attention/destructive actions
  // stay clearly identifiable without heavy, high-contrast color.
  warning: "bg-warning-soft text-warning border border-warning-border hover:bg-warning-border/40 disabled:opacity-50",
  danger: "bg-error-soft text-error border border-error-border hover:bg-error-border/40 disabled:opacity-50",
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
