"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  Company,
  Project,
  Department,
  AdminWorkItem,
  WorkItemDependency,
  UserAccount,
  StandardDepartment,
} from "@/lib/admin";
import type { Delegation, DelegationPermission } from "@/lib/delegationTypes";
import DelegationManager, { type ContractorOption } from "./DelegationManager";
import ExcelImportPanel from "./ExcelImportPanel";
import { formatPercent, formatQuantity } from "@/lib/format";
import {
  Inbox,
  Building2,
  FolderKanban,
  ListChecks,
  Users as UsersIcon,
  UserCheck,
  ShieldCheck,
  MessageSquare,
} from "lucide-react";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Badge, { type BadgeVariant } from "@/components/ui/Badge";
import EmptyState from "@/components/ui/EmptyState";
import Link from "next/link";
import DashboardShell, { type ShellTab } from "@/components/workflow/DashboardShell";
import ChatPanel from "@/components/workflow/ChatPanel";

type Props = {
  adminUserId: string;
  /** The signed-in caller's email — purely for the header's profile
   * chip (see DashboardShell). */
  userEmail?: string;
  /** False for a Contractor reached here only via an active
   * administrative delegation (see lib/delegation.ts
   * resolveAdminSetupAccess) — every tab below reads this to hide
   * never-delegable modules (Companies, Delegations) entirely and to
   * restrict what a delegate can create vs. only edit. Every array prop
   * (companies/projects/departments/workItems/users) has ALREADY been
   * filtered to the caller's scope server-side (app/admin/setup/page.tsx)
   * — this component never re-derives or trusts a wider scope. */
  isRealAdmin: boolean;
  /** Which administrative permissions an active delegation currently
   * grants — irrelevant when isRealAdmin (a real Admin can always do
   * everything). Empty for a real Admin. */
  delegatedPermissions: DelegationPermission[];
  companies: Company[];
  projects: Project[];
  departments: Department[];
  workItems: AdminWorkItem[];
  workItemDependencies: WorkItemDependency[];
  users: UserAccount[];
  delegations: Delegation[];
  contractors: ContractorOption[];
  standardDepartments: StandardDepartment[];
};

type Tab = "companies" | "projects" | "departments" | "workItems" | "users" | "delegations" | "communication";

const ALL_TABS: { id: Tab; label: string; adminOnly?: boolean; permission?: DelegationPermission }[] = [
  { id: "companies", label: "Companies", adminOnly: true },
  { id: "projects", label: "Projects", permission: "PROJECT_MANAGEMENT" },
  { id: "departments", label: "Departments", permission: "DEPARTMENT_MANAGEMENT" },
  { id: "workItems", label: "Work Items", permission: "WORK_ITEM_MANAGEMENT" },
  { id: "users", label: "Users", permission: "USER_MANAGEMENT" },
  { id: "delegations", label: "Delegations", adminOnly: true },
];

const TAB_ICON: Record<Tab, ShellTab["icon"]> = {
  companies: Building2,
  projects: FolderKanban,
  departments: Building2,
  workItems: ListChecks,
  users: UsersIcon,
  delegations: ShieldCheck,
  communication: MessageSquare,
};

const TAB_HEADING: Record<Tab, string> = {
  companies: "Companies",
  projects: "Projects",
  departments: "Departments",
  workItems: "Work Items",
  users: "Users",
  delegations: "Delegations",
  communication: "Communication",
};

/** Every tab is always available to a real Admin. For a delegated
 * caller, a tab shows only when its module was actually granted — a
 * delegate with only e.g. USER_MANAGEMENT never even sees a Companies
 * or Work Items tab to try their luck against (backend still enforces
 * this independently — see every /api/admin/* route). */
function visibleTabs(isRealAdmin: boolean, delegatedPermissions: DelegationPermission[]): Tab[] {
  if (isRealAdmin) return ALL_TABS.map((t) => t.id);
  return ALL_TABS.filter((t) => !t.adminOnly && t.permission && delegatedPermissions.includes(t.permission)).map(
    (t) => t.id
  );
}

const ROLE_OPTIONS = ["WORKER", "FOREMAN", "SUPERVISOR", "ADMIN"];
/** Never offered to a delegated (non-real-Admin) caller — creating or
 * promoting an ADMIN account is blocked server-side regardless (see
 * app/api/admin/users/route.ts), this is the matching UI-level guard so
 * a delegate is never even shown the option. */
const DELEGATED_ROLE_OPTIONS = ["WORKER", "FOREMAN", "SUPERVISOR"];

/** Display-only labels for the Role dropdown below — the underlying
 * database role values (ROLE_OPTIONS) are unchanged. Same business
 * terminology as lib/format.ts humanizeRole (Contractor/Subcontractor/
 * Worker/Admin), just not reusable here since this maps a full option
 * list, not one value read back from the DB. */
const ROLE_OPTION_LABEL: Record<string, string> = {
  WORKER: "Worker",
  FOREMAN: "Subcontractor",
  SUPERVISOR: "Contractor",
  ADMIN: "Admin",
};

