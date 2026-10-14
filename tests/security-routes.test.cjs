/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Route-level security tests: the real Next.js route handlers, with only
// the session and Supabase modules replaced by in-memory stubs (no
// network, no database). Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");

/** Makes `require("@/<rel>")` (and relative requires of the same file)
 * return `exports` instead of the real module. */
function stubModule(rel, exports) {
  const file = require.resolve(path.join(ROOT, rel));
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}

// ---- stubs -------------------------------------------------------------
let currentUser = null;
stubModule("lib/session.ts", {
  getCurrentUser: async () => currentUser,
  requireCurrentUser: async () => currentUser,
});

/** Chainable PostgREST-style mock: records every query; awaiting resolves
 * to respond(table, calls). Storage calls are recorded too. */
function mockSupabase(respond = () => ({ data: null, error: null })) {
  const log = [];
  const storageLog = [];
  return {
    log,
    storageLog,
    from(table) {
      const calls = [];
      log.push({ table, calls });
      const builder = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            const result = respond(table, calls);
            return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
          }
          return (...args) => {
            calls.push([prop, ...args]);
            return builder;
          };
        },
      });
      return builder;
    },
    storage: {
      from(bucket) {
        return {
          upload: async (p) => (storageLog.push(["upload", bucket, p]), { error: null }),
          remove: async (paths) => (storageLog.push(["remove", bucket, ...paths]), { error: null }),
        };
      },
    },
    rpc: async () => ({ data: null, error: { message: "rpc not stubbed" } }),
  };
}

let supabase = mockSupabase();
stubModule("lib/supabaseAdmin.ts", { getSupabaseServiceRoleClient: () => supabase });

const { NextRequest } = require("next/server");
const rateLimit = require("../lib/rateLimit.ts");
const { createReviewToken } = require("../lib/submissionReviewToken.ts");

const USER_A = { authUserId: "auth-a", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "a@x" };
const USER_B = { authUserId: "auth-b", userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "b@x" };
const SUBMISSION = "5ab5ab5a-5ab5-45ab-85ab-5ab5ab5ab5ab";

