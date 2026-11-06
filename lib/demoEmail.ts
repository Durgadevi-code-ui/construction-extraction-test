/**
 * Demo accounts (app/demo-login, lib/demoAccess.ts) use the reserved
 * example.com domain (RFC 2606), which no real person's address can have.
 * Demo accounts share projects and departments with real people, so this —
 * not their roles — is what tells them apart: configuration can never turn
 * a real member into a one-click account, and proxy.ts keeps every demo
 * session read-only. No "server-only" import, so proxy.ts can use it.
 */
const DEMO_EMAIL = /^[^@\s]+@example\.com$/;

export function isDemoAccountEmail(email: unknown): boolean {
  return typeof email === "string" && DEMO_EMAIL.test(email.trim().toLowerCase());
}