/** Suggested Unit of Measure values via <datalist> — the field stays
 * plain free text (see UOM_DATALIST_ID usages below), so a
 * project-specific unit not in this list, for any department/trade, is
 * always still allowed. Not tied to any one department (e.g. m² isn't
 * "the concrete unit") — every work item picks whichever of these fits
 * its own measurement, or types something else entirely. */
const UOM_SUGGESTIONS = [
  "m²", "m", "m³", "ft", "LF", "SF", "CY", "CF", "EA", "Nos",
  "kg", "ton", "lb", "gal", "hours", "days", "LS", "TR",
];
const UOM_DATALIST_ID = "uom-suggestions";

export default function AdminSetupPanel({
  adminUserId,
  userEmail,
  isRealAdmin,
  delegatedPermissions,
  companies,
  projects,
  departments,
  workItems,
  workItemDependencies,
  users,
  delegations,
  contractors,
  standardDepartments,
}: Props) {
  const shownTabs = visibleTabs(isRealAdmin, delegatedPermissions);
  const [tab, setTab] = useState<Tab>(shownTabs[0] ?? "projects");

  if (shownTabs.length === 0) {
    return (
      <p className="text-sm text-foreground-secondary bg-white rounded-lg border border-line p-4">
        Your active delegation doesn&apos;t grant any Admin Setup module yet.
      </p>
    );
  }

  // Communication is available to every caller who can reach Admin
  // Setup at all (real Admin or any delegate) — it's not one of the
  // gated data-management modules ALL_TABS/visibleTabs governs, so it's
  // appended here rather than folded into that permission system.
  const allowedTabs: Tab[] = [...shownTabs, "communication"];
  const activeTab = allowedTabs.includes(tab) ? tab : shownTabs[0];

  const shellTabs: ShellTab[] = [
    ...ALL_TABS.filter((t) => shownTabs.includes(t.id)).map((t) => ({
      key: t.id,
      label: t.label,
      icon: TAB_ICON[t.id],
    })),
    { key: "communication", label: "Communication", icon: TAB_ICON.communication },
  ];

  return (
    <DashboardShell
      tabs={shellTabs}
      activeTab={activeTab}
      onTabChange={(key) => setTab(key as Tab)}
      heading={TAB_HEADING[activeTab]}
      subheading={isRealAdmin ? undefined : "Viewing under a temporary administrative delegation."}
      userId={adminUserId}
      userEmail={userEmail}
      roleLabel={isRealAdmin ? "Admin" : "Delegated Admin"}
      actions={
        // Relocated from the removed top nav bar (see
        // components/workflow/TopNav.tsx) — same two links, same
        // Extraction Test (Dev) gating (real Admin only, never a
        // delegated caller), just living in the main screen now instead
        // of a header above it.
        <div className="flex items-center gap-1.5">
          <Link
            href="/workflow/dashboard"
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-foreground-secondary border border-line transition-colors duration-150 hover:bg-surface-hover hover:text-foreground whitespace-nowrap"
          >
            Dashboard
          </Link>
          {isRealAdmin && (
            <Link
              href="/dev/extraction-test"
              title="Developer/testing tool for the extraction pipeline"
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-foreground-secondary border border-line transition-colors duration-150 hover:bg-surface-hover hover:text-foreground whitespace-nowrap"
            >
              Extraction Test (Dev)
            </Link>
          )}
        </div>
      }
    >
      {activeTab === "companies" && (
        <div className="space-y-4">
          <SystemOverviewStats companies={companies} projects={projects} users={users} />
          <CompaniesTab adminUserId={adminUserId} companies={companies} />
        </div>
      )}
      {activeTab === "projects" && (
        <ProjectsTab
          adminUserId={adminUserId}
          isRealAdmin={isRealAdmin}
          projects={projects}
          companies={companies}
        />
      )}
      {activeTab === "departments" && (
        <DepartmentsTab
          adminUserId={adminUserId}
          isRealAdmin={isRealAdmin}
          departments={departments}
          projects={projects}
          standardDepartments={standardDepartments}
        />
      )}
      {activeTab === "workItems" && (
        <WorkItemsTab
          adminUserId={adminUserId}
          workItems={workItems}
          departments={departments}
          workItemDependencies={workItemDependencies}
        />
      )}
      {activeTab === "users" && (
        <UsersTab
          adminUserId={adminUserId}
          isRealAdmin={isRealAdmin}
          users={users}
          departments={departments}
          projects={projects}
        />
      )}
      {activeTab === "delegations" && (
        <DelegationManager
          adminUserId={adminUserId}
          delegations={delegations}
          contractors={contractors}
          projects={projects}
          departments={departments}
        />
      )}

      {activeTab === "communication" && (
        <ChatPanel projects={projects.map((p) => ({ projectId: p.projectId, projectName: p.projectName }))} />
      )}
    </DashboardShell>
  );
}

/** Top-of-dashboard summary row — counts derived from the same
 * companies/projects/users lists already fetched for their own tabs
 * (no new query), matching the reference design's "System Overview". */
