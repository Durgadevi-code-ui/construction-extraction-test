/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs. */
// One application, one Admin, one permission system. The real Admin and
// workflow route handlers and lib code run against an in-memory table store
// (no network, no production database), so every save is genuinely applied
// and read back here:
//   - the one ADMIN (users.user_role = 'ADMIN', signed in with its own
//     credentials) has the complete Admin permission set, in every company
//     and project;
//   - every other role keeps exactly its existing permissions, whether it
//     signed in through /login or through Demo Login (the result is the
//     same either way, because nothing depends on how the user signed in).
// Creating user logins and password resets need Supabase Auth itself and
// are covered as a real ADMIN in tests/security-routes, tests/auth-accounts
// and tests/admin-users-notice. Run with `npm test`.
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

/** In-memory PostgREST-style client (same shape as tests/security-roles):
 * joined columns are stored on the row; writes are applied and recorded. */
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
      const out = op === "update" ? rows().filter(matches) : [].concat(payload ?? []);
      return { data: single ? out[0] ?? null : out, error: null };
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
stubModule("lib/session.ts", { getCurrentUser: async () => currentUser, requireCurrentUser: async () => currentUser });
stubModule("lib/supabaseAdmin.ts", { getSupabaseServiceRoleClient: () => db });
stubModule("lib/supabase.ts", { getSupabaseClient: () => db });

const logged = [];
for (const level of ["warn", "error"]) {
  const original = console[level];
  console[level] = (...args) => {
    logged.push(args.map(String).join(" "));
    if (process.env.SHOW_TEST_LOGS) original(...args);
  };
}

const { NextRequest } = require("next/server");
const projectsRoute = require("../app/api/admin/projects/route.ts");
const departmentsRoute = require("../app/api/admin/departments/route.ts");
const workItemsRoute = require("../app/api/admin/work-items/route.ts");
const companiesRoute = require("../app/api/admin/companies/route.ts");
const usersRoute = require("../app/api/admin/users/route.ts");
const delegationsRoute = require("../app/api/admin/delegations/route.ts");
const notificationsRoute = require("../app/api/workflow/notifications/route.ts");
const { resolveAdminSetupAccess } = require("../lib/delegation.ts");
const { DELEGATION_PERMISSIONS } = require("../lib/delegationTypes.ts");

// ---- fixture: two companies' projects, fictional ids and names ----
const COMPANY = "c0000000-0000-4000-8000-000000000001";
const COMPANY_2 = "c0000000-0000-4000-8000-000000000002";
const P1 = "10000000-0000-4000-8000-000000000001";
const P2 = "10000000-0000-4000-8000-000000000002"; // another company's project
const D_ELEC = "20000000-0000-4000-8000-000000000001";
const D_OTHER = "20000000-0000-4000-8000-000000000009";
const ADMIN = "30000000-0000-4000-8000-000000000009";
const DELEGATE = "30000000-0000-4000-8000-000000000002"; // a real Contractor holding an Admin-granted delegation
const CONTRACTOR = "30000000-0000-4000-8000-000000000001"; // a Contractor without one (e.g. a demo Contractor)
const WORKER = "30000000-0000-4000-8000-000000000003";
const PERMS = ["WORK_ITEM_MANAGEMENT", "PROJECT_MANAGEMENT", "DEPARTMENT_MANAGEMENT"];

