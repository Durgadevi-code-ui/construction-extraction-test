/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Dashboard-routing judgement in scripts/verify-auth-accounts.mjs. Pages in
// this app redirect from inside a streamed render (app/loading.tsx), so
// Next.js answers HTTP 200 and carries the redirect as a
// <meta id="__next-page-redirect"> tag; proxy.ts redirects with real HTTP
// 3xx. The verifier must read both — and must never count a plain 200 as
// a redirect. The fixture below is the exact tag the running app produced
// for GET / on 2026-10-31.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");

const SCRIPT = path.resolve(__dirname, "../scripts/verify-auth-accounts.mjs");
const load = () => import(pathToFileURL(SCRIPT).href);

const pageRedirect = (to) =>
  `<!DOCTYPE html><html><head><meta charSet="utf-8"/><meta id="__next-page-redirect" http-equiv="refresh" content="1;url=${to}"/></head><body><div class="loader"></div><script>self.__next_f.push([1,"NEXT_REDIRECT;replace;${to};307;"])</script></body></html>`;
const ok200 = (body = "<html><body><h1>Dashboard</h1></body></html>") => ({ status: 200, location: null, text: body });
const http = (status, location) => ({ status, location, text: "" });
const page = (to) => ({ status: 200, location: null, text: pageRedirect(to) });

test("redirects: an HTTP Location header redirect is read", async () => {
  const { redirectTarget } = await load();
  assert.deepEqual(redirectTarget(http(307, "/admin/setup")), { via: "HTTP redirect", path: "/admin/setup" });
  assert.deepEqual(redirectTarget(http(303, "http://localhost:3000/workflow?x=1")), { via: "HTTP redirect", path: "/workflow" });
});

test("redirects: a Next.js page-level meta redirect is read", async () => {
  const { redirectTarget } = await load();
  assert.deepEqual(redirectTarget(page("/admin/setup")), { via: "page redirect", path: "/admin/setup" });
  assert.deepEqual(redirectTarget(page("/workflow?next=%2Fa&amp;b=1")), { via: "page redirect", path: "/workflow" });
});

test("redirects: a plain 200, a foreign meta refresh or a 3xx without Location is not a redirect", async () => {
  const { redirectTarget } = await load();
  assert.deepEqual(redirectTarget(ok200()), { via: null, path: null });
  assert.deepEqual(redirectTarget(ok200('<meta http-equiv="refresh" content="0;url=/admin/setup">')), { via: null, path: null }, "only Next's own tag id counts");
  assert.deepEqual(redirectTarget(http(307, null)), { via: null, path: null });
  assert.deepEqual(redirectTarget({ status: 500, location: null, text: pageRedirect("/admin/setup") }), { via: null, path: null }, "an error page is never a redirect");
});

test("own dashboard: PASS only for a redirect to exactly that role's dashboard", async () => {
  const { evaluateOwnDashboardRouting } = await load();
  // The reported case: Admin at /workflow got HTTP 200 carrying a page redirect.
  assert.equal(evaluateOwnDashboardRouting(page("/admin/setup"), "ADMIN")[0], "PASS");
  assert.equal(evaluateOwnDashboardRouting(http(307, "/admin/setup"), "ADMIN")[0], "PASS");
  for (const [role, home] of [["WORKER", "/workflow/worker"], ["FOREMAN", "/workflow/foreman"], ["SUPERVISOR", "/workflow/supervisor"]]) {
    assert.equal(evaluateOwnDashboardRouting(page(home), role)[0], "PASS", role);
  }
});

test("own dashboard: a missing redirect is FAIL", async () => {
  const { evaluateOwnDashboardRouting } = await load();
  const [level, message] = evaluateOwnDashboardRouting(ok200(), "ADMIN");
  assert.equal(level, "FAIL");
  assert.match(message, /expected a redirect to \/admin\/setup, got HTTP 200 with no redirect/);
  assert.equal(evaluateOwnDashboardRouting(http(500, null), "WORKER")[0], "FAIL");
});

