"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

function readTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

// Follows the <html> attribute itself, so every mounted toggle (and a
// change made in another tab, via the storage event) stays in step.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  function onStorage(e: StorageEvent) {
    if (e.key !== THEME_STORAGE_KEY) return;
    applyTheme(e.newValue === "dark" ? "dark" : "light", false);
  }
  window.addEventListener("storage", onStorage);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", onStorage);
  };
}

function applyTheme(theme: Theme, persist: boolean) {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  if (!persist) return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private mode etc.) — the switch still applies
    // for this page, it just isn't remembered.
  }
}

/**
 * The one app-wide Light/Dark switch — a sidebar icon button next to
 * Sign out in DashboardShell, so every role gets the same control. It
 * only flips <html data-theme>; the colors come from the shared tokens
 * in app/globals.css, and app/layout.tsx re-applies a saved choice
 * before the first paint (lib/theme.ts).
 */
export default function ThemeToggle() {
  // Server snapshot is Light (the default the server renders).
  const theme = useSyncExternalStore(subscribe, readTheme, () => "light" as Theme);
  const next: Theme = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${next} mode`;
  const Icon = theme === "dark" ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={() => applyTheme(next, true)}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/70 transition-colors duration-150 hover:bg-white/10 hover:text-white"
    >
      <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden />
    </button>
  );
}