function jsonRequest(url, body, headers = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const touched = (db) => db.log.length > 0 || db.storageLog.length > 0;

// ===================================================== /api/user-validation
const userValidation = require("../app/api/user-validation/route.ts");

function validationDb({ found = true, status = "PENDING_REVIEW", updatedRows = 1 } = {}) {
  return mockSupabase((table, calls) => {
    if (calls.some((c) => c[0] === "update")) {
      return { data: Array.from({ length: updatedRows }, () => ({ extraction_submission_id: SUBMISSION })), error: null };
    }
    return found ? { data: { validation_status: "VALID", submission_status: status }, error: null } : { data: null, error: { message: "0 rows" } };
  });
}
const updates = (db) => db.log.filter((q) => q.calls.some((c) => c[0] === "update"));

test("user-validation: no session -> 401 and no database access", async () => {
  currentUser = null;
  supabase = validationDb();
  const res = await userValidation.POST(jsonRequest("/api/user-validation", { submissionId: SUBMISSION, decision: "valid" }));
  assert.equal(res.status, 401);
  assert.ok(!touched(supabase));
});

test("user-validation: a submission id alone (no token) -> 403 and no database access", async () => {
  currentUser = USER_A;
  supabase = validationDb();
  const res = await userValidation.POST(jsonRequest("/api/user-validation", { submissionId: SUBMISSION, decision: "valid" }));
  assert.equal(res.status, 403);
  assert.ok(!touched(supabase));
});

test("user-validation: another user's token, a token for another submission, or a forged/expired one -> 403, no update", async () => {
  currentUser = USER_B;
  const longAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const forged = createReviewToken(SUBMISSION, USER_A.userId).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  for (const reviewToken of [
    createReviewToken(SUBMISSION, USER_A.userId), // issued to user A
    createReviewToken("00000000-0000-4000-8000-000000000000", USER_B.userId), // other submission
    createReviewToken(SUBMISSION, USER_B.userId, longAgo), // expired
    forged,
    "9999999999.not-a-real-signature",
    12345,
  ]) {
    supabase = validationDb();
    const res = await userValidation.POST(jsonRequest("/api/user-validation", { submissionId: SUBMISSION, reviewToken, decision: "invalid" }));
    assert.equal(res.status, 403, String(reviewToken));
    assert.ok(!touched(supabase), "no query for " + String(reviewToken));
  }
});

test("user-validation: the submitter's own token -> 200 and only a pipeline-status row is updated", async () => {
  currentUser = USER_A;
  supabase = validationDb();
  const reviewToken = createReviewToken(SUBMISSION, USER_A.userId);
  const res = await userValidation.POST(jsonRequest("/api/user-validation", { submissionId: SUBMISSION, reviewToken, decision: "valid" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { submissionId: SUBMISSION, userValidation: "valid" });
  const update = supabase.log.find((q) => q.calls.some((c) => c[0] === "update"));
  assert.ok(update, "update issued");
  assert.deepEqual(update.calls.find((c) => c[0] === "update")[1], { submission_status: "ACCEPTED" });
  assert.ok(update.calls.some((c) => c[0] === "eq" && c[1] === "extraction_submission_id" && c[2] === SUBMISSION));
  assert.ok(update.calls.some((c) => c[0] === "eq" && c[1] === "submission_status" && c[2] === "PENDING_REVIEW"),
    "only an undecided pipeline row can change (never a Worker SUBMITTED row)");
});

test("user-validation: replaying the same decision is a no-op; a different decision or a lost race -> 409, never a second update", async () => {
  currentUser = USER_A;
  const reviewToken = createReviewToken(SUBMISSION, USER_A.userId);
  const send = (decision) => userValidation.POST(jsonRequest("/api/user-validation", { submissionId: SUBMISSION, reviewToken, decision }));

  supabase = validationDb({ status: "ACCEPTED" });
  assert.equal((await send("valid")).status, 200, "retry of the same decision");
  assert.equal(updates(supabase).length, 0);

  supabase = validationDb({ status: "ACCEPTED" });
  const flip = await send("invalid");
  assert.equal(flip.status, 409, "accepted -> rejected via replayed token");
  assert.match((await flip.json()).error, /already been decided/);
  assert.equal(updates(supabase).length, 0);

  supabase = validationDb({ status: "PENDING_REVIEW", updatedRows: 0 });
  assert.equal((await send("valid")).status, 409, "decided concurrently");
});

test("user-validation: a Worker SUBMITTED row (filtered out) -> 404, never updated", async () => {
  currentUser = USER_A;
  supabase = validationDb({ found: false });
  const reviewToken = createReviewToken(SUBMISSION, USER_A.userId);
  const res = await userValidation.POST(jsonRequest("/api/user-validation", { submissionId: SUBMISSION, reviewToken, decision: "valid" }));
  assert.equal(res.status, 404);
  assert.ok(!supabase.log.some((q) => q.calls.some((c) => c[0] === "update")));
});

// ======================================================== rate limiting
/** Deterministic in-memory store with an injectable clock (tests only —
 * production uses the shared Postgres counter). */
function memoryStore(clock) {
  const windows = new Map();
  return {
    async hit(key, windowSeconds) {
      const now = clock();
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + windowSeconds * 1000 };
        windows.set(key, w);
      }
      w.count += 1;
      return { count: w.count, resetAt: new Date(w.resetAt) };
    },
  };
}

const RULE = { name: "t", limit: 3, windowSeconds: 60, failClosed: true };

test("rate limit: allowed up to the limit, then refused with retry time, then reset after the window", async () => {
  let now = Date.UTC(2026, 0, 1);
  rateLimit.setRateLimitStoreForTests(memoryStore(() => now));
  const at = () => new Date(now);
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual(await rateLimit.checkRateLimit(RULE, "u1", at), { allowed: true });
    now += 15_000;
    assert.deepEqual(await rateLimit.checkRateLimit(RULE, "u1", at), { allowed: false, reason: "limited", retryAfterSeconds: 45 });
    // Separate identifiers and separate rules have separate counters.
    assert.deepEqual(await rateLimit.checkRateLimit(RULE, "u2", at), { allowed: true });
    assert.deepEqual(await rateLimit.checkRateLimit({ ...RULE, name: "other" }, "u1", at), { allowed: true });
    now += 46_000;
    assert.deepEqual(await rateLimit.checkRateLimit(RULE, "u1", at), { allowed: true });
  } finally {
    rateLimit.setRateLimitStoreForTests(undefined);
  }
});

