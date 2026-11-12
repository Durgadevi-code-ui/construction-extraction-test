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
const FORMER_ADMIN = "demo.admin@example.com"; // former demo Admin: still in the database (with a delegation), no longer a slot
// DEMO_PROJECT / SECOND_PROJECT: presentation projects (demo members only);
// REAL_PROJECT: a client project they must never reach.
const DEMO_PROJECT = "existing-project";
const SECOND_PROJECT = "existing-project-b";
const REAL_PROJECT = "other-project";
const ENV = {
  DEMO_LOGIN_ENABLED: "true",
  DEMO_PROJECT_IDS: `${DEMO_PROJECT},${SECOND_PROJECT}`,
  DEMO_LOGIN_WORKER_ELECTRICAL_EMAIL: ` ${WORKER.toUpperCase()} `,
  DEMO_LOGIN_WORKER_ELECTRICAL_PASSWORD: "pw-worker-1",
  DEMO_LOGIN_ADMIN_DEMO_EMAIL: FORMER_ADMIN,
  DEMO_LOGIN_ADMIN_DEMO_PASSWORD: "pw-admin-1",
};
let db;
let logins; // email -> { id, password }: what Supabase Auth would accept
function seed() {
  db = {
    users: [
      { user_id: "u-w", auth_user_id: "a-w", user_mail: WORKER, user_role: "WORKER", status: "Active" },
      { user_id: "u-adm", auth_user_id: "a-adm", user_mail: FORMER_ADMIN, user_role: "SUPERVISOR", status: "Active" },
      { user_id: "u-real", auth_user_id: "a-real", user_mail: "real.user@abc.test", user_role: "WORKER", status: "Active" },
      { user_id: "u-admin", auth_user_id: "a-admin", user_mail: "boss@abc.test", user_role: "ADMIN", status: "Active" },
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
      // A real person works in a client project, never in a presentation project.
      { user_id: "u-real", project_id: REAL_PROJECT, department_id: "dep-real", role: "WORKER", status: "Active" },
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
    [FORMER_ADMIN]: { id: "a-adm", password: "pw-admin-1" },
    "real.user@abc.test": { id: "a-real", password: "their-real-password" },
  };
}

const passwordUpdates = [];
const linkCalls = []; // auth.admin.generateLink calls: must stay empty (no passwordless sessions)
/** Just enough of supabase-js: select / eq / in / neq / order, embeds of
 * users(...), departments(...) and projects(...), and auth.admin.updateUserById. */
function fakeAdmin({ failTable } = {}) {
  return {
    auth: {
      admin: {
        async generateLink(params) {
          linkCalls.push(params);
          return { data: { properties: { hashed_token: `th:${params.email}` } }, error: null };
        },
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
  assert.deepEqual([...c.emails], [WORKER], "emails are trimmed and lower-cased; the old admin_demo settings are ignored");
});

test("demo picker: only configured roles, in a fixed order, with no email or password", () => {
  const roles = availableDemoRoles(config());
  assert.deepEqual(roles, [{ key: "worker_electrical", group: "Worker", team: "Electrical" }], "no demo Admin, even with its old variables set");
  assert.doesNotMatch(JSON.stringify(roles), /@|pw-/);
  assert.deepEqual(availableDemoRoles(config({ DEMO_LOGIN_ENABLED: "false" })), []);
  assert.deepEqual([...new Set(DEMO_SLOTS.map((s) => s.group))], ["Contractor", "Subcontractor", "Worker"]);
  assert.equal(DEMO_SLOTS.length, 9, "the 9 trade roles");
  assert.ok(DEMO_SLOTS.every((s) => s.role !== "ADMIN"), "no slot is ever a real ADMIN account");
  assert.equal(demoSlot("admin_demo"), undefined, "the demo Admin slot is gone");
  assert.equal(demoSlot("admin_all"), undefined, "old real-account slot keys don't exist");
  assert.equal(demoSlot({ toString: () => "worker_electrical" }), undefined);
});

// ------------------------------------------------------------ isolation checks

test("demo check: isolated role accounts pass, with and without their slot", async () => {
  seed();
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker), { ok: true, userId: "u-w" });
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker, W_SLOT), { ok: true, userId: "u-w" });
});

