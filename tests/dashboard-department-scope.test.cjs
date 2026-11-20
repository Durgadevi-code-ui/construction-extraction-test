/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs. */
// Contractor Dashboard department scope (lib/dashboard.ts getDashboardData),
// client requirement 2026-11-20: a Contractor sees, searches and selects
// EVERY department of a project where they hold their own Contractor role
// (several at once), never another project's departments; a project
// reached only through delegation keeps exactly its delegated
// departments; a Subcontractor (FOREMAN) and a Worker are unchanged; an
// out-of-scope department id never widens access; rows are never
// duplicated; totalDepartments follows the filter. Real lib/dashboard.ts;
// only its data/auth modules are stubbed (no network, no database).
// Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
function stubModule(rel, exports) {
  const file = require.resolve(path.join(ROOT, rel));
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}

// p1 "Tower": four departments; the caller's own role is in Electrical.
// p2 "Depot": the caller has nothing there at all.
// p3 "Annex": reached only through a delegation limited to Annex-A.
const PROJECTS = [
  { projectId: "p1", projectName: "Tower" },
  { projectId: "p2", projectName: "Depot" },
  { projectId: "p3", projectName: "Annex" },
];
const DEPARTMENTS = [
  { departmentId: "d-elec", departmentName: "Electrical", projectId: "p1" },
  { departmentId: "d-plumb", departmentName: "Plumbing", projectId: "p1" },
  { departmentId: "d-conc", departmentName: "Concrete", projectId: "p1" },
  { departmentId: "d-hvac", departmentName: "HVAC", projectId: "p1" },
  { departmentId: "d-depot", departmentName: "Depot Civil", projectId: "p2" },
  { departmentId: "d-annex-a", departmentName: "Annex A", projectId: "p3" },
  { departmentId: "d-annex-b", departmentName: "Annex B", projectId: "p3" },
];
const workItem = (id, departmentId) => ({
  workItemId: id,
  departmentId,
  status: "Active",
  lineItemNo: id,
  descriptionOfWork: `Item ${id}`,
  plannedQuantity: null,
  unitOfMeasure: null,
  scheduledValue: null,
  additionalFields: null,
});
const WORK_ITEMS = [
  workItem("E1", "d-elec"),
  workItem("E2", "d-elec"),
  workItem("P1", "d-plumb"),
  workItem("C1", "d-conc"),
  workItem("H1", "d-hvac"),
  workItem("D1", "d-depot"),
  workItem("AA1", "d-annex-a"),
  workItem("AB1", "d-annex-b"),
];

// Per-test caller: role rows + active delegations.
let roleRows = [];
let delegations = [];
const row = (role, projectId, departmentId) => ({ role, projectId, projectName: projectId, departmentId, departmentName: departmentId });

stubModule("lib/authContext.ts", {
  CONTRACTOR_ROLES: ["SUPERVISOR", "MANAGER"],
  isAdminUser: async () => false,
  getUserContext: async () => ({
    role: roleRows[0].role,
    projectId: roleRows[0].projectId,
    departmentId: roleRows[0].departmentId,
    availableProjects: roleRows,
  }),
});
stubModule("lib/delegation.ts", {
  getActiveDelegationsForUser: async () => delegations,
});
stubModule("lib/admin.ts", {
  listProjects: async () => PROJECTS,
  listDepartments: async () => DEPARTMENTS,
  listWorkItems: async () => WORK_ITEMS,
});
stubModule("lib/workflow.ts", {
  getWorkItemCurrentStatus: async () => ({ approvedQuantity: null, progressPercentage: 10, isCompleted: false }),
  parseWorkItemTasks: () => [],
});

const { getDashboardData } = require(path.join(ROOT, "lib/dashboard.ts"));
const supabase = {
  from: () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => Promise.resolve({ data: [], error: null }),
    };
    return builder;
  },
};

const ids = (data) => data.workItems.map((w) => w.workItemId).sort();
const deptIds = (list) => list.map((d) => d.departmentId).sort();
const asContractor = () => {
  roleRows = [row("SUPERVISOR", "p1", "d-elec")];
  delegations = [];
};
const get = (filters) => getDashboardData(supabase, "u-caller", { status: "ALL", ...filters });

