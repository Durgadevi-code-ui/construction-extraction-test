/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Role-boundary tests for the day-to-day workflow routes: a Worker, Foreman
// or Supervisor acting outside their own assignment/department is refused
// server-side with a generic 403 and nothing is written, while the same
// action inside their scope still works. The real route handlers and
// lib/workflow.ts run against an in-memory table store (no network, no
// database); only the session and Supabase client modules are stubbed.
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

/**
 * Minimal PostgREST-style client over in-memory tables. select() returns
 * whole rows (joined columns such as `projects` are stored on the row);
 * eq/neq/in/is/not.is/lt/lte/gt/gte filter; every write is recorded in
 * `writes` and applied. Unknown chain methods (order, limit, or, ...) are
 * no-ops.
 */
function memoryDb(tables) {
  const writes = [];
  function query(table) {
    const rows = () => (tables[table] ??= []);
    const filters = [];
    let op = "select";
    let payload;
    let single = null;
    const matches = (r) => filters.every((f) => f(r));
    const run = () => {
      if (op === "select") {
        const found = rows().filter(matches);
        if (single === "one") return found.length === 1 ? { data: found[0], error: null } : { data: null, error: { message: `${found.length} rows` } };
        if (single === "maybe") return { data: found[0] ?? null, error: null };
        return { data: found, error: null };
      }
      writes.push({ table, op, payload });
      if (op === "insert" || op === "upsert") rows().push(...[].concat(payload));
      if (op === "update") for (const r of rows().filter(matches)) Object.assign(r, payload);
      if (op === "delete") tables[table] = rows().filter((r) => !matches(r));
      return { data: [].concat(payload ?? [])[0] ?? null, error: null };
    };
    const known = {
      select: () => builder,
      insert: (p) => ((op = "insert"), (payload = p), builder),
      upsert: (p) => ((op = "upsert"), (payload = p), builder),
      update: (p) => ((op = "update"), (payload = p), builder),
      delete: () => ((op = "delete"), builder),
      eq: (c, v) => (filters.push((r) => r[c] === v), builder),
      neq: (c, v) => (filters.push((r) => r[c] !== v), builder),
      in: (c, vs) => (filters.push((r) => vs.includes(r[c])), builder),
      is: (c, v) => (filters.push((r) => (r[c] ?? null) === v), builder),
      not: (c, o, v) => (o === "is" && filters.push((r) => (r[c] ?? null) !== v), builder),
      lt: (c, v) => (filters.push((r) => r[c] < v), builder),
      lte: (c, v) => (filters.push((r) => r[c] <= v), builder),
      gt: (c, v) => (filters.push((r) => r[c] > v), builder),
      gte: (c, v) => (filters.push((r) => r[c] >= v), builder),
      single: () => ((single = "one"), builder),
      maybeSingle: () => ((single = "maybe"), builder),
    };
    const builder = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (resolve, reject) => Promise.resolve().then(run).then(resolve, reject);
        return known[prop] ?? (() => builder);
      },
    });
    return builder;
  }
  return {
    tables,
    writes,
    from: query,
    rpc: async () => ({ data: null, error: { message: "rpc not available in tests" } }),
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
  };
}

let currentUser = null;
let db = memoryDb({});
stubModule("lib/session.ts", {
  getCurrentUser: async () => currentUser,
  requireCurrentUser: async () => currentUser,
});
stubModule("lib/supabaseAdmin.ts", { getSupabaseServiceRoleClient: () => db });

/** Server-side denial details (logged, never sent) — to prove a refusal came
 * from the intended authorization check, not from an incomplete stub. */
const logged = [];
for (const level of ["warn", "error"]) {
  const original = console[level];
  console[level] = (...args) => {
    logged.push(args.map(String).join(" "));
    if (process.env.SHOW_TEST_LOGS) original(...args);
  };
}

const taskProgress = require("../app/api/workflow/task-progress/route.ts");
const foremanAssignments = require("../app/api/workflow/foreman/assignments/route.ts");
const supervisor = require("../app/api/workflow/supervisor/route.ts");
const notifications = require("../app/api/workflow/notifications/route.ts");
const { PERMISSION_MESSAGE } = require("../lib/apiClient.ts");

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---- fixture: one project, Electrical and Plumbing departments ----------
const P1 = "10000000-0000-4000-8000-000000000001";
const D_ELEC = "20000000-0000-4000-8000-000000000001";
const D_PLUMB = "20000000-0000-4000-8000-000000000002";
const WORKER = "30000000-0000-4000-8000-000000000001";
const WORKER_2 = "30000000-0000-4000-8000-000000000002";
const FOREMAN = "30000000-0000-4000-8000-000000000003";
const SUPERVISOR = "30000000-0000-4000-8000-000000000004";
const PLUMB_WORKER = "30000000-0000-4000-8000-000000000005";
const WI_ASSIGNED = "40000000-0000-4000-8000-000000000001";
const WI_UNASSIGNED = "40000000-0000-4000-8000-000000000002";
const WI_PLUMB = "40000000-0000-4000-8000-000000000003";
const SUB_ELEC = "50000000-0000-4000-8000-000000000001";
const SUB_PLUMB = "50000000-0000-4000-8000-000000000002";
const VAL_ELEC = "60000000-0000-4000-8000-000000000001";
const VAL_PLUMB = "60000000-0000-4000-8000-000000000002";
const NOTE_MINE = "70000000-0000-4000-8000-000000000001";
const NOTE_OTHER = "70000000-0000-4000-8000-000000000002";

