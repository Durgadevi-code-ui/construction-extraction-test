/**
 * Demo accounts (app/demo-login, lib/demoAccess.ts) use the reserved
 * example.com domain (RFC 2606), which no real person's address can have.
 * Demo accounts share projects and departments with real people, so this —
 * not their roles — is what tells them apart: configuration can never turn
 * a real member into a one-click account. No "server-only" import, so
 * proxy.ts can use it.
 */
const DEMO_EMAIL = /^[^@\s]+@example\.com$/;

export function isDemoAccountEmail(email: unknown): boolean {
  return typeof email === "string" && DEMO_EMAIL.test(email.trim().toLowerCase());
}

/**
 * Demo Login is the same application as normal login: a demo session can
 * do exactly what its account's role, project and delegation allow (the
 * normal authorization in every route), nothing more. DEMO_LOGIN_READ_ONLY
 * is an emergency switch only: set it to "true" and every demo session
 * becomes read-only again (proxy.ts and lib/demoWriteGuard.ts refuse
 * writes; components/ui/ReadOnly.tsx disables write controls). Unset — the
 * default — changes nothing for anyone.
 */
export function isDemoReadOnlyMode(): boolean {
  return process.env.DEMO_LOGIN_READ_ONLY?.trim().toLowerCase() === "true";
}

/** The one explanation every read-only refusal shows a demo session when
 * DEMO_LOGIN_READ_ONLY is on — proxy.ts, the per-route guard
 * (lib/demoWriteGuard.ts) and the disabled controls in the UI. */
export const DEMO_READ_ONLY_MESSAGE =
  "This view is read-only: you can see everything this role can, but changes are not saved.";
