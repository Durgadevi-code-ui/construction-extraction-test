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

test("demo mode: never on in Vercel production unless explicitly allowed", () => {
  const { demoModeEnabled } = require("../lib/demoAuth.ts");
  assert.equal(demoModeEnabled({}), false);
  assert.equal(demoModeEnabled({ DEMO_MODE: "true" }), true, "local development opt-in");
  assert.equal(demoModeEnabled({ DEMO_MODE: "true", VERCEL_ENV: "preview" }), true, "preview (behind Vercel Authentication)");
  assert.equal(demoModeEnabled({ DEMO_MODE: "true", VERCEL_ENV: "production" }), false, "public production");
  assert.equal(demoModeEnabled({ DEMO_MODE: "TRUE", VERCEL_ENV: "development" }), false, "only the exact value 'true'");
  assert.equal(demoModeEnabled({ DEMO_MODE: "true", VERCEL_ENV: "production", DEMO_MODE_ALLOW_PRODUCTION: "true" }), true, "explicit override");
});
