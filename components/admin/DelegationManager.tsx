"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Delegation, DelegationPermission } from "@/lib/delegationTypes";
import {
  WORKFLOW_DELEGATION_PERMISSIONS,
  ADMIN_DELEGATION_PERMISSIONS,
} from "@/lib/delegationTypes";
import type { Project, Department } from "@/lib/admin";
import { formatDateUS } from "@/lib/format";

export type ContractorOption = {
  userId: string;
  email: string;
  projectId: string;
  projectName: string;
  departmentId: string;
  departmentName: string;
};

type Props = {
  adminUserId: string;
  delegations: Delegation[];
  contractors: ContractorOption[];
  projects: Project[];
  departments: Department[];
};

/** Modules that are never delegable no matter what — shown as a fixed
 * reference list in Broader Administrative Access mode so an Admin
 * always sees exactly what's excluded (see
 * supabase/migrations/00000000000009_delegation_admin_permissions.sql). */
const ALWAYS_ADMIN_ONLY = [
  "Company Management (Companies are the root of the hierarchy — not project/department-scoped)",
  "Creating a brand-new Project (no scope exists yet to bound it to)",
  "Creating or promoting another unrestricted Admin account",
  "Removing/demoting the original Admin",
  "Delegation Management itself (granting/revoking delegations)",
  "Authentication, security settings, Supabase credentials, environment variables, RLS policies",
];

const PERMISSION_LABEL: Record<DelegationPermission, string> = {
  WORK_ITEM_MANAGEMENT: "Work Item Management (create/edit work items)",
  WORKER_ASSIGNMENT: "Worker Assignment (assign/remove workers)",
  PLANNED_QUANTITY_MANAGEMENT: "Planned Quantity Management (cross-department)",
  PROGRESS_REVIEW: "Progress Review (Contractor already has this by default)",
  PROJECT_MANAGEMENT: "Project Management (edit delegated project details — creating a new project stays Admin-only)",
  DEPARTMENT_MANAGEMENT: "Department Management (edit delegated departments; create requires whole-project scope)",
  USER_MANAGEMENT: "User Management (operational users only — never Admin accounts)",
};

/** yyyy-MM-ddTHH:mm for a <input type="datetime-local"> default value —
 * `now` and `now + hours` respectively, in the browser's local time. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/** Searchable multi-select checkbox list — shared by the Projects and
 * Departments pickers below so both look/behave identically. Filters
 * the visible options by `search`, but never touches `selected` (a
 * filtered-out option someone already checked stays checked). */