test("Contractor, All Departments: every department of their own Contractor project — none from other projects", async () => {
  asContractor();
  const data = await get({ projectId: "p1", departmentId: null });
  assert.deepEqual(ids(data), ["C1", "E1", "E2", "H1", "P1"]);
  assert.equal(new Set(ids(data)).size, data.workItems.length, "no duplicate rows");
  assert.deepEqual(deptIds(data.scopeDepartments), ["d-conc", "d-elec", "d-hvac", "d-plumb"]);
  assert.deepEqual(data.scopeProjects.map((p) => p.projectId), ["p1"], "project access unchanged");
  assert.equal(data.kpis.totalDepartments, 4);
});

test("Contractor: a previously restricted department can be selected on its own", async () => {
  asContractor();
  const conc = await get({ projectId: "p1", departmentId: "d-conc" });
  assert.deepEqual(ids(conc), ["C1"]);
  assert.deepEqual(deptIds(conc.departments), ["d-conc"]);
  assert.equal(conc.kpis.totalDepartments, 1);
});

test("Contractor: several departments at once; a repeated id never duplicates rows", async () => {
  asContractor();
  const two = await get({ projectId: "p1", departmentIds: ["d-conc", "d-hvac"] });
  assert.deepEqual(ids(two), ["C1", "H1"]);
  assert.deepEqual(deptIds(two.departments), ["d-conc", "d-hvac"]);
  assert.equal(two.kpis.totalDepartments, 2);

  const dup = await get({ projectId: "p1", departmentIds: ["d-conc", "d-conc", "d-elec"] });
  assert.deepEqual(ids(dup), ["C1", "E1", "E2"]);
  assert.equal(dup.kpis.totalDepartments, 2);
});

test("Contractor: another project's department id never widens access", async () => {
  asContractor();
  const only = await get({ projectId: "p1", departmentId: "d-depot" });
  assert.ok(!only.workItems.some((w) => w.workItemId === "D1"));
  assert.deepEqual(ids(only), ["C1", "E1", "E2", "H1", "P1"], "ignored, same as All");

  const mixed = await get({ projectId: "p1", departmentIds: ["d-conc", "d-depot"] });
  assert.deepEqual(ids(mixed), ["C1"], "out-of-scope id dropped, the rest kept");

  const noProject = await get({ departmentIds: ["d-depot"] });
  assert.ok(!noProject.scopeDepartments.some((d) => d.projectId === "p2"));
  assert.ok(!noProject.workItems.some((w) => w.workItemId === "D1"));
});

test("Contractor: a delegation-only project keeps exactly its delegated departments", async () => {
  roleRows = [row("SUPERVISOR", "p1", "d-elec")];
  delegations = [{ projects: [{ projectId: "p3" }], departments: [{ projectId: "p3", departmentId: "d-annex-a" }] }];
  const data = await get({});
  const p3 = data.scopeDepartments.filter((d) => d.projectId === "p3").map((d) => d.departmentId);
  assert.deepEqual(p3, ["d-annex-a"]);
  assert.ok(!data.workItems.some((w) => w.workItemId === "AB1"));
  const asked = await get({ departmentIds: ["d-annex-b"] });
  assert.ok(!asked.workItems.some((w) => w.workItemId === "AB1"), "delegated scope not widened");
});

test("Subcontractor (FOREMAN): unchanged — own department only", async () => {
  roleRows = [row("FOREMAN", "p1", "d-elec")];
  delegations = [];
  const data = await get({ projectId: "p1" });
  assert.deepEqual(deptIds(data.scopeDepartments), ["d-elec"]);
  assert.deepEqual(ids(data), ["E1", "E2"]);
  const asked = await get({ projectId: "p1", departmentIds: ["d-conc", "d-hvac"] });
  assert.deepEqual(ids(asked), ["E1", "E2"], "other departments ignored for a Subcontractor");
});

test("Worker: still not authorized for the aggregate dashboard", async () => {
  roleRows = [row("WORKER", "p1", "d-elec")];
  delegations = [];
  await assert.rejects(() => get({ projectId: "p1" }), /not authorized/);
});
