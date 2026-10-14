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
  });
  assert.ok(!sourceFiles().some((rel) => /["']magiclink["']/.test(read(rel))), "no magic-link sign-in");
});

// ===================================================== ordinary login still enforced

const signInCalls = [];
let signOutCalls = 0;
let signInResult = { data: null, error: { message: "Invalid login credentials" } };
let linkedProfile = null;

stubFile(require.resolve(path.join(ROOT, "lib/supabaseServer.ts")), {
  createSupabaseServerClient: async () => ({
    auth: {
      signInWithPassword: async (creds) => (signInCalls.push(creds), signInResult),
      signOut: async () => (signOutCalls++, { error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
    },
  }),
});
stubFile(require.resolve(path.join(ROOT, "lib/supabaseAdmin.ts")), {
  getSupabaseServiceRoleClient: () => ({
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: linkedProfile, error: null }) };
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

const { login, requestPasswordReset } = require("../app/login/actions.ts");

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
function reset() {
  signInCalls.length = 0;
  signOutCalls = 0;
  signInResult = { data: null, error: { message: "Invalid login credentials" } };
  linkedProfile = null;
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