function MultiSelectList({
  label,
  searchPlaceholder,
  options,
  selected,
  onToggle,
  emptyMessage,
}: {
  label: string;
  searchPlaceholder: string;
  options: { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string) => void;
  emptyMessage: string;
}) {
  const [search, setSearch] = useState("");
  const filtered = options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()));
  const selectedSet = new Set(selected);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-foreground-secondary">{label}</label>
        {selected.length > 0 && (
          <span className="text-xs text-foreground-muted">{selected.length} selected</span>
        )}
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {options
            .filter((o) => selectedSet.has(o.id))
            .map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onToggle(o.id)}
                className="text-xs bg-brand-soft text-orange-700 border border-orange-200 rounded-full px-2 py-0.5 hover:bg-orange-100"
                title="Remove"
              >
                {o.label} ×
              </button>
            ))}
        </div>
      )}

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={searchPlaceholder}
        className="w-full rounded border border-line px-3 py-1.5 text-sm mb-1"
      />

      <div className="max-h-40 overflow-y-auto rounded border border-line divide-y divide-line">
        {options.length === 0 ? (
          <p className="px-3 py-2 text-sm text-foreground-muted">{emptyMessage}</p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-2 text-sm text-foreground-muted">No matches.</p>
        ) : (
          filtered.map((o) => (
            <label
              key={o.id}
              className="flex items-center gap-2 px-3 py-1.5 text-sm text-foreground-secondary hover:bg-surface-soft cursor-pointer"
            >
              <input type="checkbox" checked={selectedSet.has(o.id)} onChange={() => onToggle(o.id)} />
              {o.label}
            </label>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Admin's UI for the temporary Admin -> Contractor delegation
 * (Requirement: Admin may be unavailable and needs to hand off
 * selected capabilities to a Contractor for a bounded window — see
 * lib/delegation.ts / supabase/migrations/00000000000006_admin_delegations.sql
 * and 00000000000008_delegation_scopes.sql for the multi-project/
 * multi-department scope). Grant form (multi-select projects,
 * departments, permissions) + list with Revoke, both ADMIN-only
 * server-side (createDelegation/revokeDelegation both assert this
 * independently of this UI even being reachable).
 */
export default function DelegationManager({
  adminUserId,
  delegations,
  contractors,
  projects,
  departments,
}: Props) {
  const router = useRouter();
  const [delegateUserId, setDelegateUserId] = useState(contractors[0]?.userId ?? "");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [accessType, setAccessType] = useState<"selected" | "broader">("selected");
  const [permissions, setPermissions] = useState<DelegationPermission[]>([]);
  const [reason, setReason] = useState("");
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const [startsAt, setStartsAt] = useState(toLocalInputValue(now));
  const [endsAt, setEndsAt] = useState(toLocalInputValue(in24h));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const projectIdSet = useMemo(() => new Set(projectIds), [projectIds]);
  // Departments offered are only from the currently-selected project(s)
  // — matches the create-side validation (a department not belonging to
  // a selected project is rejected server-side) and keeps the picker
  // from offering choices that would just be denied.
  const availableDepartments = departments.filter((d) => projectIdSet.has(d.projectId));

  function toggleProject(projectId: string) {
    setProjectIds((prev) => {
      const next = prev.includes(projectId) ? prev.filter((p) => p !== projectId) : [...prev, projectId];
      // Dropping a project also drops any department picks that only
      // belonged to it — otherwise a stale department selection could
      // silently survive after its project is deselected.
      setDepartmentIds((prevDepts) =>
        prevDepts.filter((id) => {
          const dept = departments.find((d) => d.departmentId === id);
          return dept ? next.includes(dept.projectId) : false;
        })
      );
      return next;
    });
  }

  function toggleDepartment(departmentId: string) {
    setDepartmentIds((prev) =>
      prev.includes(departmentId) ? prev.filter((d) => d !== departmentId) : [...prev, departmentId]
    );
  }

  function togglePermission(p: DelegationPermission) {
    setPermissions((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  function handleAccessTypeChange(type: "selected" | "broader") {
    setAccessType(type);
    // Switching to the simpler "Selected Permissions" mode drops any
    // administrative-module picks that mode doesn't show — never leave
    // a hidden, still-selected permission an Admin can't see/uncheck.
    if (type === "selected") {
      setPermissions((prev) => prev.filter((p) => !(ADMIN_DELEGATION_PERMISSIONS as string[]).includes(p)));
    }
  }

  const canSubmit = !!delegateUserId && projectIds.length > 0 && permissions.length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminUserId,
          delegateUserId,
          projectIds,
          departmentIds,
          permissions,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          reason: reason.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create delegation.");
      setProjectIds([]);
      setDepartmentIds([]);
      setPermissions([]);
      setReason("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create delegation.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(delegationId: string) {
    if (!window.confirm("Revoke this delegation immediately?")) return;
    setBusyId(delegationId);
    setError(null);
    try {
      const res = await fetch("/api/admin/delegations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminUserId, delegationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to revoke delegation.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke delegation.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-brand-soft border border-orange-200 rounded-lg p-3 text-xs text-orange-900">
        Temporarily hand off selected administrative capabilities to a Contractor — e.g. while
        Admin is on leave. Access is scoped to exactly the project(s), department(s) and
        permission(s) selected below and expires automatically at the end time. Leaving
        Departments empty grants every department of every selected project. Company/Project/
        Department/User administration is never delegable and always stays Admin-only.
      </div>

      {contractors.length === 0 ? (
        <EmptyPrereq message="No Contractor (SUPERVISOR) users exist yet — create one in the Users tab first." />
      ) : (
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-line p-4 space-y-3"
        >
          <h2 className="font-semibold text-foreground text-sm">New Delegation</h2>

          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-1">Contractor</label>
            <select
              value={delegateUserId}
              onChange={(e) => setDelegateUserId(e.target.value)}
              className="w-full rounded border border-line px-3 py-2 text-sm"
            >
              {contractors.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.email} — {c.projectName} / {c.departmentName}
                </option>
              ))}
            </select>
          </div>

          <MultiSelectList
            label="Projects (select one or more)"
            searchPlaceholder="Search projects…"
            options={projects.map((p) => ({ id: p.projectId, label: `${p.projectName} (${p.projectCode})` }))}
            selected={projectIds}
            onToggle={toggleProject}
            emptyMessage="No projects exist yet."
          />

          <MultiSelectList
            label="Departments (optional — leave empty for every department of each selected project)"
            searchPlaceholder="Search departments…"
            options={availableDepartments.map((d) => ({
              id: d.departmentId,
              label: `${d.departmentName} — ${d.projectName}`,
            }))}
            selected={departmentIds}
            onToggle={toggleDepartment}
            emptyMessage={
              projectIds.length === 0
                ? "Select at least one project above to choose specific departments."
                : "No departments in the selected project(s)."
            }
          />

          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-1">Access Type</label>
            <div className="flex gap-4 text-sm text-foreground-secondary mb-2">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="accessType"
                  checked={accessType === "selected"}
                  onChange={() => handleAccessTypeChange("selected")}
                />
                Selected Permissions
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="accessType"
                  checked={accessType === "broader"}
                  onChange={() => handleAccessTypeChange("broader")}
                />
                Broader Administrative Access
              </label>
            </div>

            {accessType === "selected" ? (
              <div className="space-y-1">
                {WORKFLOW_DELEGATION_PERMISSIONS.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm text-foreground-secondary">
                    <input
                      type="checkbox"
                      checked={permissions.includes(p)}
                      onChange={() => togglePermission(p)}
                    />
                    {PERMISSION_LABEL[p]}
                  </label>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <p className="text-xs font-semibold text-foreground-secondary uppercase tracking-wide mb-1">
                    Workflow Permissions
                  </p>
                  <div className="space-y-1">
                    {WORKFLOW_DELEGATION_PERMISSIONS.map((p) => (
                      <label key={p} className="flex items-center gap-2 text-sm text-foreground-secondary">
                        <input
                          type="checkbox"
                          checked={permissions.includes(p)}
                          onChange={() => togglePermission(p)}
                        />
                        {PERMISSION_LABEL[p]}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold text-foreground-secondary uppercase tracking-wide mb-1">
                    Administrative Modules
                  </p>
                  <div className="space-y-1">
                    {ADMIN_DELEGATION_PERMISSIONS.map((p) => (
                      <label key={p} className="flex items-center gap-2 text-sm text-foreground-secondary">
                        <input
                          type="checkbox"
                          checked={permissions.includes(p)}
                          onChange={() => togglePermission(p)}
                        />
                        {PERMISSION_LABEL[p]}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="bg-surface-soft border border-line rounded p-2.5 text-xs text-foreground-secondary">
                  <p className="font-medium text-foreground-secondary mb-1">Always Admin-only (never delegable):</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {ALWAYS_ADMIN_ONLY.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground-secondary mb-1">Start</label>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="w-full rounded border border-line px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground-secondary mb-1">End</label>
              <input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                className="w-full rounded border border-line px-3 py-2 text-sm"
              />
              {new Date(endsAt) <= new Date(startsAt) && (
                <p className="text-xs text-red-600 mt-1">End must be after Start.</p>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-1">
              Reason / Remarks (optional)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Admin on leave Mar 5–7"
              className="w-full rounded border border-line px-3 py-2 text-sm"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting || !canSubmit || new Date(endsAt) <= new Date(startsAt)}
              className="rounded bg-brand text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create Delegation"}
            </button>
            <button
              type="button"
              onClick={() => {
                setProjectIds([]);
                setDepartmentIds([]);
                setPermissions([]);
                setReason("");
              }}
              disabled={submitting}
              className="rounded border border-line text-foreground-secondary text-sm font-medium px-4 py-2 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      )}

      <section className="bg-white rounded-lg border border-line p-4">
        <h2 className="font-semibold text-foreground text-sm mb-2">Existing Delegations</h2>
        {delegations.length === 0 ? (
          <p className="text-sm text-foreground-muted">None yet.</p>
        ) : (
          <div className="space-y-2">
            {delegations.map((d) => (
              <div
                key={d.delegationId}
                className="py-2 border-b border-line last:border-0 text-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <span className="font-medium">{d.delegateEmail}</span>
                    <span
                      className={`ml-2 text-xs px-2 py-0.5 rounded-full ${
                        d.isCurrentlyActive
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-foreground-secondary"
                      }`}
                    >
                      {d.status === "Revoked"
                        ? "Revoked"
                        : d.isCurrentlyActive
                          ? "Active now"
                          : new Date(d.startsAt) > new Date()
                            ? "Scheduled"
                            : "Expired"}
                    </span>
                  </div>
                  {d.status === "Active" && d.isCurrentlyActive && (
                    <button
                      onClick={() => handleRevoke(d.delegationId)}
                      disabled={busyId === d.delegationId}
                      className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 shrink-0"
                    >
                      {busyId === d.delegationId ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </div>
                <p className="text-foreground-secondary mt-1">
                  <span className="text-foreground-muted">Projects:</span>{" "}
                  {d.projects.map((p) => p.projectName).join(", ") || "(none)"}
                </p>
                <p className="text-foreground-secondary mt-0.5">
                  <span className="text-foreground-muted">Departments:</span>{" "}
                  {d.departments.length > 0
                    ? d.departments.map((dep) => dep.departmentName).join(", ")
                    : "Every department of each selected project"}
                </p>
                <p className="text-foreground-secondary mt-0.5">
                  <span className="text-foreground-muted">Permissions:</span>{" "}
                  {d.permissions.map((p) => PERMISSION_LABEL[p] ?? p).join(" · ")}
                </p>
                {d.reason && (
                  <p className="text-foreground-secondary mt-0.5">
                    <span className="text-foreground-muted">Reason:</span> {d.reason}
                  </p>
                )}
                <p className="text-foreground-muted mt-0.5">
                  {formatDateUS(d.startsAt)} → {formatDateUS(d.endsAt)}{" "}
                  · granted by {d.adminEmail}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EmptyPrereq({ message }: { message: string }) {
  return (
    <p className="text-sm text-foreground-secondary bg-white rounded-lg border border-line p-4">
      {message}
    </p>
  );
}