function fixture() {
  const user = (id, mail, role) => ({ user_id: id, user_mail: mail, user_role: role, status: "Active", first_name: "F", last_name: "L" });
  const role = (id, r, project, dept) => ({
    user_id: id, role: r, project_id: project, department_id: dept, status: "Active",
    projects: { project_name: "P" }, departments: { department_name: "Electrical Department" },
  });
  return memoryDb({
    companies: [
      { company_id: COMPANY, company_name: "ABC", company_code: "ABC", status: "Active" },
      { company_id: COMPANY_2, company_name: "XYZ", company_code: "XYZ", status: "Active" },
    ],
    projects: [
      { project_id: P1, company_id: COMPANY, project_code: "P1", project_name: "Project One", project_location: "Old", status: "Active", task_context_enabled: false },
      { project_id: P2, company_id: COMPANY_2, project_code: "P2", project_name: "Project Two", project_location: "Elsewhere", status: "Active", task_context_enabled: false },
    ],
    departments: [
      { department_id: D_ELEC, project_id: P1, department_code: "ELEC", department_name: "Electrical Department", status: "Active" },
      { department_id: D_OTHER, project_id: P2, department_code: "ELEC", department_name: "Electrical Department", status: "Active" },
    ],
    work_items: [],
    users: [
      user(ADMIN, "admin@abc.test", "ADMIN"),
      user(DELEGATE, "contractor@abc.test", "SUPERVISOR"),
      user(CONTRACTOR, "demo.contractor.electrical@example.com", "SUPERVISOR"),
      user(WORKER, "demo.worker.electrical@example.com", "WORKER"),
    ],
    user_project_roles: [role(DELEGATE, "SUPERVISOR", P1, D_ELEC), role(CONTRACTOR, "SUPERVISOR", P1, D_ELEC), role(WORKER, "WORKER", P1, D_ELEC)],
    admin_delegations: [{
      delegation_id: "d-real", admin_user_id: ADMIN, delegate_user_id: DELEGATE, status: "Active",
      starts_at: "2026-01-01T00:00:00Z", ends_at: "2099-01-01T00:00:00Z", reason: null,
      admin: { user_mail: "admin@abc.test" }, delegate: { user_mail: "contractor@abc.test" },
      delegation_projects: [{ project_id: P1, projects: { project_name: "Project One" } }],
      delegation_departments: [],
      delegation_permissions: PERMS.map((permission) => ({ permission })),
    }],
    notifications: [{ notification_id: "n1", user_id: WORKER, is_read: false, read_at: null, created_at: "2026-01-01T00:00:00Z" }],
  });
}

const ADMIN_SESSION = { authUserId: "a9", userId: ADMIN, email: "admin@abc.test", isDemo: false };
const DELEGATE_SESSION = { authUserId: "a2", userId: DELEGATE, email: "contractor@abc.test", isDemo: false };
const DEMO_CONTRACTOR_SESSION = { authUserId: "a1", userId: CONTRACTOR, email: "demo.contractor.electrical@example.com", isDemo: true };
const DEMO_WORKER_SESSION = { authUserId: "a3", userId: WORKER, email: "demo.worker.electrical@example.com", isDemo: true };

const req = (method, url, body) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Runs `call` as `session` on a fresh fixture; returns status, body and the db. */
async function as(session, call) {
  db = fixture();
  currentUser = session;
  logged.length = 0;
  const res = await call();
  const body = await res.json().catch(() => null);
  currentUser = null;
  return { status: res.status, body, db, logs: [...logged] };
}
const ok = (r) => assert.equal(r.status, 200, JSON.stringify(r.body) + "\n" + r.logs.join("\n"));

test.beforeEach(() => {
  delete process.env.DEMO_LOGIN_READ_ONLY;
});

// ---- the one Admin: the complete Admin permission set ----

test("Admin: full access everywhere — every company, project and permission", async () => {
  db = fixture();
  const access = await resolveAdminSetupAccess(db, ADMIN);
  assert.equal(access.isRealAdmin, true);
  assert.equal(access.projectIds, "ALL");
  assert.equal(access.departmentIds, "ALL");
  assert.deepEqual([...access.permissions].sort(), [...DELEGATION_PERMISSIONS].sort());
});

test("Admin: creates a company — saved", async () => {
  const r = await as(ADMIN_SESSION, () => companiesRoute.POST(req("POST", "/api/admin/companies", { name: "New Co", code: "NEWCO" })));
  ok(r);
  assert.ok(r.db.writes.some((w) => w.table === "companies" && w.op === "insert"));
});

test("Admin: creates a project in any company, and edits any project — saved", async () => {
  let r = await as(ADMIN_SESSION, () => projectsRoute.POST(req("POST", "/api/admin/projects", { companyId: COMPANY_2, projectCode: "P3", projectName: "Project Three" })));
  ok(r);
  assert.ok(r.db.writes.some((w) => w.table === "projects" && w.op === "insert"));
  r = await as(ADMIN_SESSION, () => projectsRoute.PATCH(req("PATCH", "/api/admin/projects", { projectId: P2, projectName: "Project Two (edited)", projectLocation: "New City" })));
  ok(r);
  assert.equal(r.db.tables.projects.find((p) => p.project_id === P2).project_name, "Project Two (edited)");
});