test("one Admin: the former demo Admin account (a Contractor with a delegation) is refused everywhere", async () => {
  seed();
  const adm = { authUserId: "a-adm", email: FORMER_ADMIN };
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), adm), { ok: false, reason: "not-demo-email" }, "not configured any more");
  assert.deepEqual(
    await checkDemoAccount(fakeAdmin(), config({ DEMO_LOGIN_EMAILS: FORMER_ADMIN }), adm),
    { ok: false, reason: "delegation" },
    "even if listed again, a delegated-admin demo account is refused"
  );
  const { result } = await quiet(() => demoSessionAllowed(fakeAdmin(), { authUserId: "a-adm", authEmail: FORMER_ADMIN, appEmail: FORMER_ADMIN }, config()));
  assert.equal(result, false, "a session for it (e.g. signed in on /login) gets no app access");
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
    ["project-not-isolated", () => db.user_project_roles.push({ user_id: "u-real", project_id: SECOND_PROJECT, department_id: "dep-b", role: "WORKER", status: "Active" })],
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

test("demo check: any active admin delegation on a demo account is refused — no demo account is an Admin of any kind", async () => {
  for (const [label, projectId, permission] of [
    ["delegation inside the demo project", DEMO_PROJECT, "WORK_ITEM_MANAGEMENT"],
    ["delegation reaching a real project", REAL_PROJECT, "PROJECT_MANAGEMENT"],
    ["user management", DEMO_PROJECT, "USER_MANAGEMENT"],
  ]) {
    seed();
    db.admin_delegations.push({ delegation_id: "d-w", delegate_user_id: "u-w", status: "Active" });
    db.delegation_projects.push({ delegation_id: "d-w", project_id: projectId });
    db.delegation_permissions.push({ delegation_id: "d-w", permission });
    assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker), { ok: false, reason: "delegation" }, label);
  }
  // A revoked delegation doesn't count.
  seed();
  db.admin_delegations.push({ delegation_id: "d-w", delegate_user_id: "u-w", status: "Revoked" });
  assert.equal((await checkDemoAccount(fakeAdmin(), config(), worker)).ok, true);
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
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker, W_SLOT), { ok: false, reason: "delegation" }, "a slot account holding a delegation");
});

test("demo check: presentation projects only — one real member in a configured project refuses every demo account", async () => {
  seed();
  assert.equal((await checkDemoAccount(fakeAdmin(), config(), worker)).ok, true, "real people in other projects don't matter");
  db.user_project_roles.push({ user_id: "u-real", project_id: DEMO_PROJECT, department_id: "dep-el", role: "WORKER", status: "Active" });
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), worker), { ok: false, reason: "project-not-isolated" });
  // An inactive (removed) real membership doesn't count.
  db.user_project_roles[db.user_project_roles.length - 1].status = "Removed";
  assert.equal((await checkDemoAccount(fakeAdmin(), config(), worker)).ok, true);
  assert.deepEqual(await checkDemoAccount(fakeAdmin(), config(), { authUserId: "a-real", email: "real.user@abc.test" }), { ok: false, reason: "not-demo-email" });
});

test("demo check: a failed lookup refuses (fails closed)", async () => {
  for (const table of ["users", "user_project_roles", "admin_delegations"]) {
    seed();
    const r = await checkDemoAccount(fakeAdmin({ failTable: table }), config(), worker);
    assert.deepEqual(r, { ok: false, reason: "lookup-failed" }, table);
  }
});

// ------------------------------------------------------------ the server action

const signInCalls = [];
const signOutScopes = [];
const updateUserCalls = [];
let signInFails = null; // force an error kind on the next sign-in
let sessionUser = null; // what supabase.auth.getUser() answers (lib/session.ts)
let requestHeaders = new Headers();
const otpCalls = [];
const cookieJar = new Map();
const cookieStore = {
  get: (name) => (cookieJar.has(name) ? { name, value: cookieJar.get(name).value } : undefined),
  set: (name, value, options) => cookieJar.set(name, { value, options }),
  delete: (name) => cookieJar.delete(name),
};
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
      verifyOtp: async ({ type, token_hash }) => {
        otpCalls.push({ type, token_hash });
        const email = String(token_hash).replace(/^th:/, "");
        const row = db.users.find((u) => u.user_mail === email);
        return row ? { data: { user: { id: row.auth_user_id, email } }, error: null } : { data: { user: null }, error: { status: 403, code: "otp_expired" } };
      },
      signOut: async (opts) => (signOutScopes.push(opts?.scope ?? "default"), { error: null }),
      getUser: async () => ({ data: { user: sessionUser }, error: null }),
      updateUser: async (attrs) => (updateUserCalls.push(attrs), { data: {}, error: null }),
    },
  }),
});
stubFile(require.resolve(path.join(ROOT, "lib/supabaseAdmin.ts")), {
  getSupabaseServiceRoleClient: () => fakeAdmin(),
});
stubFile(require.resolve("next/headers"), { headers: async () => requestHeaders, cookies: async () => cookieStore });
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
  for (const key of Object.keys(process.env)) if (key.startsWith("DEMO_") || key.startsWith("TEMP_ALTERNATE_ADMIN")) delete process.env[key];
  linkCalls.length = 0;
  otpCalls.length = 0;
  cookieJar.clear();
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