test("own dashboard: a redirect to the wrong destination is FAIL", async () => {
  const { evaluateOwnDashboardRouting } = await load();
  for (const [res, role] of [
    [page("/workflow/foreman"), "SUPERVISOR"], // e.g. a multi-role user landing on the other role
    [page("/workflow/worker"), "ADMIN"],
    [http(307, "/login"), "WORKER"],
    [page("/admin/setup/extra"), "ADMIN"], // exact match, not prefix
  ]) {
    const [level, message] = evaluateOwnDashboardRouting(res, role);
    assert.equal(level, "FAIL", `${role} -> ${message}`);
    assert.match(message, /^ROLE — expected a redirect to /);
  }
  assert.equal(evaluateOwnDashboardRouting(page("/admin/setup"), "SUPERADMIN")[0], "FAIL", "unknown role has no dashboard");
  // MANAGER is a Contractor like SUPERVISOR (lib/authContext.ts CONTRACTOR_ROLES).
  assert.equal(evaluateOwnDashboardRouting(page("/workflow/supervisor"), "MANAGER")[0], "PASS");
  assert.equal(evaluateOwnDashboardRouting(page("/workflow/worker"), "MANAGER")[0], "FAIL");
});

test("own dashboard load: must render, not redirect away; Admin page must grant access", async () => {
  const { evaluateOwnDashboardLoads } = await load();
  assert.equal(evaluateOwnDashboardLoads(ok200(), "WORKER")[0], "PASS");
  assert.equal(evaluateOwnDashboardLoads(page("/workflow"), "WORKER")[0], "FAIL", "a 200 that is really a redirect is not a loaded dashboard");
  assert.equal(evaluateOwnDashboardLoads(http(307, "/login"), "WORKER")[0], "FAIL");
  // React renders the apostrophe as &#x27; (checked with react-dom/server);
  // the denial must be recognised in every spelling.
  for (const apostrophe of ["&#x27;", "&#39;", "&apos;", "'"]) {
    const [level, message] = evaluateOwnDashboardLoads(ok200(`<p>Your account doesn${apostrophe}t have Admin access, and no active administrative delegation was found.</p>`), "ADMIN");
    assert.equal(level, "FAIL", apostrophe);
    assert.match(message, /no Admin access/);
  }
  assert.equal(evaluateOwnDashboardLoads(ok200("<h1>Admin Setup</h1><p>Users</p>"), "ADMIN")[0], "PASS");
});

test("cross-role: PASS only when sent to exactly /workflow; a plain 200 is unauthorized access (FAIL)", async () => {
  const { evaluateOtherRoleDashboard } = await load();
  assert.equal(evaluateOtherRoleDashboard(page("/workflow"), "WORKER", "/workflow/foreman")[0], "PASS");
  assert.equal(evaluateOtherRoleDashboard(http(307, "/workflow"), "WORKER", "/workflow/foreman")[0], "PASS");

  const [level, message] = evaluateOtherRoleDashboard(ok200(), "WORKER", "/workflow/foreman");
  assert.equal(level, "FAIL");
  assert.match(message, /WORKER could open \/workflow\/foreman/);

  for (const res of [page("/workflow/foreman"), page("/admin/setup"), http(307, "/login"), page("/workflow/worker")]) {
    assert.equal(evaluateOtherRoleDashboard(res, "FOREMAN", "/workflow/worker")[0], "FAIL", JSON.stringify(res.location ?? res.text.slice(80, 140)));
  }
  assert.equal(evaluateOtherRoleDashboard(http(500, null), "WORKER", "/workflow/foreman")[0], "WARN", "an error page is neither access nor proof of refusal");
});

test("self-test: passes on the real Next.js page redirect for /, fails when it cannot be read", async () => {
  const { evaluateRedirectSelfTest } = await load();
  assert.equal(evaluateRedirectSelfTest(page("/workflow"))[0], "PASS");
  assert.equal(evaluateRedirectSelfTest(http(307, "/workflow"))[0], "PASS");
  for (const res of [ok200(), page("/login"), http(500, null)]) {
    const [level, message] = evaluateRedirectSelfTest(res);
    assert.equal(level, "FAIL");
    assert.match(message, /role routing checks cannot be trusted/);
  }
});

test("role maps match the app's routing", async () => {
  const { ROLE_HOME, OTHER_ROLE_PAGE } = await load();
  const workflowPage = fs.readFileSync(path.resolve(__dirname, "../app/workflow/page.tsx"), "utf8");
  for (const target of Object.values(ROLE_HOME)) assert.ok(workflowPage.includes(`redirect("${target}")`), target);
  for (const [role, other] of Object.entries(OTHER_ROLE_PAGE)) assert.notEqual(other, ROLE_HOME[role], role);
});

