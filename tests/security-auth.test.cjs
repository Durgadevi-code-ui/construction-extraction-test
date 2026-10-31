/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Authentication tests: demo login is gone, and the only ways to get a
// session are a correct password for a linked account (app/login/actions.ts)
// or a Supabase-emailed link (app/auth/confirm/route.ts). The real login
// server actions run with only Supabase, next/headers and next/navigation
// replaced by in-memory stubs (no network, no database). Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");

// Set as a misconfigured Preview deployment would have them: none of this
// may enable anything any more.
process.env.DEMO_MODE = "true";
process.env.DEMO_MODE_ALLOW_PRODUCTION = "true";
process.env.DEMO_USER_ADMIN_EMAIL = "demo-admin@example.com";
delete process.env.RATE_LIMIT_BACKEND;
delete process.env.VERCEL_ENV;

/** Makes `require(file)` return `exports` instead of the real module. */
function stubFile(file, exports) {
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}

/** All .ts/.tsx source files under the app's code directories. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(dir);
  return [...out, "proxy.ts", "next.config.ts"];
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ===================================================== demo login removed

test("demo login: the demo modules no longer exist", () => {
  for (const rel of ["lib/demoAuth.ts", "app/login/demoActions.ts", "components/auth/DemoLoginPanel.tsx"]) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, rel);
  }
  assert.throws(() => require("../lib/demoAuth.ts"), { code: "MODULE_NOT_FOUND" });
  assert.throws(() => require("../app/login/demoActions.ts"), { code: "MODULE_NOT_FOUND" });
});

test("demo login: no code reads DEMO_* variables or renders demo identities", () => {
  const offenders = sourceFiles().filter((rel) =>
    /DEMO_MODE|DEMO_USER_|demoLogin|demoAuth|DemoLoginPanel|Enter Demo/.test(read(rel))
  );
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(read("app/login/page.tsx"), /demo/i, "login page has no demo UI or messaging");
});

test("sessions: only a password sign-in or a Supabase-emailed link can create one", () => {
  // Every call that can mint or install a Supabase session. generateLink
  // (what demo login used) must not appear anywhere: it issues a sign-in
  // token for any email without that user's involvement.
  const SESSION_CALL = /\.(signInWithPassword|signInWithOtp|signInAnonymously|signInWithIdToken|signInWithOAuth|signInWithSSO|verifyOtp|setSession|exchangeCodeForSession|generateLink)\(/g;
  const found = {};
  for (const rel of sourceFiles()) {
    const calls = [...read(rel).matchAll(SESSION_CALL)].map((m) => m[1]);
    if (calls.length > 0) found[rel] = [...new Set(calls)].sort();
  }
  assert.deepEqual(found, {
    "app/auth/confirm/route.ts": ["verifyOtp"],
    "app/login/actions.ts": ["signInWithPassword"],
    // setPasswordVerified's proof sign-in with the password it just set;
    // that session is revoked immediately (asserted below).
    "lib/authAccounts.ts": ["signInWithPassword"],
  });
  assert.ok(!sourceFiles().some((rel) => /["']magiclink["']/.test(read(rel))), "no magic-link sign-in");
  // The password-setting operation is for the operator script only, never
  // reachable from a page, route or component.
  const appCallers = sourceFiles().filter((rel) => rel !== "lib/authAccounts.ts" && /setPasswordVerified/.test(read(rel)));
  assert.deepEqual(appCallers, []);
});

// ===================================================== ordinary login still enforced

const signInCalls = [];
let signOutCalls = 0;
const signOutScopes = [];
const resetCalls = [];
let updateUserResult = { data: {}, error: null };
let signInResult = { data: null, error: { message: "Invalid login credentials" } };
let linkedProfile = null;
let profileLookupError = null;

stubFile(require.resolve(path.join(ROOT, "lib/supabaseServer.ts")), {
  createSupabaseServerClient: async () => ({
    auth: {
      signInWithPassword: async (creds) => (signInCalls.push(creds), signInResult),
      signOut: async (opts) => (signOutCalls++, signOutScopes.push(opts?.scope ?? "default"), { error: null }),
      resetPasswordForEmail: async (email, opts) => (resetCalls.push(opts), { data: {}, error: null }),
      updateUser: async () => updateUserResult,
    },
  }),
});
stubFile(require.resolve(path.join(ROOT, "lib/supabaseAdmin.ts")), {
  getSupabaseServiceRoleClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: profileLookupError ? null : linkedProfile, error: profileLookupError }) };
      return q;
    },
    rpc: async () => ({ data: null, error: { message: "not used: rate limiting is off in tests" } }),
  }),
});
stubFile(require.resolve("next/headers"), {
  headers: async () => new Headers(),
  cookies: async () => ({ getAll: () => [], set() {} }),
});
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

const { login, requestPasswordReset, updatePassword } = require("../app/login/actions.ts");

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
function reset() {
  signInCalls.length = 0;
  signOutCalls = 0;
  signOutScopes.length = 0;
  resetCalls.length = 0;
  updateUserResult = { data: {}, error: null };
  signInResult = { data: null, error: { message: "Invalid login credentials" } };
  linkedProfile = null;
  profileLookupError = null;
}

test("login: a demo identity without a password is refused before Supabase is asked", async () => {
  reset();
  // What the old demo form posted, and the configured demo email alone.
  assert.equal((await login(undefined, form({ role: "admin_all" }))).error, "Enter a valid email address.");
  assert.equal((await login(undefined, form({ email: "demo-admin@example.com" }))).error, "Password is required.");
  assert.equal(
    (await login(undefined, form({ email: "demo-admin@example.com", password: "", role: "admin_all" }))).error,
    "Password is required."
  );
  assert.equal(signInCalls.length, 0);
});

test("login: a wrong password is refused with the generic message and no session", async () => {
  reset();
  const r = await login(undefined, form({ email: "demo-admin@example.com", password: "guess" }));
  assert.equal(r.error, "Invalid email or password.");
  assert.deepEqual(signInCalls, [{ email: "demo-admin@example.com", password: "guess" }]);
});

test("login: only Supabase's invalid_credentials answer reads as a wrong password", async () => {
  const cases = [
    [{ name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" }, /^Invalid email or password\.$/],
    [{ name: "AuthApiError", status: 400, code: "email_not_confirmed", message: "Email not confirmed" }, /confirm your email/],
    [{ name: "AuthApiError", status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" }, /Too many sign-in attempts/],
    [{ name: "AuthRetryableFetchError", status: 0, message: "fetch failed" }, /temporarily unavailable/],
    [{ name: "AuthRetryableFetchError", status: 503, message: "Service Unavailable" }, /temporarily unavailable/],
    [{ name: "AuthApiError", status: 401, message: "Invalid API key" }, /not available right now/],
  ];
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(JSON.stringify(args));
  try {
    for (const [error, expected] of cases) {
      reset();
      signInResult = { data: { user: null, session: null }, error };
      const r = await login(undefined, form({ email: "someone@example.com", password: "secret-pw-123" }));
      assert.match(r.error, expected, error.code ?? error.name);
    }
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.length > 0, "non-credential failures are logged server-side");
  assert.ok(logged.every((line) => !line.includes("someone@example.com") && !line.includes("secret-pw-123")), "logs never carry the email or password");
});

test("login: a correct password for an account with no app profile is signed straight back out", async () => {
  reset();
  signInResult = { data: { user: { id: "auth-1" } }, error: null };
  const r = await login(undefined, form({ email: "someone@example.com", password: "right" }));
  assert.match(r.error, /isn't linked to an application account/);
  assert.equal(signOutCalls, 1);
});

test("login: a correct password for a linked account still signs in", async () => {
  reset();
  signInResult = { data: { user: { id: "auth-1" } }, error: null };
  linkedProfile = { user_id: "user-1" };
  await assert.rejects(login(undefined, form({ email: "someone@example.com", password: "right" })), { to: "/workflow" });
  await assert.rejects(
    login(undefined, form({ email: "someone@example.com", password: "right", next: "https://evil.example/" })),
    { to: "/workflow" },
    "off-site next is ignored"
  );
  assert.equal(signOutCalls, 0);
});

test("password reset: still answers generically for any email", async () => {
  reset();
  const r = await requestPasswordReset(undefined, form({ email: "demo-admin@example.com" }));
  assert.match(r.message, /If an account exists/);
});

test("password reset: the emailed link points at the production domain on Vercel, never localhost", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    Object.assign(process.env, { VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "construction-extraction-test.vercel.app" });
    reset();
    await requestPasswordReset(undefined, form({ email: "someone@example.com" }));
    assert.equal(resetCalls[0].redirectTo, "https://construction-extraction-test.vercel.app/auth/confirm?next=/auth/update-password");

    process.env.NEXT_PUBLIC_SITE_URL = "https://construction.example.com";
    reset();
    await requestPasswordReset(undefined, form({ email: "someone@example.com" }));
    assert.match(resetCalls[0].redirectTo, /^https:\/\/construction\.example\.com\/auth\/confirm\?/);
  } finally {
    for (const k of ["NEXT_PUBLIC_SITE_URL", "VERCEL", "VERCEL_ENV", "VERCEL_PROJECT_PRODUCTION_URL"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("password change: weak or mismatched passwords are refused; success ends every other session", async () => {
  reset();
  assert.match((await updatePassword(undefined, form({ password: "short", confirmPassword: "short" }))).error, /at least 8/);
  assert.match((await updatePassword(undefined, form({ password: "Good-Pass-1 ", confirmPassword: "Good-Pass-1 " }))).error, /space/);
  assert.match((await updatePassword(undefined, form({ password: "Good-Pass-1", confirmPassword: "Good-Pass-2" }))).error, /do not match/);
  assert.equal(signOutCalls, 0);

  await assert.rejects(updatePassword(undefined, form({ password: "Good-Pass-1", confirmPassword: "Good-Pass-1" })), { to: "/account" });
  assert.deepEqual(signOutScopes, ["others"], "other sessions revoked, this one kept");

  reset();
  updateUserResult = { data: {}, error: { message: "expired" } };
  assert.match((await updatePassword(undefined, form({ password: "Good-Pass-1", confirmPassword: "Good-Pass-1" }))).error, /expired/);
  assert.equal(signOutCalls, 0, "nothing revoked when the change failed");
});

test("login: the email is normalized (trim + lowercase) exactly like account creation", async () => {
  reset();
  await login(undefined, form({ email: "  Site.Lead@Example-Builders.COM ", password: "whatever-1" }));
  assert.deepEqual(signInCalls, [{ email: "site.lead@example-builders.com", password: "whatever-1" }]);
});

test("login: a database error after a CORRECT password is 'temporarily unavailable', never 'not linked'", async () => {
  reset();
  signInResult = { data: { user: { id: "auth-1" } }, error: null };
  linkedProfile = { user_id: "user-1" };
  profileLookupError = { code: "57014", message: "canceling statement due to statement timeout" };
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(JSON.stringify(args));
  let r;
  try {
    r = await login(undefined, form({ email: "someone@example.com", password: "right-pass-1" }));
  } finally {
    console.error = originalError;
  }
  assert.match(r.error, /temporarily unavailable.*\(ref [0-9a-f]{8}\)/);
  assert.doesNotMatch(r.error, /isn't linked|Invalid email or password/);
  assert.deepEqual(signOutScopes, ["local"], "the half-open session is closed");
  const ref = r.error.match(/ref ([0-9a-f]{8})/)[1];
  assert.ok(logged.some((l) => l.includes(ref)), "the same ref is in the server log");
  assert.ok(logged.every((l) => !l.includes("someone@example.com") && !l.includes("right-pass-1")));
});

test("login: non-credential failures carry a reference id that matches the server log", async () => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(JSON.stringify(args));
  try {
    for (const error of [
      { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" },
      { name: "AuthApiError", status: 429, code: "over_request_rate_limit", message: "x" },
      { name: "AuthApiError", status: 401, message: "Invalid API key" },
    ]) {
      reset();
      signInResult = { data: { user: null, session: null }, error };
      const r = await login(undefined, form({ email: "someone@example.com", password: "pw-123456" }));
      const ref = r.error.match(/\(ref ([0-9a-f]{8})\)$/)?.[1];
      assert.ok(ref, r.error);
      assert.ok(logged.some((l) => l.includes(ref)), `${error.name} ${error.status}: ref logged`);
    }
    reset();
    signInResult = { data: { user: null, session: null }, error: { name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" } };
    assert.equal((await login(undefined, form({ email: "someone@example.com", password: "pw-123456" }))).error, "Invalid email or password.", "wrong password stays exactly the generic message (no ref, nothing to enumerate)");
  } finally {
    console.error = originalError;
  }
});

test("roles: a user with several assignments always gets the same one (oldest first)", async () => {
  const { getUserContext } = require("../lib/authContext.ts");
  const calls = [];
  const rows = [
    { user_id: "u", role: "FOREMAN", project_id: "p", department_id: "d1", projects: { project_name: "P" }, departments: { department_name: "D1" } },
    { user_id: "u", role: "SUPERVISOR", project_id: "p", department_id: "d2", projects: { project_name: "P" }, departments: { department_name: "D2" } },
  ];
  const q = {
    select: (...a) => (calls.push(["select", ...a]), q),
    eq: (...a) => (calls.push(["eq", ...a]), q),
    order: (...a) => (calls.push(["order", ...a]), q),
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  const ctx = await getUserContext({ from: () => q }, "u");
  assert.deepEqual(calls.filter((c) => c[0] === "order"), [
    ["order", "created_at", { ascending: true }],
    ["order", "user_project_role_id", { ascending: true }],
  ]);
  assert.equal(ctx.role, "FOREMAN", "first row of the ordered result");
});