test("Admin door: 'admin' opens the read-only preview as a demo account; 'admin_demo' is refused — never a passwordless real-Admin session", async () => {
  // The Admin door signs in as an ordinary isolated demo account (the first
  // configured slot) and lands on the read-only Admin Setup preview.
  reset();
  assert.deepEqual(await enter({ role: "admin" }), { redirect: "/admin/setup" });
  assert.deepEqual(signInCalls, [{ email: WORKER, password: "pw-worker-1" }], "signs in as a demo account with its server-held password");
  assert.equal(linkCalls.length + otpCalls.length, 0, "no one-time token — never a passwordless real-ADMIN session");

  // A forged legacy key is still just an unknown role.
  reset();
  assert.match((await enter({ role: "admin_demo" })).error, /Choose one of the listed demo roles/);
  assert.deepEqual(signInCalls, [], "admin_demo: no sign-in attempted");
  assert.equal(linkCalls.length + otpCalls.length, 0);
  assert.equal(cookieJar.size, 0);

  // With no demo account configured, the door has nothing to back onto.
  reset({ DEMO_LOGIN_WORKER_ELECTRICAL_EMAIL: "", DEMO_LOGIN_WORKER_ELECTRICAL_PASSWORD: "", DEMO_LOGIN_EMAILS: "demo.viewer@example.com" });
  assert.match((await enter({ role: "admin" })).error, /Choose one of the listed demo roles/);
  assert.deepEqual(signInCalls, [], "no backing account: no sign-in attempted");
});

test("demo action: every trade role goes to /workflow, which routes it to its own dashboard", async () => {
  reset();
  assert.deepEqual(await enter({ role: "worker_electrical" }), { redirect: "/workflow" });
});

