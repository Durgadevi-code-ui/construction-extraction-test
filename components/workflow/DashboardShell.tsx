"use client";

import { useState } from "react";
import { LogOut, CalendarDays } from "lucide-react";
import NotificationBell from "@/components/workflow/NotificationBell";
import ProfileChip from "@/components/workflow/ProfileChip";
import { logout } from "@/app/login/actions";

export type ShellTab = {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
};

type Props = {
  tabs: ShellTab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  heading: string;
  subheading?: string;
  /** Renders NotificationBell for this user — omit for a page with no
   * caller identity yet (there isn't one currently, but keeps the shell
   * safe to reuse). */
  userId?: string;
  /** The signed-in caller's email (already resolved server-side by
   * every page that uses this shell) and a short role label — purely
   * for the header's greeting/profile chip (see ProfileChip). Omit
   * either to fall back to the previous plain-heading header. */
  userEmail?: string;
  roleLabel?: string;
  /** Show a toast for newly arrived notifications (see NotificationBell). */
  showNotificationToasts?: boolean;
  /** Optional extra controls rendered in the header row, left of the
   * date chip/notification bell — e.g. Admin's "Dashboard"/"Extraction
   * Test (Dev)" links, relocated here now that TopNav no longer renders
   * above this shell (see components/workflow/TopNav.tsx). Omit for
   * every role that has nothing to relocate. */
  actions?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * Shared page shell — sidebar (logo/brand, vertical nav, Sign out) +
 * main content header (heading/subheading, date chip, notification
 * bell), extracted so every role's dashboard uses the exact same
 * visual system as the Worker Dashboard (components/workflow/
 * WorkerTabs.tsx, the approved visual reference) instead of a
 * re-implementation that could visually drift from it. Purely
 * presentational — callers own their own tab state and every bit of
 * data/business logic; this component renders nothing but chrome.
 */
export default function DashboardShell({
  tabs,
  activeTab,
  onTabChange,
  heading,
  subheading,
  userId,
  userEmail,
  roleLabel,
  showNotificationToasts = false,
  actions,
  children,
}: Props) {
  const [logoAvailable, setLogoAvailable] = useState(true);

  return (
    // No rounded corners/border/shadow/page padding around this shell —
    // it's the light page canvas (bg-background) that every white Card
    // sits on top of, not a card itself. TopNav no longer renders above
    // any screen that uses this shell, so this claims the full viewport
    // height (not calc(100vh-64px), a stale TopNav-height offset that
    // would otherwise leave a dead gap at the bottom).
    <div className="flex flex-col lg:flex-row bg-background min-h-screen">
      <aside className="lg:w-60 shrink-0 bg-gradient-to-b from-navy-deep via-navy to-brand text-white flex flex-col">
        <div className="px-5 py-5 border-b border-white/10 flex items-center gap-2.5">
          {logoAvailable && (
            // eslint-disable-next-line @next/next/no-img-element -- small static brand mark, matches TopNav's own use of the same asset
            <img
              src="/agentic-atoms-logo.png"
              alt="Agentic Atoms"
              className="h-8 w-8 shrink-0 rounded-full object-contain bg-white/10"
              onError={() => setLogoAvailable(false)}
            />
          )}
          <div className="min-w-0">
            <p className="text-sm font-bold tracking-tight truncate">Agentic Atoms</p>
            <p className="text-[11px] text-white/60 truncate">Construction Automation</p>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-x-auto lg:overflow-visible">
          <div className="flex lg:flex-col gap-1">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => onTabChange(key)}
                aria-current={activeTab === key ? "page" : undefined}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors duration-150 ${
                  activeTab === key
                    ? "bg-brand text-white shadow-sm"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                {label}
              </button>
            ))}
          </div>
        </nav>

        <div className="px-3 py-4 border-t border-white/10">
          <form action={logout}>
            <button
              type="submit"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/70 transition-colors duration-150 hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.8} />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex-1 min-w-0 p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-medium text-foreground-muted">Good morning,</p>
            <h2 className="text-xl sm:text-2xl font-extrabold text-foreground tracking-tight">{heading}</h2>
            {subheading && <p className="text-sm text-foreground-secondary">{subheading}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3 min-w-0 max-w-full">
            {actions}
            <span
              suppressHydrationWarning
              className="hidden sm:inline-flex items-center gap-1.5 text-xs text-foreground-secondary bg-surface-soft border border-line rounded-full px-3 py-1.5"
            >
              <CalendarDays className="h-3.5 w-3.5" strokeWidth={2} />
              {new Date().toLocaleDateString("en-US", {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
            </span>
            {userId && <NotificationBell userId={userId} showToasts={showNotificationToasts} />}
            {userEmail && roleLabel && <ProfileChip email={userEmail} roleLabel={roleLabel} />}
          </div>
        </div>

        {children}
      </div>
    </div>
  );
}
