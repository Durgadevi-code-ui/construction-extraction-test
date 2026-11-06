/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Role-based one-click Demo Login (app/demo-login): the form sends a slot
// key only; the server signs in as that slot's dedicated demo account (a
// member of the existing project) and keeps the session only while the
// account is confined to the configured project(s) — lib/demoAccess.ts. Supabase, next/headers and
// next/navigation are in-memory stubs (no network, no database).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
delete process.env.RATE_LIMIT_BACKEND;
delete process.env.VERCEL_ENV;

function stubFile(file, exports) {
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}

// ------------------------------------------------------------ fake data

const WORKER = "demo.worker.electrical@example.com";
const ADMIN_SLOT = "demo.admin@example.com";
// DEMO_PROJECT: the existing project demo accounts work in (with real
// members); REAL_PROJECT: one they must never reach.
const DEMO_PROJECT = "existing-project";
const SECOND_PROJECT = "existing-project-b";
const REAL_PROJECT = "other-project";
const ENV = {
  DEMO_LOGIN_ENABLED: "true",
  DEMO_PROJECT_IDS: `${DEMO_PROJECT},${SECOND_PROJECT}`,
  DEMO_LOGIN_WORKER_ELECTRICAL_EMAIL: ` ${WORKER.toUpperCase()} `,
  DEMO_LOGIN_WORKER_ELECTRICAL_PASSWORD: "pw-worker-1",
  DEMO_LOGIN_ADMIN_DEMO_EMAIL: ADMIN_SLOT,
  DEMO_LOGIN_ADMIN_DEMO_PASSWORD: "pw-admin-1",
};
let db;
let logins; // email -> { id, password }: what Supabase Auth would accept
function seed() {
  db = {
    users: [
      { user_id: "u-w", auth_user_id: "a-w", user_mail: WORKER, user_role: "WORKER", status: "Active" },
      { user_id: "u-adm", auth_user_id: "a-adm", user_mail: ADMIN_SLOT, user_role: "SUPERVISOR", status: "Active" },
      { user_id: "u-real", auth_user_id: "a-real", user_mail: "real.user@abc.test", user_role: "WORKER", status: "Active" },
      { user_id: "u-admin", auth_user_id: "a-admin", user_mail: "boss@example.com", user_role: "ADMIN", status: "Active" },
    ],
    departments: [
      { department_id: "dep-el", project_id: DEMO_PROJECT, department_name: "Electrical Department" },
      { department_id: "dep-pl", project_id: DEMO_PROJECT, department_name: "Plumbing Department" },
      { department_id: "dep-b", project_id: SECOND_PROJECT, department_name: "Test Electrical Dept B" },
      { department_id: "dep-real", project_id: REAL_PROJECT, department_name: "Electrical Department" },
    ],
    projects: [
      { project_id: DEMO_PROJECT, project_name: "Existing Project" },
      { project_id: SECOND_PROJECT, project_name: "Existing Project B" },
      { project_id: REAL_PROJECT, project_name: "Other Project" },
    ],
    user_project_roles: [
      { user_id: "u-w", project_id: DEMO_PROJECT, department_id: "dep-el", role: "WORKER", status: "Active" },
      { user_id: "u-adm", project_id: DEMO_PROJECT, department_id: "dep-el", role: "SUPERVISOR", status: "Active" },
      // A real person in the same existing project: expected, not a problem.
      { user_id: "u-real", project_id: DEMO_PROJECT, department_id: "dep-el", role: "WORKER", status: "Active" },
    ],
    admin_delegations: [{ delegation_id: "d-demo", delegate_user_id: "u-adm", status: "Active" }],
    delegation_projects: [{ delegation_id: "d-demo", project_id: DEMO_PROJECT }],
    delegation_permissions: [
      { delegation_id: "d-demo", permission: "WORK_ITEM_MANAGEMENT" },
      { delegation_id: "d-demo", permission: "PROJECT_MANAGEMENT" },
    ],
  };
  logins = {
    [WORKER]: { id: "a-w", password: "pw-worker-1" },
    [ADMIN_SLOT]: { id: "a-adm", password: "pw-admin-1" },
    "real.user@abc.test": { id: "a-real", password: "their-real-password" },
  };
}

