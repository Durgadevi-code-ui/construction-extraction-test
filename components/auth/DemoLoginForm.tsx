"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { enterDemoWorkspace, type DemoLoginState } from "@/app/demo-login/actions";
import type { DemoRoleOption } from "@/lib/demoAccess";
import Button from "@/components/ui/Button";
import { Label, Select } from "@/components/ui/Input";

/**
 * Role, then trade/team, then Sign In — no email or password fields.
 * Lists only what the server says it can sign in as (lib/demoAccess.ts
 * availableDemoRoles); the form posts the chosen slot key and the server
 * resolves it, so editing the page can't reach any other account.
 *
 * "Admin" is not a demo account: the application has one Admin. Choosing
 * it leads to the normal email/password sign-in, which opens the full
 * Admin Setup after the real Admin signs in (/login?next=/admin/setup).
 */
const ADMIN_GROUP = "Admin";
const ADMIN_SIGN_IN = "/login?next=/admin/setup";

export default function DemoLoginForm({ roles }: { roles: DemoRoleOption[] }) {
  const [state, formAction, pending] = useActionState<DemoLoginState, FormData>(enterDemoWorkspace, undefined);

  // Admin first, then the server's order: Contractor, Subcontractor, Worker.
  const groups: { name: string; roles: DemoRoleOption[] }[] = [{ name: ADMIN_GROUP, roles: [] }];
  for (const role of roles) {
    const existing = groups.find((g) => g.name === role.group);
    if (existing) existing.roles.push(role);
    else groups.push({ name: role.group, roles: [role] });
  }

  // Start on the first demo role; Admin stays one choice away.
  const [groupName, setGroupName] = useState(groups[1]?.name ?? ADMIN_GROUP);
  const activeGroup = groups.find((g) => g.name === groupName) ?? groups[0];
  const isAdmin = activeGroup?.name === ADMIN_GROUP;
  const [selectedKey, setSelectedKey] = useState(activeGroup?.roles[0]?.key ?? "");

  // A new role starts on its first team, so the team never shows a stale
  // option from the previous role.
  function handleGroupChange(name: string) {
    setGroupName(name);
    setSelectedKey(groups.find((g) => g.name === name)?.roles[0]?.key ?? "");
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="role" value={selectedKey} />

      <div>
        <Label htmlFor="demo-role">Role</Label>
        <Select id="demo-role" value={groupName} onChange={(e) => handleGroupChange(e.target.value)}>
          {groups.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name}
            </option>
          ))}
        </Select>
      </div>

      {activeGroup && !isAdmin && (
        <div>
          <Label htmlFor="demo-team">Trade / Team</Label>
          <Select id="demo-team" value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)}>
            {activeGroup.roles.map((role) => (
              <option key={role.key} value={role.key}>
                {role.team}
              </option>
            ))}
          </Select>
        </div>
      )}

      <p className="text-xs text-foreground-secondary">
        {isAdmin
          ? "Admin signs in with the Admin account's own email and password and opens the full Admin Setup, exactly as on the regular sign-in page."
          : "Contractor is the Supervisor role and Subcontractor the Foreman role. Changes you make are saved to the presentation project only."}
      </p>

      {state?.error && (
        <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">
          {state.error}
        </p>
      )}

      {isAdmin ? (
        <Link
          href={ADMIN_SIGN_IN}
          className="flex w-full items-center justify-center rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
        >
          Continue to Admin Sign In
        </Link>
      ) : (
        <Button type="submit" disabled={pending || !selectedKey} className="w-full">
          {pending ? "Signing in…" : "Sign In"}
        </Button>
      )}

      <p className="text-center text-xs text-foreground-secondary">
        <Link href="/login" className="text-brand hover:underline">
          Not a demo? Go to the regular sign-in page
        </Link>
      </p>
    </form>
  );
}