test("rate limit: counter unavailable -> fail-closed rules refuse (503), fail-open rules allow", async () => {
  rateLimit.setRateLimitStoreForTests({ hit: async () => { throw new Error("down"); } });
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await rateLimit.checkRateLimit(RULE, "u"), { allowed: false, reason: "unavailable", retryAfterSeconds: 30 });
    assert.deepEqual(await rateLimit.checkRateLimit({ ...RULE, failClosed: false }, "u"), { allowed: true });
    const res = await rateLimit.rateLimitResponse(RULE, "u");
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "30");
  } finally {
    console.error = original;
    rateLimit.setRateLimitStoreForTests(undefined);
  }
});

test("rate limit: not configured -> disabled (local development keeps working)", async () => {
  const saved = process.env.RATE_LIMIT_BACKEND;
  delete process.env.RATE_LIMIT_BACKEND;
  const original = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < 10; i++) assert.deepEqual(await rateLimit.checkRateLimit(RULE, "u"), { allowed: true });
  } finally {
    console.warn = original;
    if (saved !== undefined) process.env.RATE_LIMIT_BACKEND = saved;
  }
});

test("rate limit: RATE_LIMIT_BACKEND=supabase uses the shared rate_limit_hit RPC; a missing migration fails closed", async () => {
  process.env.RATE_LIMIT_BACKEND = "supabase";
  const original = console.error;
  console.error = () => {};
  try {
    const rpcCalls = [];
    supabase = mockSupabase();
    supabase.rpc = async (fn, args) => {
      rpcCalls.push([fn, args]);
      return { data: [{ hit_count: 4, reset_at: new Date(Date.now() + 20_000).toISOString() }], error: null };
    };
    const limited = await rateLimit.checkRateLimit(RULE, "user-1");
    assert.equal(limited.allowed, false);
    assert.equal(limited.reason, "limited");
    assert.equal(rpcCalls[0][0], "rate_limit_hit");
    assert.match(rpcCalls[0][1].p_key, /^t:[0-9a-f]{32}$/, "identifier is hashed, never stored raw");
    assert.ok(!rpcCalls[0][1].p_key.includes("user-1"));

    supabase.rpc = async () => ({ data: null, error: { message: "function public.rate_limit_hit does not exist" } });
    assert.equal((await rateLimit.checkRateLimit(RULE, "user-1")).reason, "unavailable");
  } finally {
    console.error = original;
    delete process.env.RATE_LIMIT_BACKEND;
  }
});

