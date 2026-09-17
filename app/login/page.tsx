import LoginForm from "@/components/auth/LoginForm";
import DemoLoginPanel from "@/components/auth/DemoLoginPanel";
import LoginBlueprintVisual from "@/components/auth/LoginBlueprintVisual";
import { getAvailableDemoRoles } from "@/lib/demoAuth";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_or_expired_link: "That link is invalid or has expired. Request a new one.",
};

/**
 * Real Supabase Auth login. proxy.ts redirects here (with ?next=) from
 * any protected page when there's no session; app/auth/confirm/route.ts
 * redirects here with ?error= when an email link fails to verify.
 *
 * "Living Blueprint" visual direction — one continuous flex row (no
 * nested full-screen containers, no floating card over a separate
 * background layer): the reference photo (LoginBlueprintVisual, an
 * actual <img>, not an illustration) on the left and the login
 * controls on the right, both edge-to-edge within a single fixed-height
 * surface. `h-[calc(100vh-64px)] overflow-hidden` (64px ≈ TopNav's own
 * height, same convention DashboardShell/WorkerTabs/loading.tsx use)
 * pins the whole page to exactly one viewport — no page scroll, no
 * second screen. On mobile the visual panel becomes a shorter banner
 * (`h-[30vh]`) above the form — same single fixed surface throughout.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const errorMessage = error ? ERROR_MESSAGES[error] : undefined;
  const demoRoles = getAvailableDemoRoles();

  return (
    <main className="flex-1 min-h-0 overflow-hidden flex flex-col lg:flex-row">
      {/* Left — Living Blueprint reference photo. Branding lives here at
          every width; the heading/tagline below only show once there's
          room (lg+), keeping the mobile banner compact. */}
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
            Construction technology that understands real progress.
          </h1>
          <p className="hidden lg:block text-white/75 text-sm leading-relaxed max-w-sm">
            From blueprint to build — track every work item, approval, and site update in one
            connected workspace.
          </p>
        </div>
      </div>

      {/* Right — sign in. Same flat surface as the rest of the app
          (bg-background), no border/shadow separating it from the
          visual panel — two regions of one page, not two screens.
          min-h-0 lets this flex child actually shrink to fit the
          remaining viewport instead of forcing an overflow/scroll. */}
      <div className="flex-1 min-h-0 overflow-hidden flex items-center justify-center bg-background px-4 py-3 sm:py-6">
        <div className="w-full max-w-sm space-y-3 sm:space-y-4">
          <div>
            <h2 className="text-xl sm:text-2xl font-extrabold text-foreground tracking-tight">
              Welcome Back
            </h2>
            <p className="text-sm text-foreground-secondary mt-1">
              Sign in to continue to your project workspace.
            </p>
          </div>

          {errorMessage && (
            <p className="text-sm text-error bg-error-soft border border-error-border rounded-lg p-2.5">
              {errorMessage}
            </p>
          )}

          <DemoLoginPanel roles={demoRoles} />
          <LoginForm next={next} />
        </div>
      </div>
    </main>
  );
}