const role = (userId, r, departmentId) => ({
  user_id: userId,
  role: r,
  project_id: P1,
  department_id: departmentId,
  status: "Active",
  projects: { project_name: "Test Project" },
  departments: { department_name: departmentId === D_ELEC ? "Electrical" : "Plumbing" },
});
const user = (userId, r, departmentId) => ({
  user_id: userId,
  user_role: r,
  department_id: departmentId,
  status: "Active",
  first_name: r,
  last_name: "User",
  user_mail: `${userId}@example.com`,
});
const workItem = (id, departmentId) => ({
  work_item_id: id,
  project_id: P1,
  department_id: departmentId,
  status: "Active",
  line_item_no: id.slice(-3),
  description_of_work: "Test work",
  additional_fields: { __tasks: [{ id: "t1", label: "Pull cable", status: "Active", updateAccess: true }] },
});
const pendingValidation = (id, submissionId) => ({
  user_validations_id: id,
  submission_id: submissionId,
  original_data: { progressPercentage: 10 },
  corrected_data: null,
  approval_status: "PENDING",
});

function freshDb() {
  return memoryDb({
    users: [
      user(WORKER, "WORKER", D_ELEC),
      user(WORKER_2, "WORKER", D_ELEC),
      user(FOREMAN, "FOREMAN", D_ELEC),
      user(SUPERVISOR, "SUPERVISOR", D_ELEC),
      user(PLUMB_WORKER, "WORKER", D_PLUMB),
    ],
    user_project_roles: [
      role(WORKER, "WORKER", D_ELEC),
      role(WORKER_2, "WORKER", D_ELEC),
      role(FOREMAN, "FOREMAN", D_ELEC),
      role(SUPERVISOR, "SUPERVISOR", D_ELEC),
      role(PLUMB_WORKER, "WORKER", D_PLUMB),
    ],
    work_items: [workItem(WI_ASSIGNED, D_ELEC), workItem(WI_UNASSIGNED, D_ELEC), workItem(WI_PLUMB, D_PLUMB)],
    work_item_assignments: [{ work_item_id: WI_ASSIGNED, user_id: WORKER, status: "Active" }],
    extraction_submissions: [
      { extraction_submission_id: SUB_ELEC, project_id: P1, department_id: D_ELEC, work_item_id: WI_ASSIGNED, worker_id: WORKER },
      { extraction_submission_id: SUB_PLUMB, project_id: P1, department_id: D_PLUMB, work_item_id: WI_PLUMB, worker_id: PLUMB_WORKER },
    ],
    user_validations: [pendingValidation(VAL_ELEC, SUB_ELEC), pendingValidation(VAL_PLUMB, SUB_PLUMB)],
    notifications: [
      { notification_id: NOTE_MINE, recipient_user_id: WORKER, is_read: false },
      { notification_id: NOTE_OTHER, recipient_user_id: WORKER_2, is_read: false },
    ],
  });
}

const as = (userId) => ({ userId, authUserId: `auth-${userId}`, email: `${userId}@example.com` });
const post = (url, body) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const writesTo = (...tables) => db.writes.filter((w) => tables.includes(w.table));

/** A refusal: 403, the generic permission text (no ids, no role), nothing
 * written to `tables`, and the server log names `reason`. */
async function assertRefused(res, tables, reason) {
  assert.equal(res.status, 403);
  const { error } = await res.json();
  assert.equal(error, PERMISSION_MESSAGE);
  assert.doesNotMatch(error, UUID);
  assert.deepEqual(writesTo(...tables), [], "nothing written");
  assert.ok(logged.some((l) => reason.test(l)), `refused by the intended check (${reason})`);
}

test.beforeEach(() => {
  db = freshDb();
  logged.length = 0;
});

// ===================================================== Worker
test("worker: task progress on their own assigned work item is saved", async () => {
  currentUser = as(WORKER);
  const res = await taskProgress.POST(post("/api/workflow/task-progress", { workItemId: WI_ASSIGNED, taskId: "t1", percent: 40 }));
  assert.equal(res.status, 200);
  assert.equal(writesTo("work_items").length, 1);
});