const passwordUpdates = [];
/** Just enough of supabase-js: select / eq / in / neq / order, embeds of
 * users(...), departments(...) and projects(...), and auth.admin.updateUserById. */
function fakeAdmin({ failTable } = {}) {
  return {
    auth: {
      admin: {
        async updateUserById(id, attrs) {
          passwordUpdates.push({ id, ...attrs });
          const entry = Object.entries(logins).find(([, l]) => l.id === id);
          if (entry) delete logins[entry[0]];
          logins[attrs.email] = { id, password: attrs.password };
          return { data: {}, error: null };
        },
      },
    },
    from(table) {
      const filters = [];
      let embeds = [];
      const run = () => {
        if (table === failTable) return { data: null, error: { message: "boom" } };
        let rows = db[table].filter((row) => filters.every((f) => f(row)));
        rows = rows.map((row) => {
          const out = { ...row };
          if (embeds.includes("users")) out.users = db.users.find((u) => u.user_id === row.user_id) ?? null;
          if (embeds.includes("departments")) out.departments = db.departments.find((d) => d.department_id === row.department_id) ?? null;
          if (embeds.includes("projects")) out.projects = db.projects.find((p) => p.project_id === row.project_id) ?? null;
          return out;
        });
        return { data: rows, error: null };
      };
      const q = {
        select(cols) {
          embeds = ["users", "departments", "projects"].filter((name) => cols.includes(`${name}(`));
          return q;
        },
        eq(col, value) {
          filters.push((row) => row[col] === value);
          return q;
        },
        in(col, values) {
          filters.push((row) => values.includes(row[col]));
          return q;
        },
        neq(col, value) {
          filters.push((row) => row[col] !== value);
          return q;
        },
        order() {
          return q;
        },
        async maybeSingle() {
          const { data, error } = run();
          return { data: data ? data[0] ?? null : null, error };
        },
        then(resolve, reject) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const { checkDemoAccount, demoLoginConfig, demoSlot, availableDemoRoles, repairDemoLogin, DEMO_SLOTS } = require("../lib/demoAccess.ts");
const config = (extra = {}) => demoLoginConfig({ ...ENV, ...extra });
const W_SLOT = demoSlot("worker_electrical");
const A_SLOT = demoSlot("admin_demo");
const worker = { authUserId: "a-w", email: WORKER };
const quiet = async (fn) => {
  const [w, i] = [console.warn, console.info];
  const logged = [];
  console.warn = console.info = (...args) => logged.push(JSON.stringify(args));
  try {
    return { result: await fn(), logged };
  } finally {
    console.warn = w;
    console.info = i;
  }
};

// ------------------------------------------------------------ config

test("demo config: off unless enabled with a demo project and at least one configured role", () => {
  assert.equal(demoLoginConfig({}).enabled, false);
  assert.equal(config({ DEMO_LOGIN_ENABLED: "false" }).enabled, false);
  assert.equal(config({ DEMO_PROJECT_IDS: "" }).enabled, false);
  assert.equal(demoLoginConfig({ DEMO_LOGIN_ENABLED: "true", DEMO_PROJECT_IDS: DEMO_PROJECT }).enabled, false, "no account at all");
  // A slot needs both its email and its password.
  assert.equal(demoLoginConfig({ DEMO_LOGIN_ENABLED: "true", DEMO_PROJECT_IDS: DEMO_PROJECT, DEMO_LOGIN_WORKER_ELECTRICAL_EMAIL: WORKER }).accounts.size, 0);
  // The old passwordless demo settings (real accounts) enable nothing.
  assert.equal(demoLoginConfig({ DEMO_MODE: "true", DEMO_USER_ADMIN_EMAIL: "boss@example.com", DEMO_USER_WORKER_ELECTRICAL_EMAIL: "real.user@abc.test" }).enabled, false);
  const c = config();
  assert.equal(c.enabled, true);
  assert.deepEqual([...c.emails].sort(), [ADMIN_SLOT, WORKER], "emails are trimmed and lower-cased");
});

test("demo picker: only configured roles, in a fixed order, with no email or password", () => {
  const roles = availableDemoRoles(config());
  assert.deepEqual(roles, [
    { key: "admin_demo", group: "Admin", team: "Project administration" },
    { key: "worker_electrical", group: "Worker", team: "Electrical" },
  ]);
  assert.doesNotMatch(JSON.stringify(roles), /@|pw-/);
  assert.deepEqual(availableDemoRoles(config({ DEMO_LOGIN_ENABLED: "false" })), []);
  assert.deepEqual([...new Set(DEMO_SLOTS.map((s) => s.group))], ["Admin", "Contractor", "Subcontractor", "Worker"]);
  assert.ok(DEMO_SLOTS.every((s) => s.role !== "ADMIN"), "no slot is a real Admin");
  assert.equal(demoSlot("admin_all"), undefined, "old real-account slot keys don't exist");
  assert.equal(demoSlot({ toString: () => "worker_electrical" }), undefined);
});

// ------------------------------------------------------------ isolation checks

test("demo check: isolated role accounts pass, with and without their slot", async () => {
  seed();
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker), { ok: true, userId: "u-w" });
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker, W_SLOT), { ok: true, userId: "u-w" });
  const adm = { authUserId: "a-adm", email: ADMIN_SLOT };
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), adm, A_SLOT), { ok: true, userId: "u-adm" }, "scoped delegation is allowed");
});

