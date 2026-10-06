"use client";

import { useRef } from "react";
import { CalendarDays } from "lucide-react";
import { formatDateUS } from "@/lib/format";

/**
 * Date filter field that always reads MM/DD/YYYY. A native
 * `<input type="date">` renders its value in the browser/OS locale
 * (e.g. 28/09/2026), which can't be overridden — so the value is shown
 * here as this app's own US text, with the calendar icon right beside
 * it, and picking still goes through the browser's native date picker
 * (the hidden input below). `value`/`onChange` stay ISO yyyy-mm-dd,
 * exactly what a native date input produces, so callers' filtering is
 * unchanged. Backspace/Delete clears it; the native picker's own Clear
 * does too.
 */
export default function DateInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name (the visible label text, e.g. "From"). */
  label: string;
}) {
  const pickerRef = useRef<HTMLInputElement>(null);

  function openPicker() {
    const input = pickerRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      // showPicker unsupported (older browsers) — focusing/clicking the
      // native input opens its picker there instead.
      input.focus();
      input.click();
    }
  }

  return (
    <div className="relative flex h-10 w-full items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm transition-colors duration-150 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
      <input
        type="text"
        readOnly
        value={value ? formatDateUS(value, "/") : ""}
        placeholder="MM/DD/YYYY"
        aria-label={label}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          } else if ((e.key === "Backspace" || e.key === "Delete") && value) {
            e.preventDefault();
            onChange("");
          }
        }}
        className="min-w-0 flex-1 cursor-pointer bg-transparent tabular-nums font-bold text-foreground placeholder:font-bold placeholder:text-foreground-secondary focus:outline-none"
      />
      <button
        type="button"
        onClick={openPicker}
        aria-label={`Choose ${label} date`}
        className="shrink-0 text-foreground-secondary transition-colors duration-150 hover:text-foreground"
      >
        <CalendarDays className="h-4 w-4" strokeWidth={2} aria-hidden />
      </button>
      {/* The native picker — invisible, anchored along the field's
          bottom edge so the browser opens its calendar under it. */}
      <input
        ref={pickerRef}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 h-px w-full opacity-0"
      />
    </div>
  );
}