test("worker: task progress on an unassigned work item in their department is refused", async () => {
  currentUser = as(WORKER);
  const res = await taskProgress.POST(post("/api/workflow/task-progress", { workItemId: WI_UNASSIGNED, taskId: "t1", percent: 40 }));
  await assertRefused(res, ["work_items"], /is not assigned to worker/);
});

test("worker: task progress on another department's work item is refused", async () => {
  currentUser = as(WORKER);
  const res = await taskProgress.POST(post("/api/workflow/task-progress", { workItemId: WI_PLUMB, taskId: "t1", percent: 40 }));
  await assertRefused(res, ["work_items"], /does not belong to department/);
});

test("worker: a user with no active project role is refused", async () => {
  currentUser = as(WORKER);
  // An Admin removed the worker's only role assignment (deactivateUserProjectRole).
  for (const r of db.tables.user_project_roles) if (r.user_id === WORKER) r.status = "Removed";
  const res = await taskProgress.POST(post("/api/workflow/task-progress", { workItemId: WI_ASSIGNED, taskId: "t1", percent: 40 }));
  await assertRefused(res, ["work_items"], /No active project\/department assignment/);
});

// ===================================================== Foreman
test("foreman: assigning a worker in their own department still works", async () => {
  currentUser = as(FOREMAN);
  const res = await foremanAssignments.POST(post("/api/workflow/foreman/assignments", { action: "assign", workItemId: WI_UNASSIGNED, workerUserId: WORKER_2 }));
  assert.equal(res.status, 200);
  assert.equal(writesTo("work_item_assignments").length, 1);
});

test("foreman: managing assignments on another department's work item is refused", async () => {
  currentUser = as(FOREMAN);
  for (const action of ["assign", "remove"]) {
    db = freshDb();
    logged.length = 0;
    const res = await foremanAssignments.POST(post("/api/workflow/foreman/assignments", { action, workItemId: WI_PLUMB, workerUserId: PLUMB_WORKER }));
    await assertRefused(res, ["work_item_assignments"], /not authorized to manage assignments/);
  }
});

test("worker: cannot use the foreman assignment endpoint", async () => {
  currentUser = as(WORKER);
  const res = await foremanAssignments.POST(post("/api/workflow/foreman/assignments", { action: "assign", workItemId: WI_UNASSIGNED, workerUserId: WORKER }));
  await assertRefused(res, ["work_item_assignments"], /not authorized to manage assignments/);
});

// ===================================================== Supervisor
test("supervisor: approving another department's submission is refused", async () => {
  currentUser = as(SUPERVISOR);
  const res = await supervisor.POST(post("/api/workflow/supervisor", { action: "approve", validationId: VAL_PLUMB }));
  await assertRefused(res, ["user_validations", "extraction_submissions", "work_items", "unified_records"], /not authorized to review progress/);
});

test("worker and foreman: cannot approve progress at all", async () => {
  for (const actor of [WORKER, FOREMAN]) {
    db = freshDb();
    logged.length = 0;
    currentUser = as(actor);
    const res = await supervisor.POST(post("/api/workflow/supervisor", { action: "approve", validationId: VAL_ELEC }));
    await assertRefused(res, ["user_validations", "extraction_submissions", "work_items", "unified_records"], /not authorized to review progress/);
  }
});

// ===================================================== Notifications
test("notifications: marking another user's notification read is refused; your own still works", async () => {
  currentUser = as(WORKER);
  const other = await notifications.POST(post("/api/workflow/notifications", { action: "markRead", notificationId: NOTE_OTHER }));
  assert.equal(other.status, 403);
  assert.deepEqual(writesTo("notifications"), []);

  const mine = await notifications.POST(post("/api/workflow/notifications", { action: "markRead", notificationId: NOTE_MINE }));
  assert.equal(mine.status, 200);
  assert.equal(writesTo("notifications").length, 1);
});

// ===================================================== No session
test("workflow write routes: no session -> 401 and no database access", async () => {
  currentUser = null;
  for (const [route, url, body] of [
    [taskProgress, "/api/workflow/task-progress", { workItemId: WI_ASSIGNED, taskId: "t1", percent: 1 }],
    [foremanAssignments, "/api/workflow/foreman/assignments", { action: "assign", workItemId: WI_UNASSIGNED, workerUserId: WORKER_2 }],
    [supervisor, "/api/workflow/supervisor", { action: "approve", validationId: VAL_ELEC }],
    [notifications, "/api/workflow/notifications", { action: "markAllRead" }],
  ]) {
    const res = await route.POST(post(url, body));
    assert.equal(res.status, 401, url);
  }
  assert.deepEqual(db.writes, []);
});
