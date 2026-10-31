/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Account provisioning and password management (lib/authAccounts.ts), run
// against an in-memory Supabase stand-in that enforces the same rules the
// real one does (unique Auth emails, a login linked to at most one user,
// sign-in only with the stored password). These prove the LOGIC: validate
// first, read back what was written, report per account, never report a
// failure as success. Whether the real accounts work is proven separately,
// against the live project, by scripts/verify-auth-accounts.mjs.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APPROVED_ROLES,
  normalizeEmail,
  emailProblem,
  passwordProblem,
  classifySignInError,
  passwordResetOrigin,
  provisionLogin,
  setPasswordVerified,
  batchProblems,
  runAccountBatch,
  auditAccounts,
} = require("../lib/authAccounts.ts");

// ---------------------------------------------------------------- fake Supabase

function fakeSupabase({ users = [], authUsers = [], roles = [], faults = {} } = {}) {
  const state = {
    users: users.map((u) => ({ status: "Active", auth_user_id: null, ...u })),
    roles,
    auth: authUsers.map((u) => ({ email_confirmed_at: "2026-01-01T00:00:00Z", banned_until: null, ...u })),
    sessions: [], // { userId, revoked }
    signOuts: [],
    writes: [],
    nextId: 1,
  };

  function query(table) {
    const ops = [];
    const filters = (rows) =>
      rows.filter((r) =>
        ops.every(([op, col, v]) => (op === "eq" ? r[col] === v : op === "is" ? r[col] === v : true))
      );
    const run = () => {
      const rows = table === "users" ? state.users : state.roles;
      const update = ops.find(([op]) => op === "update");
      if (update) {
        if (faults.linkError) return { data: null, error: { message: "simulated database error" } };
        if (faults.linkedMeanwhile) {
          filters(rows).forEach((r) => (r.auth_user_id = "someone-else"));
        }
        const hit = filters(rows);
        hit.forEach((r) => Object.assign(r, update[1]));
        state.writes.push({ table, values: update[1], rows: hit.length });
        return { data: hit.map((r) => ({ user_id: r.user_id })), error: null };
      }
      return { data: filters(rows).map((r) => ({ ...r })), error: null };
    };
    const builder = {
      select: () => builder,
      eq: (col, v) => (ops.push(["eq", col, v]), builder),
      is: (col, v) => (ops.push(["is", col, v]), builder),
      update: (values) => (ops.push(["update", values]), builder),
      maybeSingle: async () => {
        const r = run();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  const publicUser = (u) => u && { id: u.id, email: u.email, email_confirmed_at: u.email_confirmed_at, banned_until: u.banned_until };
  const admin = {
    from: query,
    auth: {
      admin: {
        listUsers: async ({ page }) => ({ data: { users: page === 1 ? state.auth.map(publicUser) : [] }, error: null }),
        getUserById: async (id) => {
          const u = state.auth.find((a) => a.id === id);
          return u ? { data: { user: publicUser(u) }, error: null } : { data: { user: null }, error: { message: "User not found" } };
        },
        createUser: async ({ email, password, email_confirm }) => {
          if (faults.createError) return { data: { user: null }, error: { message: "simulated create failure" } };
          if (state.auth.some((a) => a.email === email)) return { data: { user: null }, error: { message: "A user with this email address has already been registered" } };
          const u = { id: `auth-new-${state.nextId++}`, email, password, email_confirmed_at: email_confirm ? "2026-10-31T00:00:00Z" : null, banned_until: null };
          state.auth.push(u);
          return { data: { user: publicUser(u) }, error: null };
        },
        updateUserById: async (id, { password }) => {
          if (faults.updateError) return { data: { user: null }, error: { message: "Password should be at least 6 characters" } };
          const u = state.auth.find((a) => a.id === id);
          if (!u) return { data: { user: null }, error: { message: "User not found" } };
          if (!faults.updateSilentlyIgnored) u.password = password;
          return { data: { user: publicUser(u) }, error: null };
        },
        deleteUser: async (id) => {
          if (faults.rollbackError) return { error: { message: "simulated delete failure" } };
          state.auth = state.auth.filter((a) => a.id !== id);
          return { error: null };
        },
      },
    },
  };

  const signInClient = () => {
    let current = null;
    return {
      auth: {
        signInWithPassword: async ({ email, password }) => {
          if (faults.signInRateLimited) return { data: { user: null, session: null }, error: { name: "AuthApiError", status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" } };
          const u = state.auth.find((a) => a.email === email && a.password === password);
          if (!u) return { data: { user: null, session: null }, error: { name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" } };
          const signedInAs = faults.signInAsOther ? { ...u, id: "auth-other" } : u;
          current = { userId: signedInAs.id, revoked: false };
          state.sessions.push(current);
          return { data: { user: publicUser(signedInAs), session: {} }, error: null };
        },
        signOut: async ({ scope }) => {
          state.signOuts.push(scope);
          if (scope === "global") state.sessions.filter((s) => s.userId === current?.userId).forEach((s) => (s.revoked = true));
          else if (current) current.revoked = true;
          return { error: null };
        },
      },
    };
  };
  return { admin, signInClient, state };
}

const PW = "Unique-Pass-01";
const worker = (over = {}) => ({ user_id: "u-worker", user_mail: "worker@example.com", user_role: "WORKER", ...over });

// ================================================================ A. account creation

test("provision: a valid app user gets exactly one login, linked by id, read back before success", async () => {
  const db = fakeSupabase({ users: [worker()] });
  const r = await provisionLogin(db.admin, { userId: "u-worker", password: PW });
  assert.equal(r.status, "created", r.detail);
  assert.equal(db.state.auth.length, 1);
  assert.equal(db.state.users[0].auth_user_id, db.state.auth[0].id, "profile linked to the new login");
  assert.ok(db.state.auth[0].email_confirmed_at, "login is confirmed");
  assert.ok(!JSON.stringify(r).includes(PW), "result never carries the password");
});

test("provision: running it again is a no-op (idempotent), nothing is created twice", async () => {
  const db = fakeSupabase({ users: [worker()] });
  await provisionLogin(db.admin, { userId: "u-worker", password: PW });
  const again = await provisionLogin(db.admin, { userId: "u-worker", password: "Different-Pass-02" });
  assert.equal(again.status, "unchanged");
  assert.equal(db.state.auth.length, 1);
  assert.equal(db.state.auth[0].password, PW, "existing password untouched");
});

test("provision: an existing unlinked login for the same email is never adopted (no duplicate, no takeover)", async () => {
  const db = fakeSupabase({ users: [worker()], authUsers: [{ id: "auth-stray", email: "worker@example.com", password: "x" }] });
  const r = await provisionLogin(db.admin, { userId: "u-worker", password: PW });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /already exists for this email/);
  assert.equal(db.state.users[0].auth_user_id, null);
  assert.equal(db.state.auth.length, 1);
});

test("provision: invalid email, unapproved role, unknown user id or weak password -> failed, nothing written", async () => {
  const cases = [
    [worker({ user_mail: "not-an-email" }), PW, /format/],
    [worker({ user_mail: "Worker@Example.com" }), PW, /lowercase/],
    [worker({ user_role: "SUPERADMIN" }), PW, /not a role this app supports/],
    [worker(), "short", /at least 8/],
    [worker(), " Leading-space-pw", /space/],
    [worker(), "", /required/],
    [worker(), "worker@example.com", /must not be the email/],
  ];
  for (const [user, password, expected] of cases) {
    const db = fakeSupabase({ users: [user] });
    const r = await provisionLogin(db.admin, { userId: "u-worker", password });
    assert.equal(r.status, "failed", String(expected));
    assert.match(r.detail, expected);
    assert.equal(db.state.auth.length, 0, String(expected));
    assert.deepEqual(db.state.writes, [], String(expected));
  }
  const db = fakeSupabase({ users: [worker()] });
  const r = await provisionLogin(db.admin, { userId: "no-such-user", password: PW });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /no app user/);
});

test("provision: Supabase refusing the login is reported, profile stays unlinked", async () => {
  const db = fakeSupabase({ users: [worker()], faults: { createError: true } });
  const r = await provisionLogin(db.admin, { userId: "u-worker", password: PW });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /refused to create/);
  assert.equal(db.state.users[0].auth_user_id, null);
});

test("provision: if linking fails, the just-created login is removed — no orphaned login left", async () => {
  for (const fault of ["linkError", "linkedMeanwhile"]) {
    const db = fakeSupabase({ users: [worker()], faults: { [fault]: true } });
    const r = await provisionLogin(db.admin, { userId: "u-worker", password: PW });
    assert.equal(r.status, "failed", fault);
    assert.match(r.detail, /removed again/, fault);
    assert.equal(db.state.auth.length, 0, `${fault}: orphan removed`);
  }
  const db = fakeSupabase({ users: [worker()], faults: { linkError: true, rollbackError: true } });
  const r = await provisionLogin(db.admin, { userId: "u-worker", password: PW });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /orphaned login/, "a failed rollback is reported, never hidden");
});

// ================================================================ B. password management

function linkedWorker(password = "Old-Password-1") {
  return fakeSupabase({
    users: [worker({ auth_user_id: "auth-w" })],
    authUsers: [{ id: "auth-w", email: "worker@example.com", password }],
  });
}

test("password: a successful update is proven by signing in with it, then every session is revoked", async () => {
  const db = linkedWorker();
  const old = db.signInClient();
  await old.auth.signInWithPassword({ email: "worker@example.com", password: "Old-Password-1" });
  const r = await setPasswordVerified(db.admin, db.signInClient, { email: "Worker@Example.com ", password: PW });
  assert.equal(r.status, "updated", r.detail);
  assert.equal(db.state.auth[0].password, PW);
  assert.ok(db.state.sessions.every((s) => s.revoked), "old-password session and verification session both revoked");
  assert.ok(db.state.signOuts.includes("global"));
  assert.ok(!JSON.stringify(r).includes(PW));
});

test("password: Supabase refusing the update -> failed, never reported as success", async () => {
  const db = fakeSupabase({ users: [worker({ auth_user_id: "auth-w" })], authUsers: [{ id: "auth-w", email: "worker@example.com", password: "Old-Password-1" }], faults: { updateError: true } });
  const r = await setPasswordVerified(db.admin, db.signInClient, { email: "worker@example.com", password: PW });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /refused the new password/);
});

test("password: an update Supabase accepted but that does not actually work is caught by the sign-in proof", async () => {
  const db = fakeSupabase({ users: [worker({ auth_user_id: "auth-w" })], authUsers: [{ id: "auth-w", email: "worker@example.com", password: "Old-Password-1" }], faults: { updateSilentlyIgnored: true } });
  const r = await setPasswordVerified(db.admin, db.signInClient, { email: "worker@example.com", password: PW });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /signing in with it failed \(invalid_credentials\).*UNVERIFIED: the old password no longer works/);
});

test("password: unknown email, unlinked user, missing login and wrong mapping -> failed, password never sent", async () => {
  const cases = [
    [fakeSupabase({ users: [worker({ auth_user_id: "auth-w" })], authUsers: [{ id: "auth-w", email: "worker@example.com" }] }), "nobody@example.com", /no app user/],
    [fakeSupabase({ users: [worker()] }), "worker@example.com", /no login yet/],
    [fakeSupabase({ users: [worker({ auth_user_id: "auth-gone" })] }), "worker@example.com", /no longer exists/],
    [fakeSupabase({ users: [worker({ auth_user_id: "auth-x" })], authUsers: [{ id: "auth-x", email: "someone.else@example.com" }] }), "worker@example.com", /different email/],
    [fakeSupabase({ users: [worker(), worker({ user_id: "u-dup" })] }), "worker@example.com", /more than one app user/],
  ];
  for (const [db, email, expected] of cases) {
    let updated = false;
    const orig = db.admin.auth.admin.updateUserById;
    db.admin.auth.admin.updateUserById = async (...a) => ((updated = true), orig(...a));
    const r = await setPasswordVerified(db.admin, db.signInClient, { email, password: PW });
    assert.equal(r.status, "failed", String(expected));
    assert.match(r.detail, expected);
    assert.equal(updated, false, `${expected}: no update attempted`);
  }
});

test("password: a sign-in that lands on a different login than the profile's is a mapping failure", async () => {
  const db = fakeSupabase({ users: [worker({ auth_user_id: "auth-w" })], authUsers: [{ id: "auth-w", email: "worker@example.com", password: "x" }], faults: { signInAsOther: true } });
  const r = await setPasswordVerified(db.admin, db.signInClient, { email: "worker@example.com", password: PW });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /different login/);
});

