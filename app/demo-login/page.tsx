import DemoLoginPanel from "@/components/auth/DemoLoginPanel";
import LoginBlueprintVisual from "@/components/auth/LoginBlueprintVisual";
import { getAvailableDemoRoles } from "@/lib/demoAuth";

export const dynamic = "force-dynamic";

/**
 * Demo Login on its own page. Regular email/password sign-in lives at
 * /login; this page only moves the ORIGINAL Demo Login picker onto its
 * own route (per the requested UI separation) — it reuses the original
 * role/user selection component (components/auth/DemoLoginPanel) and the
 * original server action (app/login/demoActions.ts demoLogin) with no
 * change to their account/role/permission behavior. Off (empty) unless
 * DEMO_MODE is enabled server-side (see lib/demoAuth.ts).
 */
export default async function DemoLoginPage() {
  const demoRoles = getAvailableDemoRoles();

  return (
    <main className="flex-1 min-h-0 overflow-hidden flex flex-col lg:flex-row">
      {/* Left — same Living Blueprint visual as /login, for one consistent surface. */}
      <div className="relative overflow-hidden shrink-0 h-[30vh] lg:h-auto lg:w-[58%] px-6 py-5 sm:px-10 lg:py-0 lg:flex lg:items-center">
        <LoginBlueprintVisual />
        <div className="relative z-10 mx-auto max-w-md lg:mx-0">
          <div className="flex items-center gap-3 mb-2 lg:mb-8">
            {/* eslint-disable-next-line @next/next/no-img-element -- small static brand mark, same asset used on /login */}
            <img
              src="/agentic-atoms-logo.png"
              alt="Agentic Atoms"
              className="h-11 w-11 shrink-0 rounded-full object-contain bg-white/10 p-1"
            />
            <div>
              <p className="text-white font-bold tracking-tight">Agentic Atoms</p>
              <p className="text-white/70 text-xs">Construction Automation</p>
            </div>
          </div>
          <h1 className="hidden lg:block text-white text-3xl font-extrabold tracking-tight leading-tight mb-4">
            Explore every role in one click.
          </h1>
          <p className="hidden lg:block text-white/75 text-sm leading-relaxed max-w-sm">
            Enter the same workspace as a predefined Admin, Contractor, Subcontractor, or Worker —
            no password needed.
          </p>
        </div>
      </div>

      {/* Right — original Demo Login picker + link back to regular sign in. */}
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-background px-4 py-3 sm:py-6">
        <div className="w-full max-w-sm space-y-3 sm:space-y-4">
          <div>
            <h2 className="text-xl sm:text-2xl font-extrabold text-foreground tracking-tight">
              Demo Login
            </h2>
            <p className="text-sm text-foreground-secondary mt-1">
              Choose a role and demo user to enter the workspace.
            </p>
          </div>

          {demoRoles.length > 0 ? (
            <DemoLoginPanel roles={demoRoles} />
          ) : (
            <p className="text-sm text-foreground-secondary bg-surface border border-line rounded-lg p-3">
              Demo Login isn&apos;t enabled in this environment.
            </p>
          )}

          <p className="text-center text-sm text-foreground-secondary">
            Have an account?{" "}
            <a href="/login" className="text-brand font-medium hover:underline">
              Regular Sign In
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