test("Admin: creates and renames departments in any project — saved", async () => {
  let r = await as(ADMIN_SESSION, () => departmentsRoute.POST(req("POST", "/api/admin/departments", { projectId: P2, departmentCode: "HVAC", departmentName: "HVAC Department" })));
  ok(r);
  assert.ok(r.db.tables.departments.some((d) => d.project_id === P2 && d.department_name === "HVAC Department"));
  r = await as(ADMIN_SESSION, () => departmentsRoute.PATCH(req("PATCH", "/api/admin/departments", { departmentId: D_OTHER, departmentName: "Electrical (renamed)" })));
  ok(r);
  assert.equal(r.db.tables.departments.find((d) => d.department_id === D_OTHER).department_name, "Electrical (renamed)");
});

test("Admin: creates work items in any department — saved", async () => {
  const r = await as(ADMIN_SESSION, () => workItemsRoute.POST(req("POST", "/api/admin/work-items", { departmentId: D_OTHER, lineItemNo: "901", descriptionOfWork: "Cable tray install", plannedQuantity: 120, unitOfMeasure: "m" })));
  ok(r);
  assert.ok(r.db.tables.work_items.some((w) => w.department_id === D_OTHER && w.line_item_no === "901"));
});

test("Admin: creates a delegation — saved", async () => {
  const r = await as(ADMIN_SESSION, () => delegationsRoute.POST(req("POST", "/api/admin/delegations", {
    delegateUserId: DELEGATE, projectIds: [P1], permissions: ["WORK_ITEM_MANAGEMENT"],
    startsAt: "2026-01-01T00:00:00Z", endsAt: "2099-01-01T00:00:00Z", reason: "cover",
  })));
  ok(r);
  assert.ok(r.db.writes.some((w) => w.table === "admin_delegations" && w.op === "insert"));
});

// ---- every other role: exactly its existing permissions ----

test("a delegated Contractor keeps exactly its delegation — inside it saved, outside it refused", async () => {
  let r = await as(DELEGATE_SESSION, () => projectsRoute.PATCH(req("PATCH", "/api/admin/projects", { projectId: P1, projectName: "Project One (edited)" })));
  ok(r);
  r = await as(DELEGATE_SESSION, () => projectsRoute.PATCH(req("PATCH", "/api/admin/projects", { projectId: P2, projectName: "x" })));
  assert.equal(r.status, 403);
  assert.equal(r.db.writes.length, 0);
});

test("Contractors (demo or not) are not Admins: company, project, user and delegation management refused, nothing written", async () => {
  for (const session of [DEMO_CONTRACTOR_SESSION, DELEGATE_SESSION]) {
    for (const call of [
      () => companiesRoute.POST(req("POST", "/api/admin/companies", { name: "New Co", code: "NEW" })),
      () => projectsRoute.POST(req("POST", "/api/admin/projects", { companyId: COMPANY, projectCode: "NEW", projectName: "New" })),
      () => usersRoute.POST(req("POST", "/api/admin/users", { email: "new.person@abc.test", role: "WORKER", projectId: P1, departmentId: D_ELEC })),
      () => delegationsRoute.POST(req("POST", "/api/admin/delegations", { delegateUserId: CONTRACTOR, projectIds: [P1], permissions: ["WORK_ITEM_MANAGEMENT"], startsAt: "2026-01-01T00:00:00Z", endsAt: "2099-01-01T00:00:00Z" })),
    ]) {
      const r = await as(session, call);
      assert.equal(r.status, 403, `${session.email}: ${JSON.stringify(r.body)}`);
      assert.doesNotMatch(r.body.error ?? "", /read-only/, "the genuine permission check, not a demo rule");
      assert.equal(r.db.writes.length, 0);
    }
  }
});

test("a demo Worker's own operation saves, like any Worker's", async () => {
  const r = await as(DEMO_WORKER_SESSION, () => notificationsRoute.POST(req("POST", "/api/workflow/notifications", { action: "markAllRead" })));
  ok(r);
  assert.ok(r.db.writes.some((w) => w.table === "notifications" && w.op === "update"));
});

test("DEMO_LOGIN_READ_ONLY=true (emergency switch): a demo save is refused read-only; the Admin is unaffected", async () => {
  process.env.DEMO_LOGIN_READ_ONLY = "true";
  let r = await as(DEMO_WORKER_SESSION, () => notificationsRoute.POST(req("POST", "/api/workflow/notifications", { action: "markAllRead" })));
  assert.equal(r.status, 403);
  assert.match(r.body.error, /read-only/);
  assert.equal(r.db.writes.length, 0);
  r = await as(ADMIN_SESSION, () => companiesRoute.POST(req("POST", "/api/admin/companies", { name: "New Co", code: "NEWCO" })));
  ok(r);
  delete process.env.DEMO_LOGIN_READ_ONLY;
});
