import "server-only";

/**
 * Controlled demo-login mode (see AGENTS.md master prompt section 2/9)
 * — lets a presenter enter the app as a predefined identity without
 * typing a password, without reintroducing the old `?userId=`
 * impersonation hole that Phase 2 closed (see lib/session.ts).
 *
 * Security shape, deliberately unchanged from the original 4-slot
 * version (this file only widened the slot list to 11 named
 * role+department combinations — see app/login/demoActions.ts, which
 * needed no changes at all, since it already worked generically off
 * this file's exports):
 *   - OFF unless DEMO_MODE=true is set server-side. Never inferred
 *     from NODE_ENV — an operator must opt in explicitly per
 *     environment.
 *   - The browser only ever sends one of a fixed, closed set of role
 *     KEYS (e.g. "worker_electrical") — never an email or a user_id.
 *     Each key maps, server-side only, to an email read from its own
 *     environment variable. There is no code path from an arbitrary
 *     client-supplied string to an arbitrary identity: isDemoRoleKey()
 *     is a closed enum check, not a lookup.
 *   - The mapped email must already be a real, linked Supabase Auth
 *     account (see app/login/demoActions.ts) — demo mode selects among
 *     real accounts, it does not fabricate a session or bypass
 *     Supabase Auth itself, and never touches any existing account's
 *     password/email/role/department.
 *   - When DEMO_MODE is unset/false, none of this is reachable:
 *     getAvailableDemoRoles() returns [], the demo panel renders
 *     nothing, and demoLogin() refuses immediately. Normal Supabase
 *     Auth password login (lib/session.ts, app/login/actions.ts) is
 *     completely unmodified and always available.
 */

export const DEMO_MODE_ENABLED = process.env.DEMO_MODE === "true";

/**
 * One slot per real, distinct test account this app currently has —
 * named by role+department so the env var and the UI label are both
 * self-explanatory. Existing role terminology preserved (Foreman =
 * Subcontractor, Supervisor = Contractor — see lib/authContext.ts
 * CONTRACTOR_ROLES); these keys/labels are presentation only and never
 * change which underlying role/department the account actually has in
 * user_project_roles (server-side authorization, unaffected).
 */
export type DemoRoleKey =
  | "admin_all"
  | "supervisor_concrete"
  | "supervisor_electrical"
  | "supervisor_plumbing"
  | "supervisor_finishes"
  | "foreman_concrete"
  | "foreman_electrical"
  | "foreman_plumbing"
  | "foreman_finishes"
  | "worker_electrical"
  | "worker_plumbing"
  | "worker_hvac"
  | "worker_concrete"
  | "worker_finishes";

const DEMO_ROLE_ENV_VARS: Record<DemoRoleKey, string> = {
  admin_all: "DEMO_USER_ADMIN_EMAIL",
  supervisor_concrete: "DEMO_USER_SUPERVISOR_CONCRETE_EMAIL",
  supervisor_electrical: "DEMO_USER_SUPERVISOR_ELECTRICAL_EMAIL",
  supervisor_plumbing: "DEMO_USER_SUPERVISOR_PLUMBING_EMAIL",
  supervisor_finishes: "DEMO_USER_SUPERVISOR_FINISHES_EMAIL",
  foreman_concrete: "DEMO_USER_FOREMAN_CONCRETE_EMAIL",
  foreman_electrical: "DEMO_USER_FOREMAN_ELECTRICAL_EMAIL",
  foreman_plumbing: "DEMO_USER_FOREMAN_PLUMBING_EMAIL",
  foreman_finishes: "DEMO_USER_FOREMAN_FINISHES_EMAIL",
  worker_electrical: "DEMO_USER_WORKER_ELECTRICAL_EMAIL",
  worker_plumbing: "DEMO_USER_WORKER_PLUMBING_EMAIL",
  worker_hvac: "DEMO_USER_WORKER_HVAC_EMAIL",
  worker_concrete: "DEMO_USER_WORKER_CONCRETE_EMAIL",
  worker_finishes: "DEMO_USER_WORKER_FINISHES_EMAIL",
};

/** Descriptive label shown on the button — role AND department
 * together, per the explicit requirement that a presenter must
 * immediately know which role+department they're about to enter as. */
