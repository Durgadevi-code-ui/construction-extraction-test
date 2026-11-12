"use client";

import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Eye } from "lucide-react";
import Button from "@/components/ui/Button";
import { DEMO_READ_ONLY_MESSAGE } from "@/lib/demoEmail";

/**
 * Demo Login read-only state for the UI. Provided once per app area by a
 * server layout (app/workflow/layout.tsx, app/admin/setup/layout.tsx) from
 * the session (lib/session.ts isDemoSession); false everywhere else, so
 * real users' screens render exactly as before.
 *
 * Presentation only: the server refuses every demo write on its own
 * (proxy.ts and lib/session.ts demoWriteRefusal). This just stops a demo
 * visitor from filling in a form only to hit that refusal.
 */
const ReadOnlyContext = createContext(false);

export function ReadOnlyProvider({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  return <ReadOnlyContext.Provider value={readOnly}>{children}</ReadOnlyContext.Provider>;
}

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

export const READ_ONLY_MESSAGE = DEMO_READ_ONLY_MESSAGE;

/**
 * Wraps a block of write controls (a form, an editor, an upload bar). For
 * a demo session every input and button inside is disabled by the native
 * <fieldset disabled>, with an optional one-line explanation; for anyone
 * else the children render unchanged — no extra element at all.
 */
export function ReadOnlyFieldset({
  children,
  notice,
  className = "min-w-0 m-0 border-0 p-0",
}: {
  children: ReactNode;
  notice?: string;
  /** "contents" keeps the wrapped controls in a surrounding flex row. */
  className?: string;
}) {
  const readOnly = useReadOnly();
  if (!readOnly) return <>{children}</>;
  return (
    <fieldset disabled title={READ_ONLY_MESSAGE} className={className}>
      {notice && <ReadOnlyNote>{notice}</ReadOnlyNote>}
      {children}
    </fieldset>
  );
}

/** components/ui/Button for an action that saves something: disabled, with
 * the read-only explanation as its tooltip, in a demo session; exactly
 * Button for everyone else. */
export function WriteButton(props: ComponentProps<typeof Button>) {
  const readOnly = useReadOnly();
  if (!readOnly) return <Button {...props} />;
  return <Button {...props} disabled title={READ_ONLY_MESSAGE} />;
}

/** Small inline explanation next to disabled demo controls. */
export function ReadOnlyNote({ children }: { children?: ReactNode }) {
  return (
    <p className="mb-2 flex items-start gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-foreground-secondary">
      <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
      <span>{children ?? READ_ONLY_MESSAGE}</span>
    </p>
  );
}

/** The page-level banner (DashboardShell / WorkerTabs) — nothing for real users. */
export function ReadOnlyBanner() {
  const readOnly = useReadOnly();
  if (!readOnly) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-brand-border bg-brand-soft px-3 py-2 text-sm text-foreground"
    >
      <Eye className="mt-0.5 h-4 w-4 shrink-0 text-brand" strokeWidth={2} aria-hidden />
      <span>
        <span className="font-semibold">Read-only.</span>{" "}
        <span className="text-foreground-secondary">
          You see this role&apos;s dashboards and project data. Saving, uploading, approving
          and messaging are turned off.
        </span>
      </span>
    </div>
  );
}
