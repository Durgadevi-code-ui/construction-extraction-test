import "server-only";
import { NextResponse } from "next/server";
import { DEMO_READ_ONLY_MESSAGE, isDemoReadOnlyMode } from "./demoEmail";

/**
 * Inactive unless DEMO_LOGIN_READ_ONLY=true (lib/demoEmail.ts): by default
 * a demo session goes through each route's normal authorization like any
 * other user. When the switch is on, this is the second, per-route layer
 * of the read-only rule (the first is proxy.ts). Every non-GET /api handler calls this right after its 401
 * check, with the user getCurrentUser() returned (lib/session.ts, whose
 * `isDemo` is derived from the verified session) — tests/demo-login.test.cjs
 * fails for any write handler that doesn't. So a route can't become
 * writable for demo sessions just because the proxy matcher or its claims
 * check missed it. Null for everyone else: real users are unaffected.
 */
export function demoWriteRefusal(user: { isDemo?: boolean } | null): NextResponse | null {
  if (!user?.isDemo || !isDemoReadOnlyMode()) return null;
  return NextResponse.json({ error: DEMO_READ_ONLY_MESSAGE }, { status: 403 });
}