function SystemOverviewStats({
  companies,
  projects,
  users,
}: {
  companies: Company[];
  projects: Project[];
  users: UserAccount[];
}) {
  const activeUsers = users.filter((u) => u.status === "Active").length;
  const stats: { icon: typeof Building2; label: string; value: number; tone: "brand" | "success" }[] = [
    { icon: Building2, label: "Total Companies", value: companies.length, tone: "brand" },
    { icon: FolderKanban, label: "Total Projects", value: projects.length, tone: "brand" },
    { icon: UsersIcon, label: "Total Users", value: users.length, tone: "brand" },
    { icon: UserCheck, label: "Active Users", value: activeUsers, tone: "success" },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="flex flex-col gap-2 rounded-lg border border-line bg-white p-3">
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-lg ${
              s.tone === "success" ? "bg-success text-white" : "bg-brand text-white"
            }`}
          >
            <s.icon className="h-4 w-4" strokeWidth={2} />
          </span>
          <div>
            <p className="text-lg font-bold tabular-nums text-foreground leading-tight">{s.value}</p>
            <p className="text-xs text-foreground-secondary">{s.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function useSubmit(path: string, method: "POST" | "PATCH" | "DELETE" = "POST") {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(body: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed.");
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  return { submit, submitting, error };
}

function CompaniesTab({ adminUserId, companies }: { adminUserId: string; companies: Company[] }) {
  const { submit, submitting, error } = useSubmit("/api/admin/companies");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submit({ actorUserId: adminUserId, name, code, address });
    if (ok) {
      setName("");
      setCode("");
      setAddress("");
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-line p-4 space-y-3">
        <h2 className="font-semibold text-foreground text-sm">New Company</h2>
        <Field label="Company Name" value={name} onChange={setName} required />
        <Field label="Company Code" value={code} onChange={setCode} required />
        <Field label="Address" value={address} onChange={setAddress} />
        <SubmitButton submitting={submitting} label="Create Company" />
        {error && (
          <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
        )}
      </form>

      <ListSection title="Existing Companies" empty={companies.length === 0}>
        {companies.map((c) => (
          <Row key={c.companyId}>
            <span className="font-medium">{c.name}</span>
            <span className="text-foreground-secondary ml-2">({c.code})</span>
            <StatusBadge status={c.status} />
          </Row>
        ))}
      </ListSection>
    </div>
  );
}

function ProjectsTab({
  adminUserId,
  isRealAdmin,
  projects,
  companies,
}: {
  adminUserId: string;
  isRealAdmin: boolean;
  projects: Project[];
  companies: Company[];
}) {
  const { submit, submitting, error } = useSubmit("/api/admin/projects");
  const [companyId, setCompanyId] = useState(companies[0]?.companyId ?? "");
  const [projectCode, setProjectCode] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectLocation, setProjectLocation] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submit({ actorUserId: adminUserId, companyId, projectCode, projectName, projectLocation });
    if (ok) {
      setProjectCode("");
      setProjectName("");
      setProjectLocation("");
    }
  }

  // Creating a brand-new project stays Admin-only (see
  // app/api/admin/projects/route.ts POST doc) — a delegated caller only
  // ever sees the Edit affordance below on their already-delegated
  // projects, never this form.
  if (!isRealAdmin) {
    return (
      <div className="space-y-4">
        <p className="text-xs text-warning bg-warning-soft border border-warning-border rounded-lg p-2.5">
          Creating a new project is Admin-only. You can edit the details of your delegated
          project(s) below.
        </p>
        <ListSection title="Delegated Projects" empty={projects.length === 0}>
          {projects.map((p) => (
            <ProjectRow key={p.projectId} adminUserId={adminUserId} project={p} />
          ))}
        </ListSection>
      </div>
    );
  }

  if (companies.length === 0) {
    return <EmptyPrereq message="Create a Company first." />;
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-line p-4 space-y-3">
        <h2 className="font-semibold text-foreground text-sm">New Project</h2>
        <SelectField
          label="Company"
          value={companyId}
          onChange={setCompanyId}
          options={companies.map((c) => ({ value: c.companyId, label: c.name }))}
        />
        <Field label="Project Name" value={projectName} onChange={setProjectName} required />
        <Field label="Project Code" value={projectCode} onChange={setProjectCode} required />
        <Field label="Location" value={projectLocation} onChange={setProjectLocation} />
        <SubmitButton submitting={submitting} label="Create Project" />
        {error && (
            <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}
      </form>

      <ListSection title="Existing Projects" empty={projects.length === 0}>
        {projects.map((p) => (
          <ProjectRow key={p.projectId} adminUserId={adminUserId} project={p} />
        ))}
      </ListSection>
    </div>
  );
}

/** One project, with an inline Edit affordance (name/location) — shared
 * by the real-Admin "Existing Projects" list and the delegated-caller
 * "Delegated Projects" list above, so editing behaves identically in
 * both (the server-side check, not this component, decides who's
 * actually authorized — see app/api/admin/projects/route.ts PATCH). */
function ProjectRow({ adminUserId, project }: { adminUserId: string; project: Project }) {
  const { submit, submitting, error } = useSubmit("/api/admin/projects", "PATCH");
  const [editing, setEditing] = useState(false);
  const [projectName, setProjectName] = useState(project.projectName);
  const [projectLocation, setProjectLocation] = useState(project.projectLocation ?? "");

  async function handleSave() {
    const ok = await submit({
      actorUserId: adminUserId,
      projectId: project.projectId,
      projectName,
      projectLocation,
    });
    if (ok) setEditing(false);
  }

  const { submit: submitToggle, submitting: togglingContext } = useSubmit("/api/admin/projects", "PATCH");

  async function handleToggleTaskContext() {
    await submitToggle({
      actorUserId: adminUserId,
      projectId: project.projectId,
      taskContextEnabled: !project.taskContextEnabled,
    });
  }

  return (
    <div className="px-4 py-3 border-b border-line last:border-0 text-sm transition-colors duration-150 hover:bg-surface-hover">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{project.projectName}</span>
          <span className="text-foreground-secondary">
            ({project.projectCode}) — {project.companyName}
          </span>
          <StatusBadge status={project.status} />
        </div>
        <div className="flex gap-2 shrink-0">
          {!editing && (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      </div>

      <label className="mt-2 flex items-center gap-2 text-xs text-foreground-secondary">
        <input
          type="checkbox"
          checked={project.taskContextEnabled}
          disabled={togglingContext}
          onChange={handleToggleTaskContext}
        />
        Project / Work Item / Task selection on Worker Dashboard
        {togglingContext && " (saving…)"}
      </label>
      <p className="text-[11px] text-foreground-muted">
        When off, workers are not shown the selection controls — their assigned work item is
        still chosen automatically and every input method keeps working.
      </p>

      <ExcelImportPanel projectId={project.projectId} />

      {editing && (
        <div className="mt-2 space-y-2 bg-surface-soft rounded-lg p-3">
          <Field label="Project Name" value={projectName} onChange={setProjectName} required />
          <Field label="Location" value={projectLocation} onChange={setProjectLocation} />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {error && (
            <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

function DepartmentsTab({
  adminUserId,
  isRealAdmin,
  departments,
  projects,
  standardDepartments,
}: {
  adminUserId: string;
  isRealAdmin: boolean;
  departments: Department[];
  projects: Project[];
  standardDepartments: StandardDepartment[];
}) {
  const { submit, submitting, error } = useSubmit("/api/admin/departments");
  const [projectId, setProjectId] = useState(projects[0]?.projectId ?? "");
  const [departmentCode, setDepartmentCode] = useState("");
  const [departmentName, setDepartmentName] = useState("");
  const [standardPick, setStandardPick] = useState("");

  function handlePickStandard(standardDepartmentId: string) {
    setStandardPick(standardDepartmentId);
    const match = standardDepartments.find((d) => d.standardDepartmentId === standardDepartmentId);
    if (match) {
      setDepartmentName(match.name);
      setDepartmentCode(match.code);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submit({ actorUserId: adminUserId, projectId, departmentCode, departmentName });
    if (ok) {
      setDepartmentCode("");
      setDepartmentName("");
    }
  }

  if (projects.length === 0) {
    return <EmptyPrereq message="No project in scope to create a Department under yet." />;
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-line p-4 space-y-3">
        <h2 className="font-semibold text-foreground text-sm">New Department</h2>
        {!isRealAdmin && (
          <p className="text-xs text-warning bg-warning-soft border border-warning-border rounded-lg p-2.5">
            Creating a department requires a whole-project Department Management delegation for
            the selected project — a delegation restricted to specific departments can edit them
            but can&apos;t create new ones (the server will reject the attempt otherwise).
          </p>
        )}
        <SelectField
          label="Project"
          value={projectId}
          onChange={setProjectId}
          options={projects.map((p) => ({ value: p.projectId, label: p.projectName }))}
        />
        {standardDepartments.length > 0 && (
          <SelectField
            label="Pick a standard department (optional)"
            value={standardPick}
            onChange={handlePickStandard}
            options={[
              { value: "", label: "— Custom department —" },
              ...standardDepartments.map((d) => ({ value: d.standardDepartmentId, label: d.name })),
            ]}
          />
        )}
        <Field label="Department Name" value={departmentName} onChange={setDepartmentName} required />
        <Field label="Department Code" value={departmentCode} onChange={setDepartmentCode} required />
        <SubmitButton submitting={submitting} label="Create Department" />
        {error && (
            <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}
      </form>

      <ListSection title={isRealAdmin ? "Existing Departments" : "Delegated Departments"} empty={departments.length === 0}>
        {departments.map((d) => (
          <DepartmentRow key={d.departmentId} adminUserId={adminUserId} department={d} />
        ))}
      </ListSection>
    </div>
  );
}

/** One department, with an inline Edit affordance (name only — code and
 * project are identity fields, never edited here; see
 * lib/admin.ts updateDepartment). */
function DepartmentRow({ adminUserId, department }: { adminUserId: string; department: Department }) {
  const { submit, submitting, error } = useSubmit("/api/admin/departments", "PATCH");
  const [editing, setEditing] = useState(false);
  const [departmentName, setDepartmentName] = useState(department.departmentName);

  async function handleSave() {
    const ok = await submit({
      actorUserId: adminUserId,
      departmentId: department.departmentId,
      departmentName,
    });
    if (ok) setEditing(false);
  }

  return (
    <div className="px-4 py-3 border-b border-line last:border-0 text-sm transition-colors duration-150 hover:bg-surface-hover">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{department.departmentName}</span>
          <span className="text-foreground-secondary">
            ({department.departmentCode}) — {department.projectName}
          </span>
          <StatusBadge status={department.status} />
        </div>
        {!editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)} className="shrink-0">
            Edit
          </Button>
        )}
      </div>

      {editing && (
        <div className="mt-2 space-y-2 bg-surface-soft rounded-lg p-3">
          <Field label="Department Name" value={departmentName} onChange={setDepartmentName} required />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {error && (
            <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

function WorkItemsTab({
  adminUserId,
  workItems,
  departments,
  workItemDependencies,
}: {
  adminUserId: string;
  workItems: AdminWorkItem[];
  departments: Department[];
  workItemDependencies: WorkItemDependency[];
}) {
  const { submit, submitting, error } = useSubmit("/api/admin/work-items");
  const [departmentId, setDepartmentId] = useState(departments[0]?.departmentId ?? "");
  const [lineItemNo, setLineItemNo] = useState("");
  const [csiLineCode, setCsiLineCode] = useState("");
  const [descriptionOfWork, setDescriptionOfWork] = useState("");
  const [scheduledValue, setScheduledValue] = useState("");
  const [unitOfMeasure, setUnitOfMeasure] = useState("");
  const [plannedQuantity, setPlannedQuantity] = useState("");
  const [retainagePercent, setRetainagePercent] = useState("");
  const [dependsOnWorkItemIds, setDependsOnWorkItemIds] = useState<string[]>([]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submit({
      actorUserId: adminUserId,
      departmentId,
      lineItemNo,
      csiLineCode,
      descriptionOfWork,
      scheduledValue,
      unitOfMeasure,
      plannedQuantity,
      retainagePercent,
      dependsOnWorkItemIds,
    });
    if (ok) {
      setLineItemNo("");
      setCsiLineCode("");
      setDescriptionOfWork("");
      setScheduledValue("");
      setUnitOfMeasure("");
      setPlannedQuantity("");
      setRetainagePercent("");
      setDependsOnWorkItemIds([]);
    }
  }

  if (departments.length === 0) {
    return <EmptyPrereq message="Create a Department first." />;
  }

  const sameDepartmentItems = workItems.filter((w) => w.departmentId === departmentId);

  return (
    <div className="space-y-4">
      <datalist id={UOM_DATALIST_ID}>
        {UOM_SUGGESTIONS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>

      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-line p-4 space-y-3">
        <h2 className="font-semibold text-foreground text-sm">New Work Item</h2>
        <SelectField
          label="Department"
          value={departmentId}
          onChange={(v) => {
            setDepartmentId(v);
            setDependsOnWorkItemIds([]);
          }}
          options={departments.map((d) => ({
            value: d.departmentId,
            label: `${d.projectName} / ${d.departmentName}`,
          }))}
        />
        <Field label="Line Item No" value={lineItemNo} onChange={setLineItemNo} required />
        <Field label="CSI Line Code" value={csiLineCode} onChange={setCsiLineCode} />
        <Field
          label="Description of Work"
          value={descriptionOfWork}
          onChange={setDescriptionOfWork}
          required
        />
        <QuantityUomFields
          plannedQuantity={plannedQuantity}
          onPlannedQuantityChange={setPlannedQuantity}
          unitOfMeasure={unitOfMeasure}
          onUnitOfMeasureChange={setUnitOfMeasure}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Scheduled Value"
            value={scheduledValue}
            onChange={setScheduledValue}
            type="number"
          />
          <Field
            label="Retained Percentage"
            value={retainagePercent}
            onChange={setRetainagePercent}
            type="number"
          />
        </div>
        <DependsOnField
          options={sameDepartmentItems}
          value={dependsOnWorkItemIds}
          onChange={setDependsOnWorkItemIds}
        />
        <SubmitButton submitting={submitting} label="Create Work Item" />
        {error && (
            <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}
      </form>

      <ListSection title="Existing Work Items" empty={workItems.length === 0}>
        {workItems.map((w) => (
          <WorkItemRow
            key={w.workItemId}
            adminUserId={adminUserId}
            item={w}
            allWorkItems={workItems}
            dependencies={workItemDependencies}
          />
        ))}
      </ListSection>
    </div>
  );
}

function WorkItemRow({
  adminUserId,
  item,
  allWorkItems,
  dependencies,
}: {
  adminUserId: string;
  item: AdminWorkItem;
  allWorkItems: AdminWorkItem[];
  dependencies: WorkItemDependency[];
}) {
  const { submit, submitting, error } = useSubmit("/api/admin/work-items", "PATCH");
  const [editing, setEditing] = useState(false);
  const [scheduledValue, setScheduledValue] = useState(item.scheduledValue?.toString() ?? "");
  const [unitOfMeasure, setUnitOfMeasure] = useState(item.unitOfMeasure ?? "");
  const [plannedQuantity, setPlannedQuantity] = useState(item.plannedQuantity?.toString() ?? "");
  const [retainagePercent, setRetainagePercent] = useState(
    item.retainagePercent?.toString() ?? ""
  );
  const existingDependsOn = dependencies
    .filter((d) => d.workItemId === item.workItemId)
    .map((d) => d.dependsOnWorkItemId);
  const [dependsOnWorkItemIds, setDependsOnWorkItemIds] = useState<string[]>(existingDependsOn);

  const sameDepartmentItems = allWorkItems.filter(
    (w) => w.departmentId === item.departmentId && w.workItemId !== item.workItemId
  );
  const dependsOnLabel = existingDependsOn
    .map((id) => allWorkItems.find((w) => w.workItemId === id))
    .filter((w): w is AdminWorkItem => !!w)
    .map((w) => w.lineItemNo)
    .join(", ");

  async function handleSave() {
    const ok = await submit({
      actorUserId: adminUserId,
      workItemId: item.workItemId,
      scheduledValue,
      unitOfMeasure,
      plannedQuantity,
      retainagePercent,
      dependsOnWorkItemIds,
    });
    if (ok) setEditing(false);
  }

  return (
    <div className="px-4 py-3 border-b border-line last:border-0 text-sm transition-colors duration-150 hover:bg-surface-hover">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{item.lineItemNo}</span>
          {item.csiLineCode && (
            <span className="text-xs text-foreground-muted border border-line rounded px-1.5 py-0.5">
              CSI {item.csiLineCode}
            </span>
          )}
          <span className="text-foreground-secondary">{item.descriptionOfWork}</span>
          <span className="text-foreground-muted">({item.departmentName})</span>
          <StatusBadge status={item.status} />
        </div>
        {!editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)} className="shrink-0">
            Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className="mt-2 space-y-2 bg-surface-soft rounded-lg p-3">
          <QuantityUomFields
            plannedQuantity={plannedQuantity}
            onPlannedQuantityChange={setPlannedQuantity}
            unitOfMeasure={unitOfMeasure}
            onUnitOfMeasureChange={setUnitOfMeasure}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Scheduled Value"
              value={scheduledValue}
              onChange={setScheduledValue}
              type="number"
            />
            <Field
              label="Retained Percentage"
              value={retainagePercent}
              onChange={setRetainagePercent}
              type="number"
            />
          </div>
          <DependsOnField
            options={sameDepartmentItems}
            value={dependsOnWorkItemIds}
            onChange={setDependsOnWorkItemIds}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {error && (
            <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}
        </div>
      ) : (
        <p className="text-foreground-secondary mt-1 tabular-nums">
          Scheduled Value:{" "}
          {item.scheduledValue !== null
            ? `$${item.scheduledValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : "Not set"}{" "}
          · Planned Quantity:{" "}
          {item.plannedQuantity !== null ? formatQuantity(item.plannedQuantity) : "Not set"}{" "}
          {item.unitOfMeasure ?? ""} · Retained %:{" "}
          {item.retainagePercent !== null ? formatPercent(item.retainagePercent) : "Not set"}
          {dependsOnLabel && <> · Depends on: {dependsOnLabel}</>}
        </p>
      )}
    </div>
  );
}