test("password: a rate-limited proof sign-in is reported as rate limited, not as a wrong password", async () => {
  const db = fakeSupabase({ users: [worker({ auth_user_id: "auth-w" })], authUsers: [{ id: "auth-w", email: "worker@example.com", password: "x" }], faults: { signInRateLimited: true } });
  const r = await setPasswordVerified(db.admin, db.signInClient, { email: "worker@example.com", password: PW });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /rate_limited.*old password no longer works.*in a few minutes/);
});

test("bulk: a batch that fails halfway reports exactly which accounts succeeded and which failed", async () => {
  const db = fakeSupabase({
    users: [
      worker({ user_id: "u1", user_mail: "one@example.com", auth_user_id: "a1" }),
      worker({ user_id: "u2", user_mail: "two@example.com" }), // no login -> fails
      worker({ user_id: "u3", user_mail: "three@example.com", auth_user_id: "a3" }),
    ],
    authUsers: [{ id: "a1", email: "one@example.com", password: "x" }, { id: "a3", email: "three@example.com", password: "y" }],
  });
  const items = [
    { email: "one@example.com", password: "Unique-Pass-11" },
    { email: "two@example.com", password: "Unique-Pass-22" },
    { email: "three@example.com", password: "Unique-Pass-33" },
  ];
  const out = await runAccountBatch(items, (i) => setPasswordVerified(db.admin, db.signInClient, i));
  assert.equal(out.complete, false);
  assert.equal(out.succeeded, 2);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.results.map((r) => [r.email, r.status]), [["one@example.com", "updated"], ["two@example.com", "failed"], ["three@example.com", "updated"]]);
});