test("rate limit: client IP comes only from platform-set headers", () => {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1", "x-real-ip": "203.0.113.10" });
  const saved = { VERCEL: process.env.VERCEL, TRUST: process.env.RATE_LIMIT_TRUST_PROXY_HEADERS };
  try {
    delete process.env.VERCEL;
    delete process.env.RATE_LIMIT_TRUST_PROXY_HEADERS;
    assert.equal(rateLimit.clientIp(headers), "unknown", "client-supplied headers ignored off-platform");
    process.env.VERCEL = "1";
    assert.equal(rateLimit.clientIp(headers), "203.0.113.9");
    assert.equal(rateLimit.clientIp(new Headers({ "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "1.1.1.1" })), "198.51.100.7");
    assert.equal(rateLimit.clientIp(new Headers()), "unknown");
  } finally {
    if (saved.VERCEL === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.VERCEL;
    if (saved.TRUST === undefined) delete process.env.RATE_LIMIT_TRUST_PROXY_HEADERS; else process.env.RATE_LIMIT_TRUST_PROXY_HEADERS = saved.TRUST;
  }
});

test("rate limit: messages are user-facing and keep the { error } shape", async () => {
  assert.equal(rateLimit.rateLimitMessage({ allowed: false, reason: "limited", retryAfterSeconds: 45 }), "Too many requests. Please wait 45 seconds and try again.");
  assert.equal(rateLimit.rateLimitMessage({ allowed: false, reason: "limited", retryAfterSeconds: 61 }), "Too many requests. Please wait 2 minutes and try again.");
  let now = Date.now();
  rateLimit.setRateLimitStoreForTests(memoryStore(() => now));
  try {
    const rule = { ...RULE, limit: 0 };
    const res = await rateLimit.rateLimitResponse(rule, "u");
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "60");
    assert.match((await res.json()).error, /^Too many requests/);
  } finally {
    rateLimit.setRateLimitStoreForTests(undefined);
  }
});

test("rate limit: extraction route answers 429 before any AI work or database write", async () => {
  const text = require("../app/api/text/route.ts");
  currentUser = USER_A;
  let now = Date.now();
  rateLimit.setRateLimitStoreForTests(memoryStore(() => now));
  try {
    supabase = mockSupabase();
    for (let i = 0; i < rateLimit.RATE_LIMITS.extraction.limit; i++) {
      await rateLimit.checkRateLimit(rateLimit.RATE_LIMITS.extraction, USER_A.userId);
    }
    const res = await text.POST(jsonRequest("/api/text", { text: "Poured 20 m3 of concrete" }));
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    assert.ok(!touched(supabase));
    // Another user is unaffected by user A's limit (the request then
    // proceeds to normal validation: over-length text -> 400).
    currentUser = USER_B;
    const other = await text.POST(jsonRequest("/api/text", { text: "x".repeat(50_001) }));
    assert.equal(other.status, 400);
    assert.match((await other.json()).error, /too long/);
    assert.ok(!touched(supabase), "rejected before any database work");
  } finally {
    rateLimit.setRateLimitStoreForTests(undefined);
  }
});

test("rate limit: unauthenticated Admin bootstrap is capped per client IP", async () => {
  const bootstrap = require("../app/api/admin/bootstrap/route.ts");
  let now = Date.now();
  rateLimit.setRateLimitStoreForTests(memoryStore(() => now));
  process.env.VERCEL = "1";
  try {
    supabase = mockSupabase();
    const req = (ip) => jsonRequest("/api/admin/bootstrap", {}, { "x-forwarded-for": ip });
    for (let i = 0; i < rateLimit.RATE_LIMITS.bootstrap.limit; i++) {
      assert.equal((await bootstrap.POST(req("203.0.113.1"))).status, 400); // allowed through to validation
    }
    assert.equal((await bootstrap.POST(req("203.0.113.1"))).status, 429);
    assert.equal((await bootstrap.POST(req("203.0.113.2"))).status, 400, "a different IP is unaffected");
  } finally {
    delete process.env.VERCEL;
    rateLimit.setRateLimitStoreForTests(undefined);
  }
});

// ====================================================== upload validation
const liveUpdates = require("../app/api/workflow/live-updates/route.ts");

function uploadRequest(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest("http://localhost/api/workflow/live-updates", { method: "POST", body: form });
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");

test("live-update upload: bad content, MIME mismatch, oversize and long captions are rejected before storage", async () => {
  currentUser = USER_A;
  const cases = [
    ["HTML labelled image/png", { type: "PHOTO", file: new File([HTML], "x.png", { type: "image/png" }) }],
    ["PNG labelled audio/webm", { type: "VOICE", file: new File([PNG], "x.webm", { type: "audio/webm" }) }],
    ["SVG type", { type: "PHOTO", file: new File([HTML], "x.svg", { type: "image/svg+xml" }) }],
    ["photo over 10MB", { type: "PHOTO", file: new File([PNG, new Uint8Array(10 * 1024 * 1024)], "big.png", { type: "image/png" }) }],
    ["caption over limit", { type: "PHOTO", caption: "x".repeat(1001), file: new File([PNG], "x.png", { type: "image/png" }) }],
    ["unknown type", { type: "VIDEO", file: new File([PNG], "x.png", { type: "image/png" }) }],
  ];
  for (const [name, fields] of cases) {
    supabase = mockSupabase();
    const res = await liveUpdates.POST(uploadRequest(fields));
    assert.equal(res.status, 400, name);
    assert.equal(supabase.storageLog.length, 0, `${name}: nothing stored`);
  }
});

test("live-update upload: a valid photo at exactly the size limit passes validation; if saving the row fails the file is removed", async () => {
  currentUser = USER_A;
  // Every DB read returns nothing -> createLiveUpdate refuses (no Worker
  // assignment), which happens after the upload.
  supabase = mockSupabase(() => ({ data: null, error: null }));
  const exact = new Uint8Array(10 * 1024 * 1024);
  exact.set(PNG);
  const res = await liveUpdates.POST(uploadRequest({ type: "PHOTO", file: new File([exact], "site.png", { type: "image/png" }) }));
  assert.notEqual(res.status, 200);
  const uploaded = supabase.storageLog.find((e) => e[0] === "upload");
  assert.ok(uploaded, "accepted for upload");
  assert.ok(uploaded[2].startsWith(`${USER_A.userId}/`), "stored under the caller's own id");
  assert.ok(supabase.storageLog.some((e) => e[0] === "remove" && e[2] === uploaded[2]), "orphan removed");
});

test("live-update upload: no session -> 401 before the body is read", async () => {
  currentUser = null;
  supabase = mockSupabase();
  const res = await liveUpdates.POST(uploadRequest({ type: "PHOTO", file: new File([PNG], "x.png", { type: "image/png" }) }));
  assert.equal(res.status, 401);
  assert.ok(!touched(supabase));
});

test("extraction routes: no session -> 401 for text, voice and handwritten", async () => {
  currentUser = null;
  for (const name of ["text", "voice", "handwritten"]) {
    supabase = mockSupabase();
    const route = require(`../app/api/${name}/route.ts`);
    const res = await route.POST(jsonRequest(`/api/${name}`, {}));
    assert.equal(res.status, 401, name);
    assert.ok(!touched(supabase), name);
  }
});

test("rate limit config: on by default only in Vercel production; RATE_LIMIT_BACKEND overrides everywhere", () => {
  const b = rateLimit.rateLimitBackend;
  assert.equal(b({}), "off", "local development");
  assert.equal(b({ VERCEL_ENV: "preview" }), "off", "preview");
  assert.equal(b({ VERCEL_ENV: "production" }), "supabase", "production default");
  assert.equal(b({ VERCEL_ENV: "production", RATE_LIMIT_BACKEND: "off" }), "off", "explicit kill switch");
  assert.equal(b({ RATE_LIMIT_BACKEND: " Supabase " }), "supabase", "explicit opt-in elsewhere");
});

// ===================================================== /api/admin/users (POST)
// A role assignment's department must belong to its project (finding M1):
// a whole-project USER_MANAGEMENT delegation matches any departmentId, so
// without this a delegate could pair their project with another project's
// department.
const adminUsers = require("../app/api/admin/users/route.ts");

const P1 = "11111111-0000-4000-8000-000000000001";
const P2 = "11111111-0000-4000-8000-000000000002";
const D1_IN_P1 = "22222222-0000-4000-8000-000000000001";
const D2_IN_P2 = "22222222-0000-4000-8000-000000000002";
const DEPARTMENT_PROJECT = { [D1_IN_P1]: P1, [D2_IN_P2]: P2 };

/** actor: "admin", "delegate" (SUPERVISOR with a whole-project
 * USER_MANAGEMENT delegation on P1) or "contractor" (no delegation). */
function usersDb(actor) {
  return mockSupabase((table, calls) => {
    const eq = (col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];
    const has = (method) => calls.some((c) => c[0] === method);
    if (table === "users") {
      if (eq("user_role") === "ADMIN") return { data: actor === "admin" ? { user_id: USER_A.userId } : null, error: null };
      if (has("insert")) return { data: { user_id: "new-user" }, error: null };
      return { data: null, error: null }; // no existing account for the email
    }
    if (table === "user_project_roles") {
      if (has("insert")) return { data: null, error: null };
      if (has("maybeSingle")) return { data: null, error: null }; // no existing assignment
      return {
        data: [{ user_id: USER_A.userId, role: "SUPERVISOR", project_id: P1, department_id: D1_IN_P1, projects: { project_name: "P1" }, departments: { department_name: "D1" } }],
        error: null,
      };
    }
    if (table === "admin_delegations") {
      if (actor !== "delegate") return { data: [], error: null };
      const day = 24 * 60 * 60 * 1000;
      return {
        data: [{
          delegation_id: "del-1",
          status: "Active",
          starts_at: new Date(Date.now() - day).toISOString(),
          ends_at: new Date(Date.now() + day).toISOString(),
          delegation_projects: [{ project_id: P1 }],
          delegation_departments: [], // whole-project scope
          delegation_permissions: [{ permission: "USER_MANAGEMENT" }],
        }],
        error: null,
      };
    }
    if (table === "departments") {
      const projectId = DEPARTMENT_PROJECT[eq("department_id")];
      return projectId ? { data: { project_id: projectId }, error: null } : { data: null, error: { message: "0 rows" } };
    }
    return { data: null, error: null };
  });
}
const writes = (db) => db.log.filter((q) => q.calls.some((c) => ["insert", "update", "upsert", "delete"].includes(c[0])));
const roleInserts = (db) =>
  db.log.filter((q) => q.table === "user_project_roles" && q.calls.some((c) => c[0] === "insert")).map((q) => q.calls.find((c) => c[0] === "insert")[1]);
const createUser = (body) => adminUsers.POST(jsonRequest("/api/admin/users", { email: "new@x", role: "WORKER", ...body }));

test("admin users: a department from another project is rejected (400) for a whole-project delegate, nothing written", async () => {
  currentUser = USER_A;
  supabase = usersDb("delegate");
  const res = await createUser({ projectId: P1, departmentId: D2_IN_P2, role: "SUPERVISOR" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /does not belong to the selected project/);
  assert.deepEqual(writes(supabase), []);
});

test("admin users: a mismatched project/department pair is rejected (400) for a real Admin too, nothing written", async () => {
  currentUser = USER_A;
  supabase = usersDb("admin");
  const res = await createUser({ projectId: P1, departmentId: D2_IN_P2 });
  assert.equal(res.status, 400);
  assert.deepEqual(writes(supabase), []);
});

test("admin users: an unknown department is refused, nothing written", async () => {
  currentUser = USER_A;
  supabase = usersDb("admin");
  const res = await createUser({ projectId: P1, departmentId: "33333333-0000-4000-8000-000000000000" });
  assert.notEqual(res.status, 200);
  assert.deepEqual(writes(supabase), []);
});

test("admin users: matching pairs still work for a real Admin and a whole-project delegate", async () => {
  for (const [actor, projectId, departmentId] of [
    ["admin", P1, D1_IN_P1],
    ["admin", P2, D2_IN_P2],
    ["delegate", P1, D1_IN_P1],
  ]) {
    currentUser = USER_A;
    supabase = usersDb(actor);
    const res = await createUser({ projectId, departmentId });
    assert.equal(res.status, 200, `${actor} ${projectId}`);
    assert.deepEqual(
      roleInserts(supabase).map((r) => [r.project_id, r.department_id, r.role]),
      [[projectId, departmentId, "WORKER"]],
      actor
    );
  }
});

test("admin users: authorization is unchanged — no session 401, delegate creating an Admin 403, outside scope or undelegated refused", async () => {
  currentUser = null;
  supabase = usersDb("admin");
  assert.equal((await createUser({ projectId: P1, departmentId: D1_IN_P1 })).status, 401);
  assert.ok(!touched(supabase));

  currentUser = USER_A;
  supabase = usersDb("delegate");
  assert.equal((await createUser({ projectId: P1, departmentId: D1_IN_P1, role: "ADMIN" })).status, 403);
  assert.deepEqual(writes(supabase), []);

  for (const [actor, projectId, departmentId] of [
    ["delegate", P2, D2_IN_P2], // project outside the delegation
    ["contractor", P1, D1_IN_P1], // no delegation at all
  ]) {
    supabase = usersDb(actor);
    const res = await createUser({ projectId, departmentId });
    assert.equal(res.status, 403, actor);
    const { error } = await res.json();
    assert.equal(error, "You don't have permission to do this.", actor);
    assert.ok(!error.includes(USER_A.userId), "the caller's user id is not echoed");
    assert.deepEqual(writes(supabase), [], actor);
    // Refused by the authorization check, before the department lookup.
    assert.ok(!supabase.log.some((q) => q.table === "departments"), actor);
  }
});

// ===================================================== delegation window and scope
// hasDelegatedPermission is evaluated on every call: revoked, expired or
// not-yet-started grants, other projects, other departments and other
// permissions must all be refused.
const { hasDelegatedPermission } = require("../lib/delegation.ts");

const HOUR = 60 * 60 * 1000;
function delegationRow({ status = "Active", startsIn = -HOUR, endsIn = HOUR, projects = [P1], departments = [], permissions = ["USER_MANAGEMENT"] } = {}) {
  return {
    delegation_id: "del-x",
    status,
    starts_at: new Date(Date.now() + startsIn).toISOString(),
    ends_at: new Date(Date.now() + endsIn).toISOString(),
    delegation_projects: projects.map((project_id) => ({ project_id })),
    delegation_departments: departments.map((department_id) => ({ department_id, departments: { project_id: DEPARTMENT_PROJECT[department_id] } })),
    delegation_permissions: permissions.map((permission) => ({ permission })),
  };
}
async function delegated(row, permission, scope) {
  supabase = mockSupabase((table) => (table === "admin_delegations" ? { data: row ? [row] : [], error: null } : { data: null, error: null }));
  return hasDelegatedPermission(supabase, USER_A.userId, permission, scope);
}

test("delegation: only an Active grant inside its time window counts", async () => {
  const scope = { projectId: P1, departmentId: D1_IN_P1 };
  assert.equal(await delegated(delegationRow(), "USER_MANAGEMENT", scope), true, "active");
  assert.equal(await delegated(delegationRow({ endsIn: -1000 }), "USER_MANAGEMENT", scope), false, "expired");
  assert.equal(await delegated(delegationRow({ startsIn: HOUR, endsIn: 2 * HOUR }), "USER_MANAGEMENT", scope), false, "not started yet");
  assert.equal(await delegated(delegationRow({ status: "Revoked" }), "USER_MANAGEMENT", scope), false, "revoked");
  assert.equal(await delegated(null, "USER_MANAGEMENT", scope), false, "no delegation");
});

test("delegation: other projects, departments and permissions are refused", async () => {
  assert.equal(await delegated(delegationRow(), "USER_MANAGEMENT", { projectId: P2, departmentId: D2_IN_P2 }), false, "other project");
  assert.equal(await delegated(delegationRow(), "WORK_ITEM_MANAGEMENT", { projectId: P1, departmentId: D1_IN_P1 }), false, "permission not granted");

  const restricted = delegationRow({ departments: [D1_IN_P1], permissions: ["USER_MANAGEMENT", "PROJECT_MANAGEMENT"] });
  const OTHER_DEPT_IN_P1 = "22222222-0000-4000-8000-000000000009";
  assert.equal(await delegated(restricted, "USER_MANAGEMENT", { projectId: P1, departmentId: D1_IN_P1 }), true, "listed department");
  assert.equal(await delegated(restricted, "USER_MANAGEMENT", { projectId: P1, departmentId: OTHER_DEPT_IN_P1 }), false, "unlisted department");
  assert.equal(await delegated(restricted, "USER_MANAGEMENT", { projectId: P1 }), false, "department-restricted grant needs a department");
  assert.equal(await delegated(restricted, "PROJECT_MANAGEMENT", { projectId: P1 }), true, "project-level permission");
});

// ===================================================== /api/admin/work-items dependencies
// Prerequisite work items must belong to the same project, and a rejected
// list must leave everything unchanged.
const adminWorkItems = require("../app/api/admin/work-items/route.ts");
const W1 = "33333333-0000-4000-8000-000000000001"; // P1
const W2 = "33333333-0000-4000-8000-000000000002"; // P1
const WQ = "33333333-0000-4000-8000-000000000003"; // P2
// "new-item" is what the mocked insert returns; it is created in D1, i.e. P1.
const WORK_ITEM_PROJECT = { [W1]: P1, [W2]: P1, [WQ]: P2, "new-item": P1 };

function workItemsDb() {
  return mockSupabase((table, calls) => {
    const eq = (col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];
    const inIds = calls.find((c) => c[0] === "in")?.[2];
    const has = (method) => calls.some((c) => c[0] === method);
    if (table === "users") return { data: eq("user_role") === "ADMIN" ? { user_id: USER_A.userId } : null, error: null };
    if (table === "departments") return { data: { project_id: DEPARTMENT_PROJECT[eq("department_id")] }, error: null };
    if (table === "work_items") {
      if (has("insert")) return { data: { work_item_id: "new-item" }, error: null };
      if (has("update")) return { data: null, error: null };
      if (inIds) {
        return { data: inIds.filter((id) => WORK_ITEM_PROJECT[id]).map((id) => ({ work_item_id: id, project_id: WORK_ITEM_PROJECT[id] })), error: null };
      }
      return { data: { project_id: WORK_ITEM_PROJECT[eq("work_item_id")], department_id: D1_IN_P1 }, error: null };
    }
    return { data: null, error: null }; // work_item_dependencies delete/insert
  });
}
const patchWorkItem = (body) =>
  adminWorkItems.PATCH(new NextRequest("http://localhost/api/admin/work-items", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

test("work items: a prerequisite from another project (or a non-existent one) is refused and nothing is written", async () => {
  currentUser = USER_A;
  for (const deps of [[WQ], [W2, WQ], ["33333333-0000-4000-8000-00000000dead"]]) {
    supabase = workItemsDb();
    const res = await patchWorkItem({ workItemId: W1, plannedQuantity: 5, dependsOnWorkItemIds: deps });
    assert.notEqual(res.status, 200, JSON.stringify(deps));
    assert.match((await res.json()).error, /same project/);
    assert.deepEqual(writes(supabase), [], JSON.stringify(deps));
  }

  supabase = workItemsDb();
  const created = await adminWorkItems.POST(jsonRequest("/api/admin/work-items", {
    departmentId: D1_IN_P1, lineItemNo: "900", descriptionOfWork: "Test", dependsOnWorkItemIds: [WQ],
  }));
  assert.notEqual(created.status, 200);
  assert.deepEqual(writes(supabase), [], "no work item is created");
});

test("work items: same-project prerequisites are saved, and edits without dependencies are unchanged", async () => {
  currentUser = USER_A;
  supabase = workItemsDb();
  const res = await patchWorkItem({ workItemId: W1, plannedQuantity: 5, dependsOnWorkItemIds: [W2] });
  assert.equal(res.status, 200);
  const inserted = supabase.log.filter((q) => q.table === "work_item_dependencies" && q.calls.some((c) => c[0] === "insert"));
  assert.deepEqual(inserted[0].calls.find((c) => c[0] === "insert")[1], [{ work_item_id: W1, depends_on_work_item_id: W2 }]);
  assert.ok(supabase.log.some((q) => q.table === "work_items" && q.calls.some((c) => c[0] === "update")), "values updated");

  supabase = workItemsDb();
  assert.equal((await patchWorkItem({ workItemId: W1, plannedQuantity: 7 })).status, 200);
  assert.ok(!supabase.log.some((q) => q.table === "work_item_dependencies"), "dependencies untouched when not sent");

  supabase = workItemsDb();
  const created = await adminWorkItems.POST(jsonRequest("/api/admin/work-items", {
    departmentId: D1_IN_P1, lineItemNo: "901", descriptionOfWork: "Test", dependsOnWorkItemIds: [W1],
  }));
  assert.equal(created.status, 200);
});

// ===================================================== password reset requests
// Capped per email and per client IP before Supabase is asked to send
// anything; the normal answer never reveals whether an account exists.
const resetCalls = [];
stubModule("lib/supabaseServer.ts", {
  createSupabaseServerClient: async () => ({
    auth: { resetPasswordForEmail: async (email) => (resetCalls.push(email), { data: {}, error: null }) },
  }),
});
{
  const file = require.resolve("next/headers");
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = { headers: async () => new Headers(), cookies: async () => ({ getAll: () => [], set() {} }) };
  require.cache[file] = m;
}
const { requestPasswordReset } = require("../app/login/actions.ts");

test("password reset: the sixth request for one email within the hour is refused before any email is sent", async () => {
  let now = Date.UTC(2026, 0, 1);
  rateLimit.setRateLimitStoreForTests(memoryStore(() => now));
  resetCalls.length = 0;
  try {
    const form = (email) => {
      const f = new FormData();
      f.set("email", email);
      return f;
    };
    for (let i = 1; i <= 5; i++) {
      const r = await requestPasswordReset(undefined, form("someone@example.com"));
      assert.match(r.message, /If an account exists/, `request ${i}`);
    }
    const sixth = await requestPasswordReset(undefined, form("someone@example.com"));
    assert.match(sixth.error, /Too many requests/);
    assert.equal(resetCalls.length, 5, "no email for the refused request");

    const other = await requestPasswordReset(undefined, form("other@example.com"));
    assert.match(other.message, /If an account exists/, "another email is unaffected");

    now += 61 * 60 * 1000;
    assert.match((await requestPasswordReset(undefined, form("someone@example.com"))).message, /If an account exists/, "window resets");
  } finally {
    rateLimit.setRateLimitStoreForTests(undefined);
  }
});
