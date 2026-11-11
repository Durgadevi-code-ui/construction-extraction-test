import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { SESSION_COOKIE_OPTIONS } from "@/lib/sessionCookies";
import { DEMO_READ_ONLY_MESSAGE, isDemoAccountEmail, isDemoReadOnlyMode } from "@/lib/demoEmail";

/**
 * Named `proxy.ts`, not `middleware.ts` — Next.js 16 deprecated and
 * renamed the file convention (confirmed against this project's
 * actual installed Next docs, not assumed).
 *
 * Two jobs, both "optimistic" (see node_modules/next/dist/docs/01-app/
 * 02-guides/authentication.md "Optimistic checks with Proxy") — the
 * real, authoritative check is still getCurrentUser()/requireCurrentUser()
 * in lib/session.ts, called again in every page/route this protects:
 *   1. Refresh the Supabase session cookie so it doesn't silently expire
 *      mid-navigation.
 *   2. Redirect a visitor with no session away from the now-cut-over
 *      app pages (/workflow/**, /admin/setup/**, /account) to /login,
 *      before any page component even starts rendering.
 *
 * /api/** is matched only for the Demo Login read-only check below and
 * is never redirected — an unauthenticated fetch() to an API route should
 * get a 401 JSON response (handled in each route via getCurrentUser()),
 * not an HTML redirect a fetch caller can't use.
 * Also does not match bare /admin (the Admin picker/bootstrap page) —
 * bootstrapping the very first Admin account has no session to check
 * yet by definition; that page/route already self-gates ("only works
 * when zero Admins exist" — see lib/admin.ts bootstrapAdminUser).
 */
// /dev: the Extraction Test tool — the /api/text|voice|handwritten and
// /api/user-validation routes it calls require a session.
const PROTECTED_PREFIXES = ["/workflow", "/admin/setup", "/account", "/dev"];

// Demo Login (app/demo-login) sessions see a real project exactly as that
// role does, but are read-only: every write to project data goes through a
// non-GET /api request (server actions only sign in/out or change the demo
// account's own password), so those are refused here for demo accounts.
// Reads skip all of this, so /api GETs cost nothing extra for anyone.
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isApi = pathname.startsWith("/api/");
  if (isApi && READ_METHODS.has(request.method)) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookieOptions: SESSION_COOKIE_OPTIONS,
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  if (isApi) {
    // getClaims verifies the session token (locally, or with Supabase), so
    // the email can't be forged; a request with no session falls through to
    // the route's own 401.
    const { data } = await supabase.auth.getClaims();
    if (isDemoReadOnlyMode() && isDemoAccountEmail(data?.claims?.email)) {
      return NextResponse.json({ error: DEMO_READ_ONLY_MESSAGE }, { status: 403 });
    }
    return response;
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (isProtected && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  matcher: [
    "/login",
    "/demo-login",
    "/account",
    "/reset-password",
    "/auth/:path*",
    "/workflow",
    "/workflow/:path*",
    "/admin/setup",
    "/admin/setup/:path*",
    "/dev/:path*",
    // Only for the demo read-only check above; GET requests return at once.
    "/api/:path*",
  ],
};