test("bulk: an operation that throws becomes that account's failure, the rest still run", async () => {
  const out = await runAccountBatch([{ email: "a@example.com" }, { email: "b@example.com" }], async (i) => {
    if (i.email === "a@example.com") throw new Error("boom");
    return { email: i.email, status: "updated", detail: "ok" };
  });
  assert.equal(out.complete, false);
  assert.deepEqual(out.results.map((r) => r.status), ["failed", "updated"]);
});

test("bulk: duplicate emails or a password shared by two accounts reject the whole batch up front", () => {
  assert.deepEqual(batchProblems([{ email: "a@example.com", password: "P-1-unique" }, { email: "b@example.com", password: "P-2-unique" }]), []);
  assert.equal(batchProblems([{ email: "a@example.com" }, { email: " A@example.com" }]).length, 1);
  const shared = batchProblems([{ email: "a@example.com", password: "Same-Pass-1" }, { email: "b@example.com", password: "Same-Pass-1" }]);
  assert.equal(shared.length, 1);
  assert.match(shared[0], /share one password/);
  assert.ok(!shared[0].includes("Same-Pass-1"), "the shared password is not echoed");
});

// ================================================================ audit

test("audit: flags missing logins, unlinked/orphan logins, duplicates and missing role assignments — never an unusual domain", async () => {
  const db = fakeSupabase({
    users: [
      worker({ user_id: "ok", user_mail: "ok@example.com", auth_user_id: "a-ok" }),
      worker({ user_id: "nologin", user_mail: "nologin@example.com" }),
      worker({ user_id: "typo", user_mail: "typo@gamil.com", user_role: "FOREMAN", auth_user_id: "a-typo" }),
      worker({ user_id: "admin", user_mail: "admin@example.com", user_role: "ADMIN", auth_user_id: "a-admin" }),
      worker({ user_id: "norole", user_mail: "norole@example.com", auth_user_id: "a-norole" }),
    ],
    authUsers: [
      { id: "a-ok", email: "ok@example.com" },
      { id: "a-typo", email: "typo@gamil.com" },
      { id: "a-admin", email: "admin@example.com" },
      { id: "a-norole", email: "norole@example.com" },
      { id: "a-orphan", email: "orphan@example.com" },
    ],
    roles: [
      { user_id: "ok", role: "WORKER", status: "Active" },
      { user_id: "typo", role: "FOREMAN", status: "Active" },
    ],
  });
  const { accounts, globalProblems } = await auditAccounts(db.admin);
  const by = Object.fromEntries(accounts.map((a) => [a.email, a]));
  assert.deepEqual(by["ok@example.com"].problems, []);
  assert.deepEqual(by["admin@example.com"].problems, [], "Admins need no project assignment");
  assert.match(by["nologin@example.com"].problems.join(), /MISSING LOGIN/);
  assert.deepEqual(by["typo@gamil.com"].problems, [], "a valid, linked @gamil.com account is not flagged");
  assert.match(by["norole@example.com"].problems.join(), /no active project\/department role/);
  assert.ok(globalProblems.some((p) => p.startsWith("orphan@example.com") && /not linked/.test(p)));
});