test("demo check: every way an account could reach real data is refused", async () => {
  const cases = [
    ["not-demo-email", () => {}, { authUserId: "a-real", email: "real.user@abc.test" }],
    ["not-linked", () => (db.users[0].auth_user_id = "someone-else")],
    ["email-mismatch", () => (db.users[0].user_mail = "other@example.com")],
    ["inactive", () => (db.users[0].status = "Inactive")],
    ["admin", () => (db.users[0].user_role = "ADMIN")],
    ["no-demo-role", () => (db.user_project_roles[0].status = "Removed")],
    ["role-outside-demo", () => db.user_project_roles.push({ user_id: "u-w", project_id: REAL_PROJECT, department_id: "dep-real", role: "WORKER", status: "Active" })],
  ];
  for (const [reason, mutate, identity] of cases) {
    seed();
    mutate();
    assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), identity ?? worker), { ok: false, reason }, reason);
  }
  // Inactive roles elsewhere don't count (e.g. the old Demo Project memberships, now Removed).
  seed();
  db.user_project_roles.push({ user_id: "u-w", project_id: REAL_PROJECT, department_id: "dep-real", role: "WORKER", status: "Removed" });
  assert.equal((await checkDemoAccount(fakeAdmin(), config(), worker)).ok, true);
});

test("demo check: a delegation reaching a real project, or with user management, is refused", async () => {
  const adm = { authUserId: "a-adm", email: ADMIN_SLOT };
  for (const [label, mutate] of [
    ["real project in scope", () => db.delegation_projects.push({ delegation_id: "d-demo", project_id: REAL_PROJECT })],
    ["user management", () => db.delegation_permissions.push({ delegation_id: "d-demo", permission: "USER_MANAGEMENT" })],
    ["delegation with no project row", () => (db.delegation_projects = [])],
    ["second delegation elsewhere", () => {
      db.admin_delegations.push({ delegation_id: "d-2", delegate_user_id: "u-adm", status: "Active" });
      db.delegation_projects.push({ delegation_id: "d-2", project_id: REAL_PROJECT });
    }],
  ]) {
    seed();
    mutate();
    assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), adm), { ok: false, reason: "delegation" }, label);
  }
  // A revoked delegation doesn't count.
  seed();
  db.delegation_permissions.push({ delegation_id: "d-demo", permission: "USER_MANAGEMENT" });
  db.admin_delegations[0].status = "Revoked";
  assert.equal((await checkDemoAccount(fakeAdmin(), config(), adm)).ok, true);
});

