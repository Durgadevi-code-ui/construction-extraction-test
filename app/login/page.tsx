import LoginForm from "@/components/auth/LoginForm";
import DemoLoginPanel from "@/components/auth/DemoLoginPanel";
import { getAvailableDemoRoles } from "@/lib/demoAuth";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_or_expired_link: "That link is invalid or has expired. Request a new one.",
};

/**
 * Real Supabase Auth login. proxy.ts redirects here (with ?next=) from
 * any protected page when there's no session; app/auth/confirm/route.ts
 * redirects here with ?error= when an email link fails to verify.
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
    <main className="min-h-screen py-16 px-4">
      <div className="max-w-sm mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sign In</h1>
          <p className="text-sm text-foreground-secondary mt-1">
            Sign in to your account to continue.
          </p>
        </div>
        {errorMessage && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2.5">
            {errorMessage}
          </p>
        )}
        <DemoLoginPanel roles={demoRoles} />
        <LoginForm next={next} />
      </div>
    </main>
  );
}
