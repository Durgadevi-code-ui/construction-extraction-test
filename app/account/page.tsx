import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { getCurrentUser } from "@/lib/session";
import { logout } from "@/app/login/actions";

export const dynamic = "force-dynamic";

/**
 * Session status/verification page — the manual test surface for Phase
 * 0 (log in, land here, confirm the session and any public.users link,
 * log out). Not part of the existing app's navigation and reads
 * nothing from any existing role/permission table beyond the one
 * auth_user_id lookup in getCurrentUser() — purely additive, matches
 * the "do not switch existing routes yet" scope for this phase.
 */
export default async function AccountPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) {
    return (
      <main className="min-h-screen py-16 px-4">
        <div className="max-w-sm mx-auto space-y-4 text-center">
          <p className="text-sm text-foreground-secondary">You&apos;re not signed in.</p>
          <Link href="/login" className="text-brand hover:underline text-sm">
            Go to Sign In
          </Link>
        </div>
      </main>
    );
  }

  const currentUser = await getCurrentUser();

  return (
    <main className="min-h-screen py-16 px-4">
      <div className="max-w-sm mx-auto space-y-6">
        <h1 className="text-2xl font-bold text-foreground">Account</h1>

        <section className="bg-white rounded-lg border border-line p-4 space-y-2 text-sm">
          <p>
            <span className="text-foreground-secondary">Signed in as:</span>{" "}
            <span className="font-medium">{authUser.email}</span>
          </p>
          <p>
            <span className="text-foreground-secondary">Auth user id:</span>{" "}
            <span className="font-mono text-xs">{authUser.id}</span>
          </p>

          {currentUser ? (
            <>
              <p className="text-success bg-success-soft border border-success-border rounded p-2">
                Linked to an existing app account (user_id{" "}
                <span className="font-mono text-xs">{currentUser.userId}</span>).
              </p>
              <p className="text-xs text-foreground-muted">
                This link is what /workflow and every workflow API route resolve your
                project/department/role from — the old &quot;?userId=&quot; picker is gone.
              </p>
            </>
          ) : (
            <p className="text-warning bg-warning-soft border border-warning-border rounded p-2">
              Not linked to an app account yet (no matching public.users.auth_user_id). An Admin
              needs to link this login to a demo user before it can be used anywhere in the app.
            </p>
          )}
        </section>

        <form action={logout}>
          <button
            type="submit"
            className="w-full rounded border border-line text-foreground-secondary text-sm font-medium px-4 py-2 hover:bg-surface-soft"
          >
            Sign Out
          </button>
        </form>
      </div>
    </main>
  );
}