test("demo check: a slot only accepts an account with exactly its role and team", async () => {
  seed();
  db.user_project_roles[0].role = "FOREMAN";
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker, W_SLOT), { ok: false, reason: "wrong-role" }, "role");
  seed();
  db.user_project_roles[0].department_id = "dep-pl";
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker, W_SLOT), { ok: false, reason: "wrong-role" }, "team");
  seed();
  db.user_project_roles.push({ user_id: "u-w", project_id: SECOND_PROJECT, department_id: "dep-b", role: "FOREMAN", status: "Active" });
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker, W_SLOT), { ok: false, reason: "wrong-role" }, "a second, different role");
  // The same role in the second configured project, besides the slot's team, is fine.
  seed();
  db.user_project_roles.push({ user_id: "u-w", project_id: SECOND_PROJECT, department_id: "dep-b", role: "WORKER", status: "Active" });
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker, W_SLOT), { ok: true, userId: "u-w" }, "second configured project");
  seed();
  db.admin_delegations[0].delegate_user_id = "u-w";
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker, W_SLOT), { ok: false, reason: "wrong-role" }, "non-admin slot with a delegation");
  seed();
  db.admin_delegations = [];
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), { authUserId: "a-adm", email: ADMIN_SLOT }, A_SLOT), { ok: false, reason: "missing-delegation" });
});

test("demo check: real members of the existing project don't affect demo accounts, and are never demo accounts", async () => {
  seed();
  assert.equal((await checkDemoAccount(fakeAdmin(), config(), worker)).ok, true, "a real Worker in the same project is expected");
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), { authUserId: "a-real", email: "real.user@abc.test" }), { ok: false, reason: "not-demo-email" });
});

test("demo check: a failed lookup refuses (fails closed)", async () => {
  for (const table of ["users", "user_project_roles", "admin_delegations", "delegation_projects", "delegation_permissions"]) {
    seed();
    const r = await checkDemoAccount(fakeAdmin({ failTable: table }), config(), { authUserId: "a-adm", email: ADMIN_SLOT });
    assert.deepEqual(r, { ok: false, reason: "lookup-failed" }, table);
  }
});

// ------------------------------------------------------------ the server action

const signInCalls = [];
const signOutScopes = [];
let signInFails = null; // force an error kind on the next sign-in
let sessionUser = null; // what supabase.auth.getUser() answers (lib/session.ts)
let requestHeaders = new Headers();
stubFile(require.resolve(path.join(ROOT, "lib/supabaseServer.ts")), {
  createSupabaseServerClient: async () => ({
    auth: {
      signInWithPassword: async (creds) => {
        signInCalls.push(creds);
        if (signInFails) return { data: { user: null, session: null }, error: signInFails };
        const login = logins[creds.email];
        if (!login || login.password !== creds.password) {
          return { data: { user: null, session: null }, error: { name: "AuthApiError", status: 400, code: "invalid_credentials" } };
        }
        return { data: { user: { id: login.id, email: creds.email } }, error: null };
      },
      signOut: async (opts) => (signOutScopes.push(opts?.scope ?? "default"), { error: null }),
      getUser: async () => ({ data: { user: sessionUser }, error: null }),
    },
  }),
});
stubFile(require.resolve(path.join(ROOT, "lib/supabaseAdmin.ts")), {
  getSupabaseServiceRoleClient: () => fakeAdmin(),
});
stubFile(require.resolve("next/headers"), { headers: async () => requestHeaders });
class Redirect extends Error {
  constructor(to) {
    super(`redirect ${to}`);
    this.to = to;
  }
}
stubFile(require.resolve("next/navigation"), {
  redirect: (to) => {
    throw new Redirect(to);
  },
});

