"use client";

import { useActionState, useState } from "react";
import { demoLogin, type DemoLoginState } from "@/app/login/demoActions";
import type { DemoRoleOption } from "@/lib/demoAuth";

/**
 * Renders only the roles the server says are actually configured (see
 * lib/demoAuth.ts getAvailableDemoRoles) — never a client-side list the
 * browser could edit to add a role that isn't really available. Two
 * compact selects (Role, then Demo User within that role) replace the
 * old one-button-per-account grid; the resolved DemoRoleKey still goes
 * through the same `demoLogin` server action unchanged.
 */
export default function DemoLoginPanel({ roles }: { roles: DemoRoleOption[] }) {
  const [state, formAction, pending] = useActionState<DemoLoginState, FormData>(
    demoLogin,
    undefined
  );

  // Groups in the order the server already provides them (see
  // lib/demoAuth.ts DEMO_ROLE_ORDER/DEMO_ROLE_GROUPS: Admin, Contractor,
  // Subcontractor, Worker) — never reordered client-side.
  const groups: { name: string; roles: typeof roles }[] = [];
  for (const role of roles) {
    const existing = groups.find((g) => g.name === role.group);
    if (existing) existing.roles.push(role);
    else groups.push({ name: role.group, roles: [role] });
  }

  const [groupName, setGroupName] = useState(groups[0]?.name ?? "");
  const activeGroup = groups.find((g) => g.name === groupName) ?? groups[0];
  const [selectedKey, setSelectedKey] = useState<string>(activeGroup?.roles[0]?.key ?? "");

  // Re-select the first account in the newly chosen role right away, so
  // "Demo User" never shows a stale option from the previous group.
  function handleGroupChange(name: string) {
    setGroupName(name);
    const nextGroup = groups.find((g) => g.name === name);
    setSelectedKey(nextGroup?.roles[0]?.key ?? "");
  }

  if (roles.length === 0) return null;

  return (
    <div className="bg-brand-soft border border-brand-border rounded-lg p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Demo Mode</h2>
        <p className="text-xs text-foreground-secondary">
          Enter as a predefined demo identity — no password needed. For development/demo
          environments only.
        </p>
      </div>

      <form action={formAction} className="space-y-3">
        <input type="hidden" name="role" value={selectedKey} />

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
              Role
            </label>
            <select
              value={groupName}
              onChange={(e) => handleGroupChange(e.target.value)}
              className="w-full rounded-lg border border-brand-border bg-white text-foreground text-sm px-2.5 py-2 transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            >
              {groups.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          {activeGroup && activeGroup.roles.length > 1 && (
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-foreground-muted mb-1">
                Demo User
              </label>
              <select
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.target.value)}
                className="w-full rounded-lg border border-brand-border bg-white text-foreground text-sm px-2.5 py-2 transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
              >
                {activeGroup.roles.map((role) => (
                  <option key={role.key} value={role.key}>
                    {role.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={pending || !selectedKey}
          className="w-full rounded-lg bg-brand text-white text-sm font-semibold px-3 py-2 transition-colors duration-150 hover:bg-brand-hover disabled:opacity-50"
        >
          {pending ? "Entering…" : "Enter Demo"}
        </button>
      </form>

      {state?.error && (
        <p className="rounded-lg border border-error-border bg-error-soft px-2.5 py-1.5 text-xs text-error">
          {state.error}
        </p>
      )}
    </div>
  );
}
