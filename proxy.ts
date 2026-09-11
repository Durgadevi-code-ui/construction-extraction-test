import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

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
 * Deliberately does NOT match /api/** — an unauthenticated fetch() to
 * an API route should get a 401 JSON response (handled in each route
 * via getCurrentUser()), not an HTML redirect a fetch caller can't use.
 * Also does not match bare /admin (the Admin picker/bootstrap page) —
 * bootstrapping the very first Admin account has no session to check
 * yet by definition; that page/route already self-gates ("only works
 * when zero Admins exist" — see lib/admin.ts bootstrapAdminUser).
 */
const PROTECTED_PREFIXES = ["/workflow", "/admin/setup", "/account"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
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
    "/account",
    "/reset-password",
    "/auth/:path*",
    "/workflow",
    "/workflow/:path*",
    "/admin/setup",
    "/admin/setup/:path*",
  ],
};