const { enterDemoWorkspace } = require("../app/demo-login/actions.ts");

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
function reset(env = {}) {
  seed();
  signInCalls.length = 0;
  signOutScopes.length = 0;
  passwordUpdates.length = 0;
  signInFails = null;
  for (const key of Object.keys(process.env)) if (key.startsWith("DEMO_")) delete process.env[key];
  Object.assign(process.env, ENV, env);
}
/** Runs the action; returns { redirect } or { error }. */
async function enter(fields) {
  const { result } = await quiet(async () => {
    try {
      return await enterDemoWorkspace(undefined, form(fields));
    } catch (err) {
      if (err instanceof Redirect) return { redirect: err.to };
      throw err;
    }
  });
  return result;
}

test("demo action: one click signs in as the slot's account and opens its dashboard", async () => {
  reset();
  assert.deepEqual(await enter({ role: "worker_electrical" }), { redirect: "/workflow" });
  assert.deepEqual(signInCalls, [{ email: WORKER, password: "pw-worker-1" }], "Supabase checks the server-held password");
  assert.deepEqual(signOutScopes, []);
  reset();
  assert.deepEqual(await enter({ role: "admin_demo" }), { redirect: "/admin/setup" }, "the Admin slot opens Admin Setup");
});

test("demo action: email/password fields in the request are ignored — only the slot decides who signs in", async () => {
  reset();
  assert.deepEqual(await enter({ role: "worker_electrical", email: "real.user@abc.test", password: "their-real-password" }), { redirect: "/workflow" });
  assert.deepEqual(signInCalls.map((c) => c.email), [WORKER]);
});

test("demo action: unknown, unconfigured or missing roles are refused without contacting Supabase", async () => {
  for (const role of [undefined, "", "admin_all", "worker_hvac", "contractor_electrical", "ADMIN", "real.user@abc.test"]) {
    reset();
    const r = await enter(role === undefined ? {} : { role });
    assert.equal(r.error, "Choose one of the listed demo roles.", String(role));
    assert.equal(signInCalls.length, 0);
  }
});

test("demo action: disabled environment refuses without contacting Supabase", async () => {
  reset({ DEMO_LOGIN_ENABLED: "false" });
  assert.equal((await enter({ role: "worker_electrical" })).error, "Demo login is not enabled in this environment.");
  assert.equal(signInCalls.length, 0);
});

test("demo action: an account that is not isolated, or not the slot's role, is signed straight back out", async () => {
  reset();
  db.user_project_roles.push({ user_id: "u-w", project_id: REAL_PROJECT, department_id: "dep-real", role: "WORKER", status: "Active" });
  assert.match((await enter({ role: "worker_electrical" })).error, /not set up as an isolated demo account/);
  assert.deepEqual(signOutScopes, ["local"]);
  reset();
  db.user_project_roles[0].role = "SUPERVISOR"; // a Contractor sitting in the Worker slot
  assert.match((await enter({ role: "worker_electrical" })).error, /not set up as an isolated demo account/);
  assert.deepEqual(signOutScopes, ["local"]);
});

test("demo action: a demo password changed by a visitor is restored, then sign-in succeeds", async () => {
  reset();
  logins[WORKER].password = "changed-by-a-visitor";
  assert.deepEqual(await enter({ role: "worker_electrical" }), { redirect: "/workflow" });
  assert.deepEqual(passwordUpdates, [{ id: "a-w", email: WORKER, password: "pw-worker-1", email_confirm: true }]);
  assert.equal(signInCalls.length, 2);
});

test("demo action: a real member of the project can never be a one-click account, and its password is never touched", async () => {
  // The real Worker shares the project, department and role with the demo
  // Worker, so only the reserved demo domain keeps it out.
  const misconfigured = { DEMO_LOGIN_WORKER_ELECTRICAL_EMAIL: "real.user@abc.test", DEMO_LOGIN_WORKER_ELECTRICAL_PASSWORD: "attacker-chosen-1" };
  reset(misconfigured);
  assert.equal((await enter({ role: "worker_electrical" })).error, "Choose one of the listed demo roles.");
  assert.equal(signInCalls.length, 0, "Supabase is never asked to sign in as the real person");
  assert.equal(await repairDemoLogin(fakeAdmin(), demoLoginConfig({ ...ENV, ...misconfigured }), W_SLOT), false);
  assert.deepEqual(passwordUpdates, [], "the real person's password is never changed");
  assert.equal(logins["real.user@abc.test"].password, "their-real-password");
  // Listing a real address in DEMO_LOGIN_EMAILS doesn't make it a demo account either.
  const c = config({ DEMO_LOGIN_EMAILS: "real.user@abc.test" });
  assert.equal(c.emails.has("real.user@abc.test"), false);
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), c, { authUserId: "a-real", email: "real.user@abc.test" }), { ok: false, reason: "not-demo-email" });
});