test("demo action: refused when a configured project has a real member (presentation data only)", async () => {
  reset();
  db.user_project_roles.push({ user_id: "u-real", project_id: DEMO_PROJECT, department_id: "dep-el", role: "WORKER", status: "Active" });
  assert.match((await enter({ role: "worker_electrical" })).error, /limited to presentation projects/);
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
  // (Another demo email stays configured, so Demo Login itself is still on.)
  const misconfigured = { DEMO_LOGIN_WORKER_ELECTRICAL_EMAIL: "real.user@abc.test", DEMO_LOGIN_WORKER_ELECTRICAL_PASSWORD: "attacker-chosen-1", DEMO_LOGIN_EMAILS: "demo.viewer@example.com" };
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

test("demo action: the per-IP limit applies to one-click entry, on its own counter", async () => {
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
    const { createHash } = require("crypto");
    const ipKey = (name) => `${name}:${createHash("sha256").update("203.0.113.77").digest("hex").slice(0, 32)}`;
    assert.equal(counts.get(ipKey("demo-login-ip")), 31, "counted on the demo counter");
    assert.equal(counts.has(ipKey("login-ip")), false, "the normal sign-in allowance of this IP is untouched");
    assert.ok([...counts.keys()].every((k) => k.startsWith("demo-login-ip:")), "no per-account counter a visitor could exhaust for everyone");
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
  db.user_project_roles.push({ user_id: "u-w", project_id: REAL_PROJECT, department_id: "dep-real", role: "WORKER", status: "Active" });
  assert.equal(await run(config()), false, "real-project role granted after sign-in");
  seed();
  db.admin_delegations.push({ delegation_id: "d-w", delegate_user_id: "u-w", status: "Active" });
  assert.equal(await run(config()), false, "admin delegation (no project) granted after sign-in");
  seed();
  db.user_project_roles.push({ user_id: "u-real", project_id: DEMO_PROJECT, department_id: "dep-el", role: "WORKER", status: "Active" });
  assert.equal(await run(config()), false, "a real person added to the presentation project after sign-in");
  seed();
  assert.equal(await run(config(), { authUserId: "a-x", authEmail: "someone@example.com", appEmail: "someone@example.com" }), false, "an unconfigured @example.com account gets no app access");
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
  assert.deepEqual(await getCurrentUser(), { authUserId: "a-real", userId: "u-real", email: "real.user@abc.test", isDemo: false });
  sessionUser = { id: "a-admin", email: "boss@abc.test" };
  assert.equal((await getCurrentUser()).userId, "u-admin");

  sessionUser = { id: "a-w", email: WORKER };
  assert.equal((await getCurrentUser()).userId, "u-w", "isolated demo session (e.g. signed in on /login)");
  assert.equal((await getCurrentUser()).isDemo, true, "flagged as demo (used only by the emergency read-only switch and logout)");
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
  assert.match(formSrc, /"Sign In"/, "same button wording as the regular sign-in");
  assert.match(formSrc, /Trade \/ Team/, "role, then trade/team");
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

/** Runs fn with the DEMO_LOGIN_READ_ONLY emergency switch on, then restores it. */
async function withReadOnlySwitch(fn) {
  const before = process.env.DEMO_LOGIN_READ_ONLY;
  process.env.DEMO_LOGIN_READ_ONLY = "true";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.DEMO_LOGIN_READ_ONLY;
    else process.env.DEMO_LOGIN_READ_ONLY = before;
  }
}
const WRITES = [
  ["POST", "/api/workflow/worker"],
  ["POST", "/api/workflow/chat"],
  ["PATCH", "/api/admin/work-items"],
  ["PUT", "/api/workflow/task-progress"],
  ["DELETE", "/api/admin/users"],
  ["POST", "/api/admin/projects/import"],
];

test("same application: by default a demo session's writes go on to the route's normal authorization, like anyone's", async () => {
  delete process.env.DEMO_LOGIN_READ_ONLY;
  for (const [method, url] of WRITES) {
    const r = await call(method, url, WORKER);
    assert.equal(r.status, 200, `${method} ${url}`);
    assert.equal(r.headers.get("x-middleware-next"), "1", "passed on to the route, which does its own checks");
  }
});

test("emergency switch DEMO_LOGIN_READ_ONLY=true: every demo write to /api is refused, reads pass", async () => {
  await withReadOnlySwitch(async () => {
    for (const [method, url] of WRITES) {
      const r = await call(method, url, WORKER);
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.match((await r.json()).error, /read-only/);
    }
    const read = await call("GET", "/api/workflow/dashboard", WORKER);
    assert.equal(read.status, 200, "reads pass through");
    assert.equal(claimsCalls.length, 0, "a read costs no auth lookup at all");
  });
});

test("real users' writes are untouched, with or without the switch", async () => {
  for (const on of [false, true]) {
    const run = async () => {
      for (const email of ["real.user@abc.test", "boss@example.org", null]) {
        const r = await call("POST", "/api/workflow/worker", email);
        assert.equal(r.status, 200, String(email));
        assert.equal(r.headers.get("x-middleware-next"), "1", "passed on to the route, which does its own checks");
      }
    };
    if (on) await withReadOnlySwitch(run);
    else await run();
  }
});

// ------------------------------------------------------------ logout and password (app/login/actions.ts)

const loginActions = require("../app/login/actions.ts");
async function runAction(fn) {
  const { result } = await quiet(async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Redirect) return { redirect: err.to };
      throw err;
    }
  });
  return result;
}

test("logout: a shared demo account signs out only this browser and returns to Demo Login", async () => {
  reset();
  sessionUser = { id: "a-w", email: WORKER };
  assert.deepEqual(await runAction(() => loginActions.logout()), { redirect: "/demo-login" });
  assert.deepEqual(signOutScopes, ["local"], "never a global sign-out: other visitors on this role stay signed in");
  sessionUser = null;
});

test("logout: real users sign out exactly as before (Supabase's default scope, back to /login)", async () => {
  for (const user of [{ id: "a-real", email: "real.user@abc.test" }, null]) {
    reset();
    sessionUser = user;
    assert.deepEqual(await runAction(() => loginActions.logout()), { redirect: "/login" });
    assert.deepEqual(signOutScopes, ["default"], "signOut() called with no options, as before");
  }
  sessionUser = null;
});

