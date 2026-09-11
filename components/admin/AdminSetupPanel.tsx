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

type Props = {
  adminUserId: string;
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

type Tab = "companies" | "projects" | "departments" | "workItems" | "users" | "delegations";

const ALL_TABS: { id: Tab; label: string; adminOnly?: boolean; permission?: DelegationPermission }[] = [
  { id: "companies", label: "Companies", adminOnly: true },
  { id: "projects", label: "Projects", permission: "PROJECT_MANAGEMENT" },
  { id: "departments", label: "Departments", permission: "DEPARTMENT_MANAGEMENT" },
  { id: "workItems", label: "Work Items", permission: "WORK_ITEM_MANAGEMENT" },
  { id: "users", label: "Users", permission: "USER_MANAGEMENT" },
  { id: "delegations", label: "Delegations", adminOnly: true },
];

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

  const activeTab = shownTabs.includes(tab) ? tab : shownTabs[0];

  return (
    <div className="space-y-6">
      <div className="flex gap-2 flex-wrap">
        {ALL_TABS.filter((t) => shownTabs.includes(t.id)).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-sm px-3 py-1.5 rounded ${
              activeTab === t.id
                ? "bg-brand text-white"
                : "bg-white border border-line text-foreground-secondary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "companies" && <CompaniesTab adminUserId={adminUserId} companies={companies} />}
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
        {error && <p className="text-sm text-red-600">{error}</p>}
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
        <p className="text-xs text-foreground-secondary bg-amber-50 border border-amber-200 rounded p-2.5">
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
        {error && <p className="text-sm text-red-600">{error}</p>}
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

  return (
    <div className="py-2 border-b border-line last:border-0 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-medium">{project.projectName}</span>
          <span className="text-foreground-secondary ml-2">
            ({project.projectCode}) — {project.companyName}
          </span>
          <StatusBadge status={project.status} />
        </div>
        <div className="flex gap-2 shrink-0">
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-xs px-2 py-1 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      <ExcelImportPanel projectId={project.projectId} />

      {editing && (
        <div className="mt-2 space-y-2 bg-surface-soft rounded p-3">
          <Field label="Project Name" value={projectName} onChange={setProjectName} required />
          <Field label="Location" value={projectLocation} onChange={setProjectLocation} />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={submitting}
              className="text-xs px-3 py-1.5 rounded bg-brand text-white disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
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
          <p className="text-xs text-foreground-secondary bg-amber-50 border border-amber-200 rounded p-2.5">
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
        {error && <p className="text-sm text-red-600">{error}</p>}
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
    <div className="py-2 border-b border-line last:border-0 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-medium">{department.departmentName}</span>
          <span className="text-foreground-secondary ml-2">
            ({department.departmentCode}) — {department.projectName}
          </span>
          <StatusBadge status={department.status} />
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-xs px-2 py-1 rounded border border-line text-foreground-secondary hover:bg-surface-soft shrink-0"
          >
            Edit
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-2 space-y-2 bg-surface-soft rounded p-3">
          <Field label="Department Name" value={departmentName} onChange={setDepartmentName} required />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={submitting}
              className="text-xs px-3 py-1.5 rounded bg-brand text-white disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
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
        {error && <p className="text-sm text-red-600">{error}</p>}
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
    <div className="py-2 border-b border-line last:border-0 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-medium">{item.lineItemNo}</span>
          <span className="text-foreground-secondary ml-2">{item.descriptionOfWork}</span>
          <span className="text-foreground-muted ml-2">({item.departmentName})</span>
          <StatusBadge status={item.status} />
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-xs px-2 py-1 rounded border border-line text-foreground-secondary hover:bg-surface-soft shrink-0"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-2 space-y-2 bg-surface-soft rounded p-3">
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
            <button
              onClick={handleSave}
              disabled={submitting}
              className="text-xs px-3 py-1.5 rounded bg-brand text-white disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="text-xs px-3 py-1.5 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
            >
              Cancel
            </button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      ) : (
        <p className="text-foreground-secondary mt-1">
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
          <p className="text-xs text-foreground-secondary bg-amber-50 border border-amber-200 rounded p-2.5">
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
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>

      <ListSection title={isRealAdmin ? "Existing Users" : "Users in Delegated Scope"} empty={users.length === 0}>
        {users.map((u) => (
          <div key={u.userId} className="py-2 border-b border-line last:border-0 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="font-medium">
                  {u.firstName || u.lastName ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : u.email}
                </span>
                <span className="text-foreground-secondary ml-2">({u.email})</span>
                <span className="text-foreground-muted ml-2">{u.role}</span>
                <StatusBadge status={u.status} />
                <span
                  className={`ml-2 text-xs px-2 py-0.5 rounded-full ${
                    u.isLinked ? "bg-green-100 text-green-700" : "bg-gray-100 text-foreground-secondary"
                  }`}
                >
                  {u.isLinked ? "Can log in" : "No login yet"}
                </span>
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
      <button
        onClick={handleRemove}
        disabled={submitting}
        className="text-xs px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {submitting ? "Removing…" : "Remove"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
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
      <div className="text-xs bg-green-50 border border-green-200 rounded p-2 max-w-xs">
        <p className="text-green-800 font-medium">Login created for {email}.</p>
        <p className="text-foreground-secondary mt-1">
          Temporary password (shown once — share it securely):{" "}
          <span className="font-mono select-all">{createdPassword}</span>
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setPassword(generateTempPassword());
          setOpen(true);
        }}
        className="text-xs px-2 py-1 rounded border border-line text-foreground-secondary hover:bg-surface-soft shrink-0"
      >
        Link Login
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-1.5 shrink-0">
      <input
        type="text"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        minLength={8}
        required
        className="w-32 rounded border border-line px-1.5 py-1 text-xs font-mono"
      />
      <button
        type="submit"
        disabled={submitting}
        className="text-xs px-2 py-1 rounded bg-brand text-white disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        disabled={submitting}
        className="text-xs px-2 py-1 rounded border border-line text-foreground-secondary hover:bg-surface-soft"
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
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
      <input
        type={type}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={list}
        className="w-full rounded border border-line px-3 py-2 text-sm"
      />
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
        <input
          type="number"
          step="any"
          value={plannedQuantity}
          onChange={(e) => onPlannedQuantityChange(e.target.value)}
          placeholder="e.g. 100.00"
          aria-label="Planned Quantity"
          className="w-full rounded border border-line px-3 py-2 text-sm"
        />
        <input
          type="text"
          value={unitOfMeasure}
          onChange={(e) => onUnitOfMeasureChange(e.target.value)}
          list={UOM_DATALIST_ID}
          placeholder="e.g. m², LF, Nos, EA"
          aria-label="Unit of Measure"
          className="w-full rounded border border-line px-3 py-2 text-sm"
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
        className="w-full rounded border border-line px-3 py-2 text-sm"
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
    <button
      type="submit"
      disabled={submitting}
      className="rounded bg-brand text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
    >
      {submitting ? "Saving…" : label}
    </button>
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
    <section className="bg-white rounded-lg border border-line p-4">
      <h2 className="font-semibold text-foreground text-sm mb-2">{title}</h2>
      {empty ? <p className="text-sm text-foreground-muted">None yet.</p> : <div>{children}</div>}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="py-1.5 border-b border-line last:border-0 text-sm">{children}</div>;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-foreground-secondary">
      {status}
    </span>
  );
}

function EmptyPrereq({ message }: { message: string }) {
  return (
    <p className="text-sm text-foreground-secondary bg-white rounded-lg border border-line p-4">
      {message}
    </p>
  );
}
