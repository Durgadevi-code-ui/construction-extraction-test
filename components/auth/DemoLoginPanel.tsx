"use client";

import { useActionState } from "react";
import { demoLogin, type DemoLoginState } from "@/app/login/demoActions";
import type { DemoRoleOption } from "@/lib/demoAuth";

/**
 * Renders only the roles the server says are actually configured (see
 * lib/demoAuth.ts getAvailableDemoRoles) — never a client-side list the
 * browser could edit to add a role that isn't really available. Each
 * button submits only its fixed role key; the server resolves the
 * email (see app/login/demoActions.ts).
 */
export default function DemoLoginPanel({ roles }: { roles: DemoRoleOption[] }) {
  const [state, formAction, pending] = useActionState<DemoLoginState, FormData>(
    demoLogin,
    undefined
  );

  if (roles.length === 0) return null;

  // Grouped under a heading per role section (Admin / Contractor /
  // Subcontractor / Worker) rather than one flat list — with 11 accounts,
  // department alone in the button label isn't enough to scan quickly;
  // the group heading narrows it to "which role" at a glance, the
  // button label itself narrows it to "which department" (see
  // lib/demoAuth.ts DEMO_ROLE_GROUPS/DEMO_ROLE_ORDER for where the
  // grouping/order comes from — never reordered client-side).
  const groups: { name: string; roles: typeof roles }[] = [];
  for (const role of roles) {
    const existing = groups.find((g) => g.name === role.group);
    if (existing) existing.roles.push(role);
    else groups.push({ name: role.group, roles: [role] });
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-amber-900">Demo Mode</h2>
        <p className="text-xs text-amber-700">
          Enter as a predefined demo identity — no password needed. For development/demo
          environments only.
        </p>
      </div>
      <div className="space-y-3">
        {groups.map((group) => (
          <div key={group.name}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-1">
              {group.name}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {group.roles.map((role) => (
                <form key={role.key} action={formAction}>
                  <input type="hidden" name="role" value={role.key} />
                  <button
                    type="submit"
                    disabled={pending}
                    className="w-full rounded border border-amber-300 bg-white text-amber-900 text-sm font-medium px-3 py-2 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {role.label}
                  </button>
                </form>
              ))}
            </div>
          </div>
        ))}
      </div>
      {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
    </div>
  );
}