test("updatePassword: refused for a shared demo account, Supabase never asked; real users unchanged", async () => {
  const fields = { password: "A-new-Passw0rd!", confirmPassword: "A-new-Passw0rd!" };
  reset();
  updateUserCalls.length = 0;
  sessionUser = { id: "a-w", email: WORKER };
  const refused = await runAction(() => loginActions.updatePassword(undefined, form(fields)));
  assert.match(refused.error, /Demo accounts are shared/);
  assert.equal(updateUserCalls.length, 0);

  reset();
  sessionUser = { id: "a-real", email: "real.user@abc.test" };
  assert.deepEqual(await runAction(() => loginActions.updatePassword(undefined, form(fields))), { redirect: "/account" });
  assert.deepEqual(updateUserCalls, [{ password: fields.password }]);
  sessionUser = null;
});

// ------------------------------------------------------------ per-route read-only guard (lib/demoWriteGuard.ts)

const { demoWriteRefusal } = require("../lib/demoWriteGuard.ts");

test("demoWriteRefusal: inactive by default (demo users get the route's normal checks); 403 only with the emergency switch", async () => {
  delete process.env.DEMO_LOGIN_READ_ONLY;
  assert.equal(demoWriteRefusal({ isDemo: true }), null, "default: same application, same authorization");
  await withReadOnlySwitch(async () => {
    const refused = demoWriteRefusal({ isDemo: true });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /read-only/);
    assert.equal(demoWriteRefusal({ isDemo: false }), null);
    assert.equal(demoWriteRefusal(null), null, "no session: the route's own 401 applies");
  });
});

test("every write handler under app/api calls demoWriteRefusal right after its 401 check", () => {
  // A new write route that forgets the guard fails here. bootstrap has no
  // session at all (it only works while no Admin exists — lib/admin.ts),
  // and proxy.ts still refuses it for demo sessions.
  const NO_SESSION = new Set(["admin/bootstrap/route.ts"]);
  const apiDir = path.join(ROOT, "app/api");
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") files.push(full);
    }
  })(apiDir);
  const guardAfter401 =
    /const (\w+) = await getCurrentUser\(\);\s+if \(!\1\) \{\s+return [^\n]*status: 401[^\n]*\s+\}\s+const demoReadOnly = demoWriteRefusal\(\1\);\s+if \(demoReadOnly\) return demoReadOnly;/;
  let guarded = 0;
  for (const file of files) {
    const rel = path.relative(apiDir, file).split(path.sep).join("/");
    const src = fs.readFileSync(file, "utf8");
    for (const h of src.matchAll(/export async function (POST|PUT|PATCH|DELETE)\b/g)) {
      if (NO_SESSION.has(rel)) continue;
      const rest = src.slice(h.index + 1);
      const end = rest.search(/\nexport async function /);
      const body = src.slice(h.index, end === -1 ? undefined : h.index + 1 + end);
      assert.match(body, guardAfter401, `${rel} ${h[1]}`);
      guarded++;
    }
  }
  assert.ok(guarded >= 31, `guarded write handlers: ${guarded}`);
  assert.ok(fs.readFileSync(path.join(ROOT, "proxy.ts"), "utf8").includes('"/api/:path*"'), "proxy still covers every /api route");
});

test("daily summary is a read: GET serves it without the write guard; POST kept and guarded", () => {
  const src = fs.readFileSync(path.join(ROOT, "app/api/workflow/daily-summary/route.ts"), "utf8");
  const get = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));
  assert.match(get, /getCurrentUser\(\)/, "still requires a session");
  assert.doesNotMatch(get, /demoWriteRefusal/);
  const panel = fs.readFileSync(path.join(ROOT, "components/workflow/SupervisorPanel.tsx"), "utf8");
  assert.ok(panel.includes("fetch(`/api/workflow/daily-summary?${params.toString()}`)"), "the dashboard reads it with GET");
});

// ------------------------------------------------------------ Admin Setup: one Admin