/**
 * Creates a user account and assigns it a Worker/Foreman/Supervisor/Admin
 * role scoped to one project + department (see createUserWithRole in
 * lib/admin.ts) — the only way, besides the one-off Admin bootstrap flow,
 * to get a user into a department so its dashboards become usable. Most
 * departments start with none; this is how an admin fills that gap
 * without fabricating accounts outside this UI.
 */
function UsersTab({
  adminUserId,
  isRealAdmin,
  users,
  departments,
  projects,
}: {
  adminUserId: string;
  isRealAdmin: boolean;
  users: UserAccount[];
  departments: Department[];
  projects: Project[];
}) {
  const { submit, submitting, error } = useSubmit("/api/admin/users");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [departmentId, setDepartmentId] = useState(departments[0]?.departmentId ?? "");
  const roleOptions = isRealAdmin ? ROLE_OPTIONS : DELEGATED_ROLE_OPTIONS;
  const [role, setRole] = useState(roleOptions[0]);

  const department = departments.find((d) => d.departmentId === departmentId);
  const projectId = department?.projectId ?? projects[0]?.projectId ?? "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submit({
      actorUserId: adminUserId,
      email,
      firstName,
      lastName,
      departmentId,
      projectId,
      role,
    });
    if (ok) {
      setEmail("");
      setFirstName("");
      setLastName("");
    }
  }

  if (departments.length === 0) {
    return (
      <EmptyPrereq
        message={isRealAdmin ? "Create a Department first." : "No department in scope to add a User to yet."}
      />
    );
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-line p-4 space-y-3">
        <h2 className="font-semibold text-foreground text-sm">New User</h2>
        {!isRealAdmin && (
          <p className="text-xs text-warning bg-warning-soft border border-warning-border rounded-lg p-2.5">
            Operational users only (Worker / Subcontractor / Contractor) — creating or promoting
            an Admin account is always Admin-only.
          </p>
        )}
        <Field label="Email" value={email} onChange={setEmail} required type="email" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="First Name" value={firstName} onChange={setFirstName} />
          <Field label="Last Name" value={lastName} onChange={setLastName} />
        </div>
        <SelectField
          label="Department"
          value={departmentId}
          onChange={setDepartmentId}
          options={departments.map((d) => ({
            value: d.departmentId,
            label: `${d.projectName} / ${d.departmentName}`,
          }))}
        />
        <SelectField
          label="Role"
          value={role}
          onChange={setRole}
          options={roleOptions.map((r) => ({ value: r, label: ROLE_OPTION_LABEL[r] ?? r }))}
        />
        <SubmitButton submitting={submitting} label="Create User" />
        {error && (
            <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}
      </form>

      <ListSection title={isRealAdmin ? "Existing Users" : "Users in Delegated Scope"} empty={users.length === 0}>
        {users.map((u) => (
          <div
            key={u.userId}
            className="px-4 py-3 border-b border-line last:border-0 text-sm transition-colors duration-150 hover:bg-surface-hover"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {u.firstName || u.lastName ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : u.email}
                </span>
                <span className="text-foreground-secondary">({u.email})</span>
                <span className="text-foreground-muted">{u.role}</span>
                <StatusBadge status={u.status} />
                <Badge variant={u.isLinked ? "success" : "neutral"}>
                  {u.isLinked ? "Can log in" : "No login yet"}
                </Badge>
              </div>
              {/* Linking is the same "no delegation can touch an Admin"
               * boundary as removing an assignment above — hidden here
               * to match the server-side guard in
               * app/api/admin/link-auth/route.ts. */}
              {!u.isLinked && (isRealAdmin || u.role !== "ADMIN") && (
                <LinkLoginButton adminUserId={adminUserId} targetUserId={u.userId} email={u.email} />
              )}
            </div>
            {u.projectRoles.length === 0 ? (
              <p className="text-foreground-muted mt-1">No active project/department role assignment yet.</p>
            ) : (
              <div className="mt-1 space-y-1">
                {u.projectRoles.map((r) => (
                  <div key={r.userProjectRoleId} className="flex items-center justify-between gap-2">
                    <p className="text-foreground-secondary">
                      {r.role} — {r.projectName} / {r.departmentName}
                    </p>
                    {/* A delegate can never remove an ADMIN's assignment
                     * — hidden here to match the server-side guard in
                     * app/api/admin/users/route.ts DELETE, not a
                     * substitute for it. */}
                    {(isRealAdmin || r.role !== "ADMIN") && (
                      <RemoveAssignmentButton
                        adminUserId={adminUserId}
                        userProjectRoleId={r.userProjectRoleId}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </ListSection>
    </div>
  );
}

/** Removes one project/department/role assignment (see
 * deactivateUserProjectRole in lib/admin.ts) — leaves the user account
 * and every other assignment it holds untouched. Confirms first since
 * this affects which dashboard the user can access. */
function RemoveAssignmentButton({
  adminUserId,
  userProjectRoleId,
}: {
  adminUserId: string;
  userProjectRoleId: string;
}) {
  const { submit, submitting, error } = useSubmit("/api/admin/users", "DELETE");

  async function handleRemove() {
    if (!window.confirm("Remove this project/department/role assignment?")) return;
    await submit({ actorUserId: adminUserId, userProjectRoleId });
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      <Button variant="danger" size="sm" onClick={handleRemove} disabled={submitting}>
        {submitting ? "Removing…" : "Remove"}
      </Button>
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  );
}

function generateTempPassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

/**
 * Creates a brand-new Supabase Auth login for one existing user and
 * links it (see lib/admin.ts linkUserToAuthAccount — never matches an
 * existing Auth account by email alone). The temporary password is
 * shown exactly once after success, in-memory only (component state,
 * never sent anywhere but the one POST that creates it, never logged)
 * — the Admin is expected to relay it to that person and have them
 * change it at first login via /reset-password.
 */
function LinkLoginButton({
  adminUserId,
  targetUserId,
  email,
}: {
  adminUserId: string;
  targetUserId: string;
  email: string;
}) {
  const { submit, submitting, error } = useSubmit("/api/admin/link-auth");
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await submit({ actorUserId: adminUserId, targetUserId, password });
    if (ok) {
      setCreatedPassword(password);
      setOpen(false);
      setPassword("");
    }
  }

  if (createdPassword) {
    return (
      <div className="text-xs bg-success-soft border border-success-border rounded-lg p-2 max-w-xs">
        <p className="text-success font-medium">Login created for {email}.</p>
        <p className="text-foreground-secondary mt-1">
          Temporary password (shown once — share it securely):{" "}
          <span className="font-mono select-all">{createdPassword}</span>
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setPassword(generateTempPassword());
          setOpen(true);
        }}
        className="shrink-0"
      >
        Link Login
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-1.5 shrink-0">
      <Input
        type="text"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        minLength={8}
        required
        className="w-32 py-1.5 text-xs font-mono"
      />
      <Button type="submit" size="sm" disabled={submitting}>
        {submitting ? "Creating…" : "Create"}
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={submitting}>
        Cancel
      </Button>
      {error && <span className="text-xs text-error">{error}</span>}
    </form>
  );
}

/** Multi-select of other work items in the same department a work item
 * depends on (see work_item_dependencies) — zero selected means no
 * prerequisites / fully parallel, the default for every existing item. */
function DependsOnField({
  options,
  value,
  onChange,
}: {
  options: AdminWorkItem[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground-secondary mb-1">
        Depends On (optional — leave empty for parallel/no prerequisite)
      </label>
      <select
        multiple
        value={value}
        onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}
        className="w-full rounded border border-line px-3 py-2 text-sm h-24"
      >
        {options.map((w) => (
          <option key={w.workItemId} value={w.workItemId}>
            {w.lineItemNo} — {w.descriptionOfWork}
          </option>
        ))}
      </select>
      {options.length === 0 && (
        <p className="text-xs text-foreground-muted mt-1">
          No other work items in this department yet.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Small shared presentational helpers
// ------------------------------------------------------------------

function Field({
  label,
  value,
  onChange,
  required,
  type = "text",
  list,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  list?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground-secondary mb-1">{label}</label>
      <Input type={type} required={required} value={value} onChange={(e) => onChange(e.target.value)} list={list} />
    </div>
  );
}

/**
 * Planned Quantity and Unit of Measure rendered side-by-side under one
 * shared caption, in every work item form (create + edit) — the two
 * remain separate fields/columns in the database and in this component's
 * props (never combined into one string like "100 m²"), but they always
 * describe a single physical measurement, so the UI keeps them visually
 * adjacent rather than pairing them with unrelated fields (Scheduled
 * Value, Retained Percentage) the way earlier layouts did. UOM stays
 * free text (+ datalist suggestions) so any project-specific unit is
 * accepted for any department/work item — never hardcoded to m² or any
 * other single unit.
 */
function QuantityUomFields({
  plannedQuantity,
  onPlannedQuantityChange,
  unitOfMeasure,
  onUnitOfMeasureChange,
}: {
  plannedQuantity: string;
  onPlannedQuantityChange: (v: string) => void;
  unitOfMeasure: string;
  onUnitOfMeasureChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground-secondary mb-1">
        Planned Quantity &amp; Unit of Measure
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Input
          type="number"
          step="any"
          value={plannedQuantity}
          onChange={(e) => onPlannedQuantityChange(e.target.value)}
          placeholder="e.g. 100.00"
          aria-label="Planned Quantity"
          className="tabular-nums"
        />
        <Input
          type="text"
          value={unitOfMeasure}
          onChange={(e) => onUnitOfMeasureChange(e.target.value)}
          list={UOM_DATALIST_ID}
          placeholder="e.g. m², LF, Nos, EA"
          aria-label="Unit of Measure"
        />
      </div>
      <p className="text-xs text-foreground-muted mt-1">
        Stored as two separate fields; enter both together for one measurement (e.g. 250 + LF).
      </p>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground-secondary mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm text-foreground transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SubmitButton({ submitting, label }: { submitting: boolean; label: string }) {
  return (
    <Button type="submit" disabled={submitting}>
      {submitting ? "Saving…" : label}
    </Button>
  );
}

function ListSection({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-0 overflow-hidden">
      <h2 className="font-semibold text-foreground text-sm px-4 py-3 border-b border-line">{title}</h2>
      {empty ? (
        <EmptyState icon={Inbox} title="None yet" />
      ) : (
        <div className="divide-y divide-line">{children}</div>
      )}
    </Card>
  );
}

/** One list row — Stripe-inspired: generous height (44-48px), no zebra
 * striping (whitespace/border does the separating), a subtle hover
 * highlight. */
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[46px] items-center gap-2 px-4 py-2.5 text-sm transition-colors duration-150 hover:bg-surface-hover">
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant: BadgeVariant = status === "Active" ? "success" : status === "Removed" ? "error" : "neutral";
  return <Badge variant={variant}>{status}</Badge>;
}

function EmptyPrereq({ message }: { message: string }) {
  return (
    <p className="text-sm text-foreground-secondary bg-white rounded-lg border border-line p-4">
      {message}
    </p>
  );
}
