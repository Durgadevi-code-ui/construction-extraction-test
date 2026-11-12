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
 * "Admin" is the Admin door (lib/demoAccess.ts ADMIN_DOOR_KEY): a public,
 * passwordless entry that signs in as an ordinary isolated demo account
 * and opens a READ-ONLY preview of the Admin dashboard, scoped to the demo
 * project. It is never the real ADMIN — creating users, resetting
 * passwords, changing roles and delegations require signing in as the
 * Admin (the secondary link below).
 */
const ADMIN_GROUP = "Admin";
const ADMIN_DOOR_KEY = "admin";
const ADMIN_REAL_SIGN_IN = "/login?next=/admin/setup";

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
      <input type="hidden" name="role" value={isAdmin ? ADMIN_DOOR_KEY : selectedKey} />

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
          ? "Admin opens the Admin dashboard, read-only. Creating users, resetting passwords, changing roles and delegations require signing in as the Admin."
          : "Contractor is the Supervisor role and Subcontractor the Foreman role. Changes you make are saved to the presentation project only."}
      </p>

      {state?.error && (
        <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending || (!isAdmin && !selectedKey)} className="w-full">
        {pending ? "Signing in…" : "Sign In"}
      </Button>

      {isAdmin && (
        <p className="text-center text-xs text-foreground-secondary">
          <Link href={ADMIN_REAL_SIGN_IN} className="text-brand hover:underline">
            Manage as the Admin (sign in)
          </Link>
        </p>
      )}

      <p className="text-center text-xs text-foreground-secondary">
        <Link href="/login" className="text-brand hover:underline">
          Not a demo? Go to the regular sign-in page
        </Link>
      </p>
    </form>
  );
}