test("demo action: Supabase outages and rate limits get their own messages, and logs carry no email or password", async () => {
  reset();
  signInFails = { name: "AuthApiError", status: 429, code: "over_request_rate_limit" };
  const { result, logged } = await quiet(() => enterDemoWorkspace(undefined, form({ role: "worker_electrical" })));
  assert.match(result.error, /Too many sign-in attempts/);
  assert.ok(logged.every((l) => !l.includes(WORKER) && !l.includes("pw-worker-1")));
  assert.deepEqual(passwordUpdates, [], "only a rejected password triggers a restore");
});

test("demo action: the per-IP limit applies to one-click entry", async () => {
  reset();
  const { setRateLimitStoreForTests } = require("../lib/rateLimit.ts");
  const counts = new Map();
  setRateLimitStoreForTests({
    async hit(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { count: counts.get(key), resetAt: new Date(Date.now() + 600_000) };
    },
  });
  process.env.RATE_LIMIT_TRUST_PROXY_HEADERS = "true";
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.77" });
  try {
    let last;
    for (let i = 0; i < 31; i++) last = await enter({ role: "worker_electrical" });
    assert.match(last.error, /too many/i);
    assert.equal(signInCalls.length, 30, "the 31st click never reaches Supabase");
  } finally {
    setRateLimitStoreForTests(undefined);
    delete process.env.RATE_LIMIT_TRUST_PROXY_HEADERS;
    requestHeaders = new Headers();
  }
});

// ------------------------------------------------------------ every request, not just sign-in

const { demoSessionAllowed } = require("../lib/demoAccess.ts");
const { getCurrentUser } = require("../lib/session.ts");

test("demo session: other accounts pass without a single extra query", async () => {
  seed();
  const noQueries = { from: () => assert.fail("no query for a non-demo account") };
  const identity = { authUserId: "a-real", authEmail: "real.user@abc.test", appEmail: "real.user@abc.test" };
  assert.equal(await demoSessionAllowed(noQueries, identity, config()), true);
  assert.equal(await demoSessionAllowed(noQueries, identity, demoLoginConfig({})), true, "no demo configuration at all");
});

test("demo session: re-checked on every request — a role added after sign-in, or demo switched off, ends app access", async () => {
  const run = (c, identity = { authUserId: "a-w", authEmail: WORKER, appEmail: WORKER }) =>
    quiet(() => demoSessionAllowed(fakeAdmin(), identity, c)).then((r) => r.result);
  seed();
  assert.equal(await run(config()), true);
  assert.equal(await run(config(), { authUserId: "a-adm", authEmail: ADMIN_SLOT, appEmail: ADMIN_SLOT }), true, "demo Admin");
  db.user_project_roles.push({ user_id: "u-w", project_id: REAL_PROJECT, department_id: "dep-real", role: "WORKER", status: "Active" });
  assert.equal(await run(config()), false, "real-project role granted after sign-in");
  seed();
  db.delegation_projects.push({ delegation_id: "d-demo", project_id: REAL_PROJECT });
  assert.equal(await run(config(), { authUserId: "a-adm", authEmail: ADMIN_SLOT, appEmail: ADMIN_SLOT }), false, "delegation widened after sign-in");
  seed();
  assert.equal(await run(config({ DEMO_LOGIN_ENABLED: "false" })), false, "demo disabled: no app access for demo accounts");
  // The login email and app email are both checked, so a mismatch can't slip past.
  seed();
  db.users[0].user_mail = "renamed@example.com";
  assert.equal(await run(config(), { authUserId: "a-w", authEmail: WORKER, appEmail: "renamed@example.com" }), false);
});