test("Admin door: a read-only, demo-scoped Admin preview — account-management stays real-Admin-only", () => {
  const page = fs.readFileSync(path.join(ROOT, "app/admin/setup/page.tsx"), "utf8");
  // A demo session gets a read-only, demo-scoped preview — never real-Admin rights.
  assert.match(page, /const demoAdmin = currentUser\.isDemo && !access\?\.isRealAdmin;/, "the demo preview is gated on the verified demo session, never real-Admin");
  assert.match(page, /demoAdmin \? <ReadOnlyProvider readOnly>/, "the demo preview is always read-only");
  assert.match(page, /resolveAdminSetupAccess\(supabase, userId\)/, "access still resolved the same way for real/delegated callers");
  assert.match(page, /access\?\.isRealAdmin \? listDelegations\(supabase, userId\)/, "the full delegation list stays real-Admin-only");
  assert.match(page, /demoLoginConfig\(\)\.projectIds/, "the demo preview is scoped to the configured (isolated) demo project(s)");
  const delegationSrc = fs.readFileSync(path.join(ROOT, "lib/delegation.ts"), "utf8");
  assert.match(delegationSrc, /export async function resolveAdminSetupAccess[\s\S]*?if \(await isAdminUser\(supabase, userId\)\)/, "real Admin path unchanged");

  const panel = fs.readFileSync(path.join(ROOT, "components/admin/AdminSetupPanel.tsx"), "utf8");
  // The demo preview shows project-management tabs only — never Users or Delegations.
  const demoTabs = panel.match(/const DEMO_ADMIN_TABS: Tab\[\] = \[([^\]]*)\];/);
  assert.ok(demoTabs, "DEMO_ADMIN_TABS is defined");
  assert.doesNotMatch(demoTabs[1], /users|delegations/, "no account-management tabs in the demo preview");
  assert.match(panel, /if \(demoAdmin\) return DEMO_ADMIN_TABS;/, "a demo preview sees only the project-management tabs");
  assert.match(panel, /roleLabel=\{demoAdmin \|\| isRealAdmin \? "Admin" : "Delegated Admin"\}/, "the demo preview shows the same Admin dashboard, no demo label");
  assert.match(panel, /\{isRealAdmin && \(\s*<Link\s+href="\/dev\/extraction-test"/, "developer tool link still real-Admin-only");

  // The Admin door backs onto an ordinary isolated demo account — never a real ADMIN.
  const demoAccess = fs.readFileSync(path.join(ROOT, "lib/demoAccess.ts"), "utf8");
  assert.match(demoAccess, /export const ADMIN_DOOR_KEY = "admin";/);
  assert.match(demoAccess, /adminDoorSlot[\s\S]*?DEMO_SLOTS\.find\(\(slot\) => config\.accounts\.has\(slot\.key\)\)/, "the door backs onto a configured trade slot, not an ADMIN account");

  const form = fs.readFileSync(path.join(ROOT, "components/auth/DemoLoginForm.tsx"), "utf8");
  assert.match(form, /value=\{isAdmin \? ADMIN_DOOR_KEY : selectedKey\}/, "choosing Admin posts the Admin-door key — no password page");
  assert.match(form, /"\/login\?next=\/admin\/setup"/, "a secondary link still lets the real Admin sign in to manage");
});

test("no passwordless session path: the real-Admin shortcut is gone from every caller", () => {
  for (const file of ["app/demo-login/actions.ts", "app/demo-login/page.tsx", "components/auth/DemoLoginForm.tsx", "app/login/actions.ts"]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(src, /alternateAdmin|ALTERNATE_ADMIN|TEMP_ALTERNATE|enterAsAdmin/, file);
  }
  // The demo action creates sessions only with the slot's password.
  const action = fs.readFileSync(path.join(ROOT, "app/demo-login/actions.ts"), "utf8");
  assert.doesNotMatch(action, /generateLink|verifyOtp/);
});

test("demo UI read-only state follows the emergency switch only (off by default)", () => {
  const session = fs.readFileSync(path.join(ROOT, "lib/session.ts"), "utf8");
  assert.match(session, /export async function isDemoSession\(\): Promise<boolean> \{\s+if \(!isDemoReadOnlyMode\(\)\) return false;/);
  const email = fs.readFileSync(path.join(ROOT, "lib/demoEmail.ts"), "utf8");
  assert.match(email, /process\.env\.DEMO_LOGIN_READ_ONLY\?\.trim\(\)\.toLowerCase\(\) === "true"/, "only an explicit true turns it on");
});
