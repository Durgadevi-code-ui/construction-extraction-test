"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { enterDemoWorkspace, type DemoLoginState } from "@/app/demo-login/actions";
import type { DemoRoleOption } from "@/lib/demoAccess";
import Button from "@/components/ui/Button";
import { Label, Select } from "@/components/ui/Input";

/**
 * Role, then trade/team, then one click — no email or password fields.
 * Lists only what the server says it can sign in as (lib/demoAccess.ts
 * availableDemoRoles); the form posts the chosen slot key and the server
 * resolves it, so editing the page can't reach any other account.
 */
export default function DemoLoginForm({ roles }: { roles: DemoRoleOption[] }) {
  const [state, formAction, pending] = useActionState<DemoLoginState, FormData>(enterDemoWorkspace, undefined);

  // Groups in the server's order: Admin, Contractor, Subcontractor, Worker.
  const groups: { name: string; roles: DemoRoleOption[] }[] = [];
  for (const role of roles) {
    const existing = groups.find((g) => g.name === role.group);
    if (existing) existing.roles.push(role);
    else groups.push({ name: role.group, roles: [role] });
  }

  const [groupName, setGroupName] = useState(groups[0]?.name ?? "");
  const activeGroup = groups.find((g) => g.name === groupName) ?? groups[0];
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

      {activeGroup && activeGroup.roles.length > 1 ? (
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
      ) : (
        activeGroup && (
          <p className="text-sm text-foreground-secondary">
            Access: <span className="font-medium text-foreground">{activeGroup.roles[0].team}</span>
          </p>
        )
      )}

      <p className="text-xs text-foreground-secondary">
        Contractor is the Supervisor role and Subcontractor the Foreman role. Admin manages the
        projects (work items, departments, imports, reviews) but not users or passwords.
      </p>

      {state?.error && (
        <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending || !selectedKey} className="w-full">
        {pending ? "Entering…" : "Enter Demo Workspace"}
      </Button>

      <p className="text-center text-xs text-foreground-secondary">
        <Link href="/login" className="text-brand hover:underline">
          Not a demo? Go to the regular sign-in page
        </Link>
      </p>
    </form>
  );
}
