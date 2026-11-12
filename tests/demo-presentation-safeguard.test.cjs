/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs. */
// Snapshot / reseed safeguard for the isolated presentation project
// (lib/demoSnapshot.ts). Runs the real module against an in-memory table
// store (no network, no production database): every read/write is applied
// and read back. Proves the isolation guard (never touches real
// projects/users), the dry-run (no writes), and recovery (round-trip).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertIsolatedDemoProject,
  snapshotPresentationProject,
  planRestore,
  applyRestore,
  NotIsolatedDemoProjectError,
} = require("../lib/demoSnapshot.ts");

const PRES = "pres-0001";
const REAL = "real-0001";
const D1 = "dep-1";
const D2 = "dep-2";

/** Minimal PostgREST-style in-memory client: select (embeds pre-attached),
 * eq/in filters, upsert (replace by onConflict key), delete, awaitable. */
function memoryDb(tables) {
  const writes = [];
  function from(table) {
    const rows = () => (tables[table] ??= []);
    const filters = [];
    let op = "select";
    let payload;
    let conflictKeys = [];
    const matches = (r) => filters.every((f) => f(r));
    const run = () => {
      // A real client returns serialized copies, never references to your
      // live store (the snapshot is written to a JSON file and read back).
      if (op === "select") return { data: rows().filter(matches).map((r) => ({ ...r })), error: null };
      writes.push({ table, op });
      if (op === "upsert") {
        for (const row of [].concat(payload)) {
          const i = rows().findIndex((r) => conflictKeys.every((k) => r[k] === row[k]));
          if (i === -1) rows().push({ ...row });
          else rows()[i] = { ...rows()[i], ...row };
        }
      }
      if (op === "delete") tables[table] = rows().filter((r) => !matches(r));
      return { data: null, error: null };
    };
    const builder = {
      select() { return builder; },
      upsert(p, opts) { op = "upsert"; payload = p; conflictKeys = String(opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean); return builder; },
      delete() { op = "delete"; return builder; },
      eq(c, v) { filters.push((r) => r[c] === v); return builder; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return builder; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };
    return builder;
  }
  return { tables, writes, from };
}

const demo = (mail) => ({ user_mail: mail });
function fixture() {
  return memoryDb({
    user_project_roles: [
      { project_id: PRES, status: "Active", users: demo("demo.admin@example.com") },
      { project_id: PRES, status: "Active", users: demo("demo.worker.electrical@example.com") },
      { project_id: REAL, status: "Active", users: demo("real.person@abc.test") },
    ],
    departments: [
      { department_id: D1, project_id: PRES, department_code: "ELEC", department_name: "Electrical Department", status: "Active" },
      { department_id: D2, project_id: PRES, department_code: "PLUMB", department_name: "Plumbing Department", status: "Active" },
      { department_id: "dep-real", project_id: REAL, department_code: "X", department_name: "Real Dept", status: "Active" },
    ],
    work_items: [
      { work_item_id: "wi-1", project_id: PRES, department_id: D1, line_item_no: "1", csi_line_code: null, description_of_work: "Conduit", scheduled_value: 100, unit_of_measure: "m", planned_quantity: 10, retainage_percent: 5, status: "Active" },
      { work_item_id: "wi-2", project_id: PRES, department_id: D2, line_item_no: "2", csi_line_code: null, description_of_work: "Pipe", scheduled_value: 200, unit_of_measure: "m", planned_quantity: 20, retainage_percent: 5, status: "Active" },
      { work_item_id: "wi-real", project_id: REAL, department_id: "dep-real", line_item_no: "9", csi_line_code: null, description_of_work: "Real work", scheduled_value: 999, unit_of_measure: "m", planned_quantity: 1, retainage_percent: 0, status: "Active" },
    ],
    work_item_dependencies: [{ work_item_id: "wi-2", depends_on_work_item_id: "wi-1" }],
  });
}
const allowed = new Set([PRES]);

test("isolation guard: a non-demo project id is refused", async () => {
  const db = fixture();
  await assert.rejects(() => assertIsolatedDemoProject(db, REAL, allowed), NotIsolatedDemoProjectError);
  await assert.rejects(() => assertIsolatedDemoProject(db, "nope", allowed), NotIsolatedDemoProjectError);
});

test("isolation guard: a demo project with a real member is refused", async () => {
  const db = fixture();
  db.tables.user_project_roles.push({ project_id: PRES, status: "Active", users: demo("intruder@abc.test") });
  await assert.rejects(() => assertIsolatedDemoProject(db, PRES, allowed), NotIsolatedDemoProjectError);
});

test("isolation guard: a fully @example.com demo project passes", async () => {
  const db = fixture();
  await assert.doesNotReject(() => assertIsolatedDemoProject(db, PRES, allowed));
});

test("snapshot: captures only the presentation project's departments/work items/deps; never real data; no writes", async () => {
  const db = fixture();
  const snap = await snapshotPresentationProject(db, PRES, allowed);
  assert.equal(snap.projectId, PRES);
  assert.deepEqual(snap.departments.map((d) => d.department_id).sort(), [D1, D2]);
  assert.deepEqual(snap.workItems.map((w) => w.work_item_id).sort(), ["wi-1", "wi-2"]);
  assert.deepEqual(snap.dependencies, [{ work_item_id: "wi-2", depends_on_work_item_id: "wi-1" }]);
  assert.ok(!JSON.stringify(snap).includes("real"), "no real project rows captured");
  assert.equal(db.writes.length, 0, "snapshot is read-only");
  // Snapshotting the real project is refused.
  await assert.rejects(() => snapshotPresentationProject(db, REAL, allowed), NotIsolatedDemoProjectError);
});

test("restore dry run: computes the plan and writes nothing", async () => {
  const db = fixture();
  const snap = await snapshotPresentationProject(db, PRES, allowed);
  // Demo drift: an extra department + work item added "by a visitor".
  db.tables.departments.push({ department_id: "dep-x", project_id: PRES, department_code: "X", department_name: "Junk", status: "Active" });
  db.tables.work_items.push({ work_item_id: "wi-x", project_id: PRES, department_id: "dep-x", line_item_no: "99", description_of_work: "Junk", scheduled_value: 0, unit_of_measure: "m", planned_quantity: 0, retainage_percent: 0, status: "Active" });
  const writesBefore = db.writes.length;
  const plan = await planRestore(db, snap, allowed);
  assert.equal(plan.departmentsToRestore, 2);
  assert.equal(plan.workItemsToRestore, 2);
  assert.deepEqual(plan.departmentDriftIds, ["dep-x"]);
  assert.deepEqual(plan.workItemDriftIds, ["wi-x"]);
  assert.equal(db.writes.length, writesBefore, "dry run performs no writes");
});

test("restore apply: restores baseline values; without prune keeps drift, with prune removes it; real data untouched", async () => {
  const db = fixture();
  const snap = await snapshotPresentationProject(db, PRES, allowed);

  // A visitor edits a work item and adds a junk work item + department.
  db.tables.work_items.find((w) => w.work_item_id === "wi-1").description_of_work = "VANDALIZED";
  db.tables.work_items.push({ work_item_id: "wi-x", project_id: PRES, department_id: D1, line_item_no: "99", description_of_work: "Junk", scheduled_value: 0, unit_of_measure: "m", planned_quantity: 0, retainage_percent: 0, status: "Active" });
  db.tables.departments.push({ department_id: "dep-x", project_id: PRES, department_code: "X", department_name: "Junk", status: "Active" });

  // Restore without prune: baseline values come back, drift rows remain.
  await applyRestore(db, snap, allowed, { prune: false });
  assert.equal(db.tables.work_items.find((w) => w.work_item_id === "wi-1").description_of_work, "Conduit", "edited value restored");
  assert.ok(db.tables.work_items.some((w) => w.work_item_id === "wi-x"), "drift kept without prune");

  // Restore with prune: drift rows removed; baseline intact.
  const result = await applyRestore(db, snap, allowed, { prune: true });
  assert.equal(result.applied, true);
  assert.equal(result.prunedWorkItems, 1);
  assert.equal(result.prunedDepartments, 1);
  assert.ok(!db.tables.work_items.some((w) => w.work_item_id === "wi-x"), "drift work item pruned");
  assert.ok(!db.tables.departments.some((d) => d.department_id === "dep-x"), "drift department pruned");
  assert.deepEqual(db.tables.work_items.filter((w) => w.project_id === PRES).map((w) => w.work_item_id).sort(), ["wi-1", "wi-2"]);

  // Real project rows were never touched.
  assert.ok(db.tables.work_items.some((w) => w.work_item_id === "wi-real"), "real work item untouched");
  assert.ok(db.tables.departments.some((d) => d.department_id === "dep-real"), "real department untouched");
});

test("restore apply: refused (no writes) if the project is not isolated at write time", async () => {
  const db = fixture();
  const snap = await snapshotPresentationProject(db, PRES, allowed);
  // A real member appears after the snapshot.
  db.tables.user_project_roles.push({ project_id: PRES, status: "Active", users: demo("intruder@abc.test") });
  const writesBefore = db.writes.length;
  await assert.rejects(() => applyRestore(db, snap, allowed, { prune: true }), NotIsolatedDemoProjectError);
  assert.equal(db.writes.length, writesBefore, "nothing written when isolation fails");
});

test("restore apply: refused for a snapshot of a non-allowed project", async () => {
  const db = fixture();
  const forged = { version: 1, projectId: REAL, capturedAt: "now", departments: [], workItems: [], dependencies: [] };
  await assert.rejects(() => applyRestore(db, forged, allowed, {}), NotIsolatedDemoProjectError);
});
