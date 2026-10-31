/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: loads the app's TypeScript through tests/register-ts.cjs. */
// End-to-end login test for every supported role, with disposable accounts
// created through the real account-creation flow:
//   1. a disposable Admin is created with the same function the Admin
//      Setup route uses (createUserWithLogin), then signs in through the
//      real login page;
//   2. that Admin creates one account per Admin Setup role (ADMIN,
//      SUPERVISOR = "Contractor", FOREMAN = "Subcontractor", WORKER)
//      through POST /api/admin/users — user, role and login in one step;
//      MANAGER (also a Contractor, not offered in Admin Setup) is created
//      with the same function directly;
//   3. every account signs in through the login page and is checked:
//      dashboard routing, second request, refresh, logout, another role's
//      dashboard and the role APIs refused, its own allowed;
//   4. plus: wrong password rejected, email case/space normalization, a
//      role change keeps the password, a user without any role assignment
//      is handled safely, and a rejected creation leaves nothing behind.
// Every account it creates is named auth-e2e-<run>-<role>@example.com and
// is deleted at the end (also leftovers of an interrupted run). Passwords
// are random, kept in memory only, never printed.
//
// Writes to the Supabase project in .env.local (shared by local and
// production), so it requires --yes-create-test-accounts. Runs against a
// local app by default (production rate-limits logins):
//   npm run test:auth-e2e -- --app-url http://localhost:3000 --yes-create-test-accounts
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const REPO = path.resolve(__dirname, "..");
// Real settings must win over the test loader's placeholders.
for (const line of fs.readFileSync(path.join(REPO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const APP = (arg("--app-url") ?? "").replace(/\/+$/, "");
if (!APP) stop("--app-url <url of the running app> is required");
if (!process.argv.includes("--yes-create-test-accounts")) {
  stop("this creates and then deletes disposable accounts in the shared Supabase project — add --yes-create-test-accounts");
}
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(APP) && !process.argv.includes("--allow-remote")) {
  stop("runs against a local app by default (production rate-limits logins per IP); add --allow-remote to override");
}

const { getSupabaseServiceRoleClient } = require(path.join(REPO, "lib/supabaseAdmin.ts"));
const { createUserWithLogin } = require(path.join(REPO, "lib/admin.ts"));
const { createServerClient } = require(path.join(REPO, "node_modules/@supabase/ssr"));
const svc = getSupabaseServiceRoleClient();

const PREFIX = "auth-e2e-";
const RUN = Date.now().toString(36);
const emailFor = (label) => `${PREFIX}${RUN}-${label}@example.com`;
const newPassword = () => `${crypto.randomBytes(12).toString("base64url")}-Aa1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const counts = { PASS: 0, FAIL: 0 };
function check(cond, subject, message, detail = "") {
  counts[cond ? "PASS" : "FAIL"]++;
  console.log(`${cond ? "PASS" : "FAIL"} | ${subject.padEnd(10)} | ${message}${detail ? ` — ${detail}` : ""}`);
  return cond;
}
function stop(message) {
  console.error(`STOPPED: ${message}`);
  process.exit(2);
}

// ---------------------------------------------------------------- HTTP helpers

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function get(p, jar, init = {}) {
  const res = await fetch(`${APP}${p}`, { redirect: "manual", ...init, headers: { cookie: cookieHeader(jar), ...(init.headers ?? {}) } });
  const location = res.headers.get("location");
  return { status: res.status, location: location ? new URL(location, APP).pathname : null, text: await res.text() };
}
const postJson = (p, jar, body, method = "POST") =>
  get(p, jar, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The real login form, posted as a browser without JavaScript posts it. */
async function formLogin(email, password) {
  await sleep(1200); // stay well under Supabase Auth's per-IP sign-in limit
  const html = await (await fetch(`${APP}/login`)).text();
  const fd = new FormData();
  for (const m of html.matchAll(/<input type="hidden" name="(\$ACTION[^"]*)"(?: value="([^"]*)")?/g)) {
    fd.append(m[1], (m[2] ?? "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&"));
  }
  fd.append("email", email);
  fd.append("password", password);
  const res = await fetch(`${APP}/login`, { method: "POST", body: fd, redirect: "manual" });
  const jar = new Map();
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (pair.slice(i + 1)) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const error = res.status === 200 ? ((await res.text()).match(/text-error">([^<]+)</)?.[1] ?? null) : null;
  const signedIn = res.status === 303 && [...jar.keys()].some((k) => /-auth-token/.test(k));
  return { status: res.status, signedIn, jar, error: error && error.replace(/&#x27;/g, "'") };
}
function ssrClient(jar) {
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
}

// ---------------------------------------------------------------- clean-up

async function cleanup() {
  const { data: rows } = await svc.from("users").select("user_id, user_mail, auth_user_id").like("user_mail", `${PREFIX}%`);
  let removed = 0;
  for (const r of rows ?? []) {
    if (!r.user_mail.startsWith(PREFIX) || !r.user_mail.endsWith("@example.com")) continue; // only this script's accounts
    await svc.from("user_project_roles").delete().eq("user_id", r.user_id);
    await svc.from("users").delete().eq("user_id", r.user_id);
    if (r.auth_user_id) await svc.auth.admin.deleteUser(r.auth_user_id);
    removed++;
  }
  const { data: auth } = await svc.auth.admin.listUsers({ perPage: 1000 });
  for (const u of auth?.users ?? []) {
    if (u.email?.startsWith(PREFIX) && u.email.endsWith("@example.com")) {
      await svc.auth.admin.deleteUser(u.id);
      removed++;
    }
  }
  return removed;
}

// ---------------------------------------------------------------- the run

const ROLE_HOME_LABEL = { ADMIN: "Admin", SUPERVISOR: "Contractor", MANAGER: "Contractor", FOREMAN: "Subcontractor", WORKER: "Worker" };
const API_ACCESS = {
  "/api/admin/delegations": ["ADMIN"],
  "/api/workflow/foreman": ["FOREMAN"],
  "/api/workflow/supervisor": ["SUPERVISOR", "MANAGER"],
};

async function main() {
  const verifier = await import(pathToFileURL(path.join(REPO, "scripts/verify-auth-accounts.mjs")).href);
  const leftovers = await cleanup();
  if (leftovers) console.log(`(removed ${leftovers} leftover test account(s) from an earlier interrupted run)`);

  const { data: anchor, error: anchorError } = await svc
    .from("user_project_roles").select("project_id, department_id").eq("role", "WORKER").eq("status", "Active").order("created_at").limit(1).single();
  if (anchorError || !anchor) stop("no active Worker department found to create test accounts in");
  const scope = { projectId: anchor.project_id, departmentId: anchor.department_id };

  // 1. Disposable Admin, created with the route's own function.
  const adminAccount = { role: "ADMIN", email: emailFor("bootstrap-admin"), password: newPassword() };
  await createUserWithLogin(svc, svc, { ...scope, email: adminAccount.email, role: "ADMIN", firstName: "AUTH E2E", lastName: "DELETE ME", password: adminAccount.password });
  const adminSession = await formLogin(adminAccount.email, adminAccount.password);
  if (!check(adminSession.signedIn, "ADMIN", "disposable Admin signs in through the login page", adminSession.error ?? `HTTP ${adminSession.status}`)) return;

  // 2. One account per role through the real Admin Setup API.
  console.log("\n== Account creation through POST /api/admin/users (signed in as Admin)");
  const accounts = [];
  for (const role of ["ADMIN", "SUPERVISOR", "FOREMAN", "WORKER"]) {
    const account = { role, email: emailFor(role.toLowerCase()), password: newPassword() };
    const res = await postJson("/api/admin/users", adminSession.jar, { ...scope, email: account.email, role, password: account.password, firstName: "AUTH E2E", lastName: "DELETE ME" });
    let body = {};
    try { body = JSON.parse(res.text); } catch { /* reported below */ }
    if (check(res.status === 200 && body.userCreated && body.loginCreated, role, `${ROLE_HOME_LABEL[role]}: user + role + login created in one request`, `HTTP ${res.status} ${body.error ?? ""}`)) accounts.push(account);
  }
  {
    const account = { role: "MANAGER", email: emailFor("manager"), password: newPassword() };
    await createUserWithLogin(svc, svc, { ...scope, email: account.email, role: "MANAGER", password: account.password });
    accounts.push(account);
    check(true, "MANAGER", "Contractor (MANAGER): created with createUserWithLogin — Admin Setup does not offer this role");
  }
  for (const a of accounts) {
    const { data: row } = await svc.from("users").select("user_id, auth_user_id").eq("user_mail", a.email).single();
    const { data: auth } = await svc.auth.admin.getUserById(row.auth_user_id);
    a.userId = row.user_id;
    check(auth?.user?.email === a.email && !!auth.user.email_confirmed_at, a.role, "exactly one confirmed login, linked to the app user by id");
  }

  // Creation that must be refused leaves nothing behind.
  const refusedEmail = emailFor("refused");
  const refused = await postJson("/api/admin/users", adminSession.jar, { ...scope, email: refusedEmail, role: "WORKER", password: "short" });
  const { data: refusedRows } = await svc.from("users").select("user_id").eq("user_mail", refusedEmail);
  check(refused.status === 400 && (refusedRows ?? []).length === 0, "-", "a new user with an invalid password is refused (400) and nothing is saved", `HTTP ${refused.status}`);

  // 3. Every role, through the login page.
  console.log("\n== Sign-in, routing, session and access per role");
  const identities = new Set();
  for (const a of accounts) {
    const s = await formLogin(a.email, a.password);
    if (!check(s.signedIn, a.role, "correct password signs in through the login page", s.error ?? `HTTP ${s.status}`)) continue;
    const jar = s.jar;
    const [routeLevel, routeMsg] = verifier.evaluateOwnDashboardRouting(await get("/workflow", jar), a.role);
    check(routeLevel === "PASS", a.role, routeMsg);
    const [loadLevel, loadMsg] = verifier.evaluateOwnDashboardLoads(await get(verifier.ROLE_HOME[a.role], jar), a.role);
    check(loadLevel === "PASS", a.role, loadMsg);
    const other = verifier.OTHER_ROLE_PAGE[a.role];
    if (other) {
      const [level, msg] = verifier.evaluateOtherRoleDashboard(await get(other, jar), a.role, other);
      check(level === "PASS", a.role, msg);
    }
    const adminPage = await get("/admin/setup", jar);
    const adminAllowed = adminPage.status === 200 && !/doesn(&#x27;|')t have Admin access/.test(adminPage.text);
    check(adminAllowed === (a.role === "ADMIN"), a.role, a.role === "ADMIN" ? "Admin Setup opens" : "Admin Setup refused (no Admin access)");
    for (const [api, allowed] of Object.entries(API_ACCESS)) {
      const st = (await get(api, jar)).status;
      const ok = allowed.includes(a.role) ? ![401, 403].includes(st) : st === 403;
      check(ok, a.role, `${api} ${allowed.includes(a.role) ? "allowed" : "refused"}`, `HTTP ${st}`);
    }
    const accountPage = await get("/account", jar);
    check(accountPage.status === 200 && accountPage.text.toLowerCase().includes(a.email), a.role, "/account shows this user's own email");
    const ssr = ssrClient(jar);
    const { data: who } = await ssr.auth.getUser();
    if (who?.user) identities.add(who.user.id);
    const before = new Map(jar);
    const { error: refreshError } = await ssr.auth.refreshSession();
    check(!refreshError && (await get("/account", jar)).status === 200, a.role, "session refresh keeps the user signed in");
    await ssr.auth.signOut({ scope: "local" });
    const after = await get("/workflow", before);
    check(after.status >= 300 && after.status < 400 && after.location === "/login", a.role, "after logout the old session cookies are refused", `${after.status} ${after.location ?? ""}`);
  }
  check(identities.size === accounts.length, "-", `session isolation: ${accounts.length} accounts, ${identities.size} distinct identities`);

  // 4. Password and normalization behaviour (disposable Worker only).
  console.log("\n== Password, normalization, role change, missing role");
  const worker = accounts.find((a) => a.role === "WORKER");
  const wrong = await formLogin(worker.email, `${worker.password}x`);
  check(!wrong.signedIn && wrong.error === "Invalid email or password.", "WORKER", "wrong password rejected with \"Invalid email or password.\" and no session", wrong.error ?? `HTTP ${wrong.status}`);
  const upper = await formLogin(`  ${worker.email.toUpperCase()}  `, worker.password);
  check(upper.signedIn, "WORKER", "email typed in UPPERCASE with spaces signs in (normalization)");
  const roleChange = await postJson("/api/admin/users", adminSession.jar, { ...scope, email: worker.email, role: "FOREMAN" });
  let roleBody = {};
  try { roleBody = JSON.parse(roleChange.text); } catch { /* reported below */ }
  check(roleChange.status === 200 && roleBody.userCreated === false && roleBody.loginCreated === false, "WORKER", "adding a role to an existing user creates no new user or login", `HTTP ${roleChange.status}`);
  check((await formLogin(worker.email, worker.password)).signedIn, "WORKER", "same password still works after the role change");

  // A user whose only assignment is removed: signs in, but gets no dashboard or role API.
  const norole = { role: "WORKER", email: emailFor("no-role"), password: newPassword() };
  await postJson("/api/admin/users", adminSession.jar, { ...scope, email: norole.email, role: "WORKER", password: norole.password });
  const { data: noroleUser } = await svc.from("users").select("user_id").eq("user_mail", norole.email).single();
  const { data: assignment } = await svc.from("user_project_roles").select("user_project_role_id").eq("user_id", noroleUser.user_id).single();
  const removal = await postJson("/api/admin/users", adminSession.jar, { userProjectRoleId: assignment.user_project_role_id }, "DELETE");
  check(removal.status === 200, "NO ROLE", "assignment removed through Admin Setup (DELETE /api/admin/users)");
  const nr = await formLogin(norole.email, norole.password);
  check(nr.signedIn, "NO ROLE", "the password still signs in (authentication is not role-dependent)");
  const home = await get("/workflow", nr.jar);
  check(home.status === 200 && !verifier.redirectTarget(home).path && /isn(&#x27;|')t assigned to a project/.test(home.text), "NO ROLE", "/workflow explains the missing assignment instead of an error or a wrong dashboard");
  for (const api of Object.keys(API_ACCESS)) {
    const st = (await get(api, nr.jar)).status;
    check(st === 403, "NO ROLE", `${api} refused`, `HTTP ${st}`);
  }
}

main()
  .catch((err) => check(false, "-", "unexpected error", err.message))
  .finally(async () => {
    const removed = await cleanup().catch((e) => (console.log(`clean-up FAILED: ${e.message}`), -1));
    const { data: left } = await svc.from("users").select("user_id").like("user_mail", `${PREFIX}%`);
    check(removed >= 0 && (left ?? []).length === 0, "-", `clean-up: ${removed} test account(s) removed, none left`);
    console.log(`\nSummary: ${counts.PASS} passed, ${counts.FAIL} failed`);
    console.log(counts.FAIL ? "RESULT: FAIL" : "RESULT: PASS");
    process.exit(counts.FAIL ? 1 : 0);
  });