test("script: importing it runs nothing; running it directly does (also with a lowercase drive letter)", async () => {
  await load(); // would print sections / exit the test process if main() ran
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  try {
    const envFile = path.join(dir, "empty.env");
    fs.writeFileSync(envFile, "UNRELATED=1\n");
    const variants = [SCRIPT];
    if (process.platform === "win32") variants.push(SCRIPT.charAt(0).toLowerCase() + SCRIPT.slice(1));
    for (const scriptPath of variants) {
      const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", scriptPath, "--env", envFile], { encoding: "utf8" });
      assert.match(r.stdout, /== 1\. Configuration/, scriptPath);
      assert.match(r.stdout, /FAIL \| NEXT_PUBLIC_SUPABASE_URL \| missing/, scriptPath);
      assert.equal(r.status, 1, scriptPath);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("admin-access text: matched as the real page renders it (React escapes the apostrophe)", () => {
  const React = require("react");
  const { renderToString } = require("react-dom/server");
  const html = renderToString(React.createElement("p", null, "Your account doesn't have Admin access, and no active administrative delegation was found."));
  assert.match(html, /doesn&#x27;t/, "fixture really is escaped");
  return load().then(({ evaluateOwnDashboardLoads }) => assert.equal(evaluateOwnDashboardLoads(ok200(html), "ADMIN")[0], "FAIL"));
});

// ================================================================ account status columns

const acct = (over = {}) => ({ email: "a@example.com", role: "WORKER", system: false, hasLogin: true, activeAssignments: ["WORKER"], problems: [], ...over });

test("status: missing login, missing role and untested password are separate columns", async () => {
  const { accountStatus } = await load();
  assert.deepEqual(accountStatus(acct({ hasLogin: false }), null), { login: "MISSING LOGIN", role: "OK", credentials: "n/a" });
  assert.deepEqual(accountStatus(acct({ hasLogin: false, activeAssignments: [] }), null), { login: "MISSING LOGIN", role: "NO ROLE ASSIGNMENT", credentials: "n/a" });
  assert.deepEqual(accountStatus(acct({ activeAssignments: [] }), null), { login: "LINKED", role: "NO ROLE ASSIGNMENT", credentials: "UNVERIFIED" });
  assert.deepEqual(accountStatus(acct({ role: "ADMIN", activeAssignments: [] }), null), { login: "LINKED", role: "OK", credentials: "UNVERIFIED" }, "Admins need no assignment");
  assert.deepEqual(accountStatus(acct({ system: true, hasLogin: false }), null), { login: "NO LOGIN (BY DESIGN)", role: "n/a", credentials: "n/a" });
});

test("status: an account not in the credentials file is UNVERIFIED — never a password failure", async () => {
  const { accountStatus } = await load();
  assert.equal(accountStatus(acct(), null).credentials, "UNVERIFIED");
});

test("status: VERIFIED only when every check passed; failures are classified, rate limits/outages are not judged", async () => {
  const { accountStatus } = await load();
  const ok = { lines: [["PASS", "signed in through the login page"], ["PASS", "routed to the WORKER dashboard"]] };
  assert.equal(accountStatus(acct(), ok).credentials, "VERIFIED");
  assert.equal(accountStatus(acct(), { lines: [["FAIL", "INVALID CREDENTIALS — the login exists and is confirmed, but Supabase rejected this password"]] }).credentials, "INVALID CREDENTIALS");
  assert.equal(accountStatus(acct(), { lines: [["FAIL", 'RATE LIMITED — "Too many" Password NOT judged.']] }).credentials, "RATE LIMITED (not judged)");
  assert.equal(accountStatus(acct(), { lines: [["FAIL", "INFRASTRUCTURE — Supabase unreachable"]] }).credentials, "SERVICE PROBLEM (not judged)");
  assert.equal(accountStatus(acct(), { lines: [["PASS", "signed in"], ["FAIL", "ROLE — expected a redirect to /workflow/worker"]] }).credentials, "SIGNED IN, CHECK FAILED");
  assert.equal(accountStatus(acct(), { lines: [["PASS", "signed in"], ["WARN", "can open Admin Setup"]] }).credentials, "VERIFIED", "a warning is not a failure");
});
