/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs. */
// GET /api/workflow/worker for a Worker with no Active assignment (e.g. the
// Concrete demo Worker, or any newly added real Worker): an empty state,
// not a 500. Any other failure is still a 500. The real route handler runs;
// only the session, Supabase and workflow modules are stubbed.
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

class NoAssignedWorkItemError extends Error {}
let currentUser = null;
let dashboard = async () => ({ workItem: { id: "w1" } });
stubModule("lib/session.ts", { getCurrentUser: async () => currentUser, requireCurrentUser: async () => currentUser });
stubModule("lib/supabase.ts", { getSupabaseClient: () => ({}) });
stubModule("lib/workflow.ts", {
  NoAssignedWorkItemError,
  getWorkerDashboard: (...args) => dashboard(...args),
  submitWorkerProgress: async () => {
    throw new Error("must not be called");
  },
});

const { NextRequest } = require("next/server");
const route = require("../app/api/workflow/worker/route.ts");
const get = () => route.GET(new NextRequest("http://localhost/api/workflow/worker"));
const DEMO_WORKER = { authUserId: "a", userId: "u", email: "demo.worker.concrete@example.com", isDemo: true };

test("worker API: no assigned work item -> 200 empty state, not a 500", async () => {
  currentUser = DEMO_WORKER;
  dashboard = async () => {
    throw new NoAssignedWorkItemError("none");
  };
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { workItem: null, message: "No work items assigned yet." });
});

test("worker API: any other failure is still a 500; no session is still a 401", async () => {
  currentUser = DEMO_WORKER;
  dashboard = async () => {
    throw new Error("db down");
  };
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await get()).status, 500);
  } finally {
    console.error = original;
  }
  currentUser = null;
  assert.equal((await get()).status, 401);
});

test("worker API: an assigned worker's dashboard is returned unchanged", async () => {
  currentUser = { ...DEMO_WORKER, isDemo: false, email: "w@abc.test" };
  dashboard = async () => ({ workItem: { id: "w1" }, projectName: "P" });
  const res = await get();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { workItem: { id: "w1" }, projectName: "P" });
});

test("worker API: with the emergency switch DEMO_LOGIN_READ_ONLY=true a demo Worker's submission is refused read-only", async () => {
  process.env.DEMO_LOGIN_READ_ONLY = "true";
  currentUser = DEMO_WORKER;
  const res = await route.POST(
    new NextRequest("http://localhost/api/workflow/worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ progressPercentage: 10 }),
    })
  );
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /read-only/);
  delete process.env.DEMO_LOGIN_READ_ONLY;
});