// ================================================================ C. sign-in error classification

test("classification: real Supabase error shapes map to the right failure kind", () => {
  // Shapes recorded from the live Supabase API on 2026-10-31.
  assert.equal(classifySignInError({ name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" }), "invalid_credentials");
  assert.equal(classifySignInError({ name: "AuthApiError", status: 401, message: "Invalid API key" }), "app_key_rejected");
  assert.equal(classifySignInError({ name: "AuthRetryableFetchError", status: 0, message: "fetch failed" }), "unavailable");
  assert.equal(classifySignInError({ name: "AuthApiError", status: 429, code: "over_request_rate_limit", message: "x" }), "rate_limited");
  assert.equal(classifySignInError({ name: "AuthApiError", status: 400, code: "email_not_confirmed", message: "Email not confirmed" }), "email_not_confirmed");
  assert.equal(classifySignInError({ name: "AuthRetryableFetchError", status: 504, message: "Gateway Timeout" }), "unavailable");
});

// ================================================================ validation basics

test("validation: emails are normalized and checked; roles limited to the approved set", () => {
  assert.equal(normalizeEmail("  Site.Lead@Example-Builders.COM "), "site.lead@example-builders.com");
  assert.equal(emailProblem("site.lead@example-builders.com"), null);
  assert.equal(emailProblem("someone@gmail.com"), null);
  assert.equal(emailProblem("someone@gamil.com"), null, "unusual domains are valid (owner-confirmed)");
  assert.match(emailProblem(""), /required/);
  assert.deepEqual([...APPROVED_ROLES].sort(), ["ADMIN", "FOREMAN", "SUPERVISOR", "WORKER"]);
  assert.equal(passwordProblem("A".repeat(72)), null);
  assert.match(passwordProblem("A".repeat(73)), /72 bytes/);
});

// ================================================================ F. reset link origin

test("reset links: never localhost in a Vercel deployment, never from the request", () => {
  assert.deepEqual(passwordResetOrigin({ NEXT_PUBLIC_SITE_URL: "https://app.example.com/some/path" }), { origin: "https://app.example.com", source: "NEXT_PUBLIC_SITE_URL" });
  assert.equal(
    passwordResetOrigin({ VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "construction-extraction-test.vercel.app", VERCEL_URL: "construction-extraction-test-abc123.vercel.app" }).origin,
    "https://construction-extraction-test.vercel.app",
    "production uses the production domain, not the per-deployment URL"
  );
  assert.equal(passwordResetOrigin({ VERCEL: "1", VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "proj-git-branch.vercel.app", VERCEL_URL: "proj-abc.vercel.app" }).origin, "https://proj-git-branch.vercel.app");
  assert.equal(passwordResetOrigin({}).origin, "http://localhost:3000", "local development only");
  assert.throws(() => passwordResetOrigin({ NEXT_PUBLIC_SITE_URL: "not a url" }), "a malformed setting fails loudly instead of emailing a broken link");
});

test("audit/provision: the internal Extraction Test record needs no login, may never get one", async () => {
  const { extractionTestWorkerEmail } = require("../lib/authAccounts.ts");
  const systemEmail = extractionTestWorkerEmail({});
  const db = fakeSupabase({ users: [worker({ user_id: "sys", user_mail: systemEmail })] });
  const { accounts } = await auditAccounts(db.admin, { systemEmails: [systemEmail] });
  assert.deepEqual(accounts[0].problems, []);
  assert.equal(accounts[0].system, true);
  const r = await provisionLogin(db.admin, { userId: "sys", password: PW });
  assert.equal(r.status, "failed");
  assert.equal(db.state.auth.length, 0);

  const linked = fakeSupabase({ users: [worker({ user_id: "sys", user_mail: systemEmail, auth_user_id: "a-sys" })], authUsers: [{ id: "a-sys", email: systemEmail }] });
  const audit = await auditAccounts(linked.admin, { systemEmails: [systemEmail] });
  assert.match(audit.accounts[0].problems.join(), /must not have a login/);
});

// ================================================================ account files (scripts)

test("account file: refused inside the repo, BOM accepted, parse errors never echo the content", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { loadAccountFile } = require("../scripts/accountFile.mjs");
  const ROOT = path.resolve(__dirname, "..");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "acct-"));
  try {
    const good = path.join(outside, "creds.json");
    fs.writeFileSync(good, "\uFEFF" + JSON.stringify([{ email: "a@example.com", password: "Secret-Value-77" }]));
    assert.deepEqual(loadAccountFile(good, ROOT).items, [{ email: "a@example.com", password: "Secret-Value-77" }]);

    const bad = path.join(outside, "bad.json");
    fs.writeFileSync(bad, 'Secret-Value-77", "email": "a@example.com"}]');
    const r = loadAccountFile(bad, ROOT);
    assert.match(r.error, /not valid JSON/);
    assert.ok(!r.error.includes("Secret"), "no file content in the message");

    assert.match(loadAccountFile(path.join(outside, "missing.json"), ROOT).error, /could not read/);
    fs.writeFileSync(good, "[]");
    assert.match(loadAccountFile(good, ROOT).error, /non-empty/);

    for (const inside of ["creds.json", "..creds.json", "scripts/creds.json"]) {
      assert.match(loadAccountFile(path.join(ROOT, inside), ROOT).error, /inside the repository/, inside);
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("account file: .gitignore also blocks typical credentials file names", () => {
  const { execFileSync } = require("child_process");
  for (const name of ["auth-check.json", "my-credentials.json", "scripts/credentials.json"]) {
    const out = execFileSync("git", ["check-ignore", name], { cwd: require("path").resolve(__dirname, "..") }).toString().trim();
    assert.equal(out, name);
  }
});

test("roles: an existing MANAGER (Contractor) account is valid and can be given a login; new users still only get the four Admin Setup roles", async () => {
  const { SUPPORTED_ROLES } = require("../lib/authAccounts.ts");
  assert.ok(SUPPORTED_ROLES.includes("MANAGER"));
  assert.ok(!APPROVED_ROLES.includes("MANAGER"), "creation list unchanged");
  const db = fakeSupabase({ users: [worker({ user_id: "m", user_mail: "manager@example.com", user_role: "MANAGER" })], roles: [{ user_id: "m", role: "MANAGER", status: "Active" }] });
  assert.deepEqual((await auditAccounts(db.admin)).accounts[0].problems, ["MISSING LOGIN — this user cannot sign in"]);
  assert.equal((await provisionLogin(db.admin, { userId: "m", password: PW })).status, "created");
});
