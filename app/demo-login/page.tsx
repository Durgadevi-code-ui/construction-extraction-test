import Link from "next/link";
import DemoLoginForm from "@/components/auth/DemoLoginForm";
import LoginBlueprintVisual from "@/components/auth/LoginBlueprintVisual";
import { availableDemoRoles } from "@/lib/demoAccess";

export const dynamic = "force-dynamic";

/**
 * Separate Demo Login — role-based one-click entry for demonstrations and
 * testing. Its own route and action (app/demo-login/actions.ts); the
 * regular /login page, its form and its action are untouched. Same
 * single-surface layout as app/login/page.tsx.
 */
export default function DemoLoginPage() {
  const roles = availableDemoRoles();
  const enabled = roles.length > 0;

  return (
    <main className="flex-1 min-h-0 overflow-hidden flex flex-col lg:flex-row">
      <div className="relative overflow-hidden shrink-0 h-[30vh] lg:h-auto lg:w-[58%] px-6 py-5 sm:px-10 lg:py-0 lg:flex lg:items-center">
        <LoginBlueprintVisual />
        <div className="relative z-10 mx-auto max-w-md lg:mx-0">
          <div className="flex items-center gap-3 mb-2 lg:mb-8">
            {/* eslint-disable-next-line @next/next/no-img-element -- small static brand mark, same asset used elsewhere in this app */}
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
            Explore the platform as any project role.
          </h1>
          <p className="hidden lg:block text-white/75 text-sm leading-relaxed max-w-sm">
            Each role opens the existing project with that role&apos;s own permissions, through its
            own demo account.
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden flex items-center justify-center bg-background px-4 py-3 sm:py-6">
        <div className="w-full max-w-sm space-y-3 sm:space-y-4">
          <div>
            <span className="inline-block rounded-full border border-brand-border bg-brand-soft px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
              Demo
            </span>
            <h2 className="mt-2 text-xl sm:text-2xl font-extrabold text-foreground tracking-tight">Demo Login</h2>
            <p className="text-sm text-foreground-secondary mt-1">
              For demonstrations and testing only. Choose a role and team, then sign in; no email or
              password is needed. Every role enters the same application and existing projects with
              exactly its own permissions.
            </p>
          </div>

          {enabled ? (
            <DemoLoginForm roles={roles} />
          ) : (
            <div className="space-y-3">
              <p className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-foreground-secondary">
                Demo login is not enabled in this environment.
              </p>
              <p className="text-center text-xs text-foreground-secondary">
                <Link href="/login" className="text-brand hover:underline">
                  Go to the regular sign-in page
                </Link>
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
