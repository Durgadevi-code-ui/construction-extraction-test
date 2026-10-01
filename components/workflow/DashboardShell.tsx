"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import NotificationBell from "@/components/workflow/NotificationBell";
import ProfileChip from "@/components/workflow/ProfileChip";
import { logout } from "@/app/login/actions";

export type ShellTab = {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Optional count pill (e.g. unread messages) — hidden when 0/omitted. */
  badge?: number;
  /** Background of that pill; defaults to green (bg-success). */
  badgeClassName?: string;
};

type Props = {
  tabs: ShellTab[];
  activeTab: string;
  onTabChange: (key: string) => void;
  heading: string;
  /** Line under the heading. A string also becomes the hover title (a
   * long one truncates at 2xl). */
  subheading?: React.ReactNode;
  /** The small "Good morning," line above the heading (default on). */
  showGreeting?: boolean;
  /** Renders NotificationBell for this user — omit for a page with no
   * caller identity yet (there isn't one currently, but keeps the shell
   * safe to reuse). */
  userId?: string;
  /** The signed-in caller's email (already resolved server-side by
   * every page that uses this shell) and a short role label — purely
   * for the sidebar Profile control (see ProfileChip). Omit either and no
   * Profile control renders. */
  userEmail?: string;
  roleLabel?: string;
  /** Key of the caller's Profile tab, if it has one. That tab is not
   * listed in the nav; the Profile control above Sign out opens it
   * instead, so Profile appears exactly once. */
  profileTabKey?: string;
  /** Show a toast for newly arrived notifications (see NotificationBell). */
  showNotificationToasts?: boolean;
  /** Optional extra controls rendered in the header row, left of the
   * page heading — e.g. Admin's "Dashboard"/"Extraction
   * Test (Dev)" links, relocated here now that TopNav no longer renders
   * above this shell (see components/workflow/TopNav.tsx). Omit for
   * every role that has nothing to relocate. */
  actions?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * Shared page shell for every role — sidebar (brand + Notifications,
 * vertical nav, Profile directly above Sign out) + main content header
 * (heading/subheading, page-specific actions), extracted so every role's dashboard uses the exact same
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
  showGreeting = true,
  userId,
  userEmail,
  roleLabel,
  profileTabKey,
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
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold tracking-tight truncate">Agentic Atoms</p>
            <p className="text-[11px] text-white/60 truncate">Construction Automation</p>
          </div>
          {userId && (
            <div className="shrink-0">
              <NotificationBell userId={userId} showToasts={showNotificationToasts} placement="sidebar" />
            </div>
          )}
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-x-auto lg:overflow-visible">
          <div className="flex lg:flex-col gap-1">
            {tabs.filter((t) => t.key !== profileTabKey).map(({ key, label, icon: Icon, badge, badgeClassName }) => (
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
                {!!badge && badge > 0 && (
                  <span
                    className={`ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold leading-none text-white tabular-nums ${badgeClassName ?? "bg-success"}`}
                    aria-label={`${badge} unread`}
                  >
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </nav>

        {/* Profile directly above Sign out — side by side on a small
            screen (where the sidebar becomes a top bar), stacked from lg. */}
        <div className="px-3 py-3 lg:py-4 border-t border-white/10 flex items-center gap-2 lg:flex-col lg:items-stretch lg:gap-1">
          {userEmail && roleLabel && (
            <div className="flex-1 min-w-0 lg:flex-none">
              <ProfileChip
                email={userEmail}
                roleLabel={roleLabel}
                onClick={profileTabKey ? () => onTabChange(profileTabKey) : undefined}
                active={!!profileTabKey && activeTab === profileTabKey}
              />
            </div>
          )}
          <form action={logout} className="shrink-0 lg:w-full">
            <button
              type="submit"
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap text-white/70 transition-colors duration-150 hover:bg-white/10 hover:text-white"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.8} />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="flex-1 min-w-0 p-5 sm:p-6 space-y-5">
        {/* Page header: heading/subheading, with page-specific actions
            (e.g. the Project dropdown) stacked under it below 2xl and on
            the right from 2xl. Notifications, Profile and Sign out live in
            the sidebar, the same place on every page. */}
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-start 2xl:justify-between">
          <div className="min-w-0 2xl:flex-1">
            {showGreeting && <p className="text-xs font-medium text-foreground-muted">Good morning,</p>}
            <h2 className="text-xl sm:text-2xl font-extrabold text-foreground tracking-tight">{heading}</h2>
            {subheading && (
              <p
                className="text-sm text-foreground-secondary 2xl:truncate"
                title={typeof subheading === "string" ? subheading : undefined}
              >
                {subheading}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-3 min-w-0 max-w-full 2xl:flex-nowrap 2xl:shrink-0">
              {actions}
            </div>
          )}
        </div>

        {children}
      </div>
    </div>
  );
}