const DEMO_ROLE_LABELS: Record<DemoRoleKey, string> = {
  admin_all: "Admin — All Departments",
  supervisor_concrete: "Contractor — Concrete",
  supervisor_electrical: "Contractor — Electrical",
  supervisor_plumbing: "Contractor — Plumbing",
  supervisor_finishes: "Contractor — Finishes",
  foreman_concrete: "Subcontractor — Concrete",
  foreman_electrical: "Subcontractor — Electrical",
  foreman_plumbing: "Subcontractor — Plumbing",
  foreman_finishes: "Subcontractor — Finishes",
  worker_electrical: "Worker — Electrical",
  worker_plumbing: "Worker — Plumbing",
  worker_hvac: "Worker — HVAC",
  worker_concrete: "Worker — Concrete",
  worker_finishes: "Worker — Finishes",
};

/** Section a slot belongs to, purely for grouping the demo panel's
 * buttons under a heading (Admin / Contractor / Subcontractor /
 * Worker) — display-only, same reasoning as DEMO_ROLE_LABELS above.
 * These slot KEYS still say "supervisor_"/"foreman_" (unchanged — see
 * DemoRoleKey doc: renaming the underlying role code would require a
 * database migration, out of scope for a display-only rename); only
 * the label/group TEXT shown to a person changed. */
const DEMO_ROLE_GROUPS: Record<DemoRoleKey, string> = {
  admin_all: "Admin",
  supervisor_concrete: "Contractor",
  supervisor_electrical: "Contractor",
  supervisor_plumbing: "Contractor",
  supervisor_finishes: "Contractor",
  foreman_concrete: "Subcontractor",
  foreman_electrical: "Subcontractor",
  foreman_plumbing: "Subcontractor",
  foreman_finishes: "Subcontractor",
  worker_electrical: "Worker",
  worker_plumbing: "Worker",
  worker_hvac: "Worker",
  worker_concrete: "Worker",
  worker_finishes: "Worker",
};

// Fixed presentation order — Admin, then Contractors, then
// Subcontractors, then Workers, matching the order this feature was
// specified in.
const DEMO_ROLE_ORDER: DemoRoleKey[] = [
  "admin_all",
  "supervisor_concrete",
  "supervisor_electrical",
  "supervisor_plumbing",
  "supervisor_finishes",
  "foreman_concrete",
  "foreman_electrical",
  "foreman_plumbing",
  "foreman_finishes",
  "worker_electrical",
  "worker_plumbing",
  "worker_hvac",
  "worker_concrete",
  "worker_finishes",
];

export type DemoRoleOption = { key: DemoRoleKey; label: string; group: string };

export function isDemoRoleKey(value: unknown): value is DemoRoleKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEMO_ROLE_ENV_VARS, value);
}

/** Only the slots that are both demo-mode-enabled AND actually
 * configured with an email — never exposes which env var backs them,
 * never exposes the email itself. Safe to pass straight to a Client
 * Component. Slots with no configured email are simply omitted (no
 * broken/dead button for an account that isn't wired up yet).
 *
 * All four role groups (Admin/Contractor/Subcontractor/Worker) are
 * offered here, including the four Worker demo accounts (Electrical/
 * Plumbing/HVAC/Concrete) — this stays a demo/development environment
 * for now; real email/password sign-in (app/login/actions.ts) remains
 * available alongside this picker for every role, this just doesn't
 * exclude Worker from it. */
export function getAvailableDemoRoles(): DemoRoleOption[] {
  if (!DEMO_MODE_ENABLED) return [];
  return DEMO_ROLE_ORDER.filter((key) => !!process.env[DEMO_ROLE_ENV_VARS[key]]?.trim()).map((key) => ({
    key,
    label: DEMO_ROLE_LABELS[key],
    group: DEMO_ROLE_GROUPS[key],
  }));
}

/** Server-only resolution from a validated role key to its configured
 * demo email — never called with an unvalidated value (see
 * isDemoRoleKey, always checked first at every call site). */
export function resolveDemoEmail(key: DemoRoleKey): string | null {
  if (!DEMO_MODE_ENABLED) return null;
  return process.env[DEMO_ROLE_ENV_VARS[key]]?.trim() || null;
}