test("getCurrentUser: real users unchanged; a demo account only while isolated, wherever it signed in", async () => {
  reset();
  sessionUser = { id: "a-real", email: "real.user@abc.test" };
  assert.deepEqual(await getCurrentUser(), { authUserId: "a-real", userId: "u-real", email: "real.user@abc.test" });
  sessionUser = { id: "a-admin", email: "boss@example.com" };
  assert.equal((await getCurrentUser()).userId, "u-admin");

  sessionUser = { id: "a-w", email: WORKER };
  assert.equal((await getCurrentUser()).userId, "u-w", "isolated demo session (e.g. signed in on /login)");
  db.user_project_roles.push({ user_id: "u-w", project_id: REAL_PROJECT, department_id: "dep-real", role: "WORKER", status: "Active" });
  assert.equal((await quiet(getCurrentUser)).result, null, "no longer isolated: treated as signed out");

  reset({ DEMO_LOGIN_ENABLED: "false" });
  assert.equal((await quiet(getCurrentUser)).result, null, "demo switched off");
  sessionUser = { id: "a-real", email: "real.user@abc.test" };
  assert.equal((await getCurrentUser()).userId, "u-real", "real users unaffected by the demo setting");
  sessionUser = null;
  assert.equal(await getCurrentUser(), null, "no session");
});

test("demo page: separate route, role picker only — no email or password field, nothing privileged", () => {
  const page = fs.readFileSync(path.join(ROOT, "app/demo-login/page.tsx"), "utf8");
  const formSrc = fs.readFileSync(path.join(ROOT, "components/auth/DemoLoginForm.tsx"), "utf8");
  assert.match(page, /Demo Login/);
  assert.match(formSrc, /Enter Demo Workspace/);
  assert.match(formSrc, /name="role"/);
  assert.doesNotMatch(formSrc, /type="(email|password)"|name="(email|password)"/, "no credential fields");
  assert.match(formSrc, /href="\/login"/, "links back to the regular sign-in page");
  for (const src of [page, formSrc]) {
    assert.doesNotMatch(src, /SERVICE_ROLE|supabaseAdmin|NEXT_PUBLIC_DEMO|PASSWORD|\.accounts/, "no privileged client, password or account list in the page");
  }
});

// ------------------------------------------------------------ read-only demo sessions (proxy.ts)

const claimsCalls = [];
let claimsEmail = null;
stubFile(require.resolve("@supabase/ssr"), {
  createServerClient: () => ({
    auth: {
      getClaims: async () => (claimsCalls.push(1), { data: claimsEmail ? { claims: { email: claimsEmail } } : null, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  }),
});
const { NextRequest } = require("next/server");
const { proxy } = require("../proxy.ts");
const call = (method, url, email) => {
  claimsEmail = email;
  claimsCalls.length = 0;
  return proxy(new NextRequest(`http://localhost${url}`, { method }));
};

test("demo sessions are read-only: every write to /api is refused, reads pass", async () => {
  for (const [method, url] of [
    ["POST", "/api/workflow/worker"],
    ["POST", "/api/workflow/chat"],
    ["PATCH", "/api/admin/work-items"],
    ["PUT", "/api/workflow/task-progress"],
    ["DELETE", "/api/admin/users"],
    ["POST", "/api/admin/projects/import"],
  ]) {
    const r = await call(method, url, WORKER);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.match((await r.json()).error, /read-only/);
  }
  const read = await call("GET", "/api/workflow/dashboard", WORKER);
  assert.equal(read.status, 200, "reads pass through");
  assert.equal(claimsCalls.length, 0, "a read costs no auth lookup at all");
});

test("real users' writes are untouched by the demo read-only rule", async () => {
  for (const email of ["real.user@abc.test", "boss@example.org", null]) {
    const r = await call("POST", "/api/workflow/worker", email);
    assert.equal(r.status, 200, String(email));
    assert.equal(r.headers.get("x-middleware-next"), "1", "passed on to the route, which does its own checks");
  }
});
