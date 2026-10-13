/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Authorization regressions in lib/ — driven with a mocked Supabase
// client (never a real database). Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");

const { listDirectMessages } = require("../lib/chat.ts");
const { bootstrapAdminUser } = require("../lib/admin.ts");

/** Chainable PostgREST-style mock: every call is recorded, and awaiting
 * the query resolves to respond(table, calls). */
function mockSupabase(respond) {
  const log = [];
  return {
    log,
    from(table) {
      const calls = [];
      log.push({ table, calls });
      const builder = new Proxy({}, {
        get(_target, prop) {
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
  };
}

const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";

function chatRespond(table) {
  if (table === "users") return { data: null, error: null }; // caller is not an Admin
  if (table === "user_project_roles") {
    return {
      data: [{ user_id: ME, role: "WORKER", project_id: "p1", department_id: "d1", projects: { project_name: "P" }, departments: { department_name: "D" } }],
      error: null,
    };
  }
  return { data: [], error: null };
}

test("chat: an injected `peer` cannot rewrite the direct-message filter", async () => {
  for (const peer of [
    `${PEER}),or(recipient_user_id.not.is.null`,
    `x,recipient_user_id.not.is.null),and(sender_user_id.neq.${ME}`,
    "not-a-uuid",
    "",
  ]) {
    const supabase = mockSupabase(chatRespond);
    await assert.rejects(listDirectMessages(supabase, ME, peer, null), /Invalid conversation/, JSON.stringify(peer));
    assert.ok(!supabase.log.some((q) => q.table === "chat_messages"), "chat_messages must not be queried");
  }
});

test("chat: a real conversation with a valid user id still loads", async () => {
  const supabase = mockSupabase(chatRespond);
  const messages = await listDirectMessages(supabase, ME, PEER, null);
  assert.ok(Array.isArray(messages));
  const query = supabase.log.find((q) => q.table === "chat_messages");
  const or = query.calls.find((c) => c[0] === "or");
  assert.match(or[1], new RegExp(`recipient_user_id\\.eq\\.${PEER}`));
  assert.ok(query.calls.some((c) => c[0] === "eq" && c[1] === "project_id" && c[2] === "p1"), "scoped to the caller's project");
});

test("chat: a member of one project who passes another project's id still only sees their own project", async () => {
  // The caller's only Active membership is p1 (chatRespond); getUserContext
  // ignores a requested project the caller doesn't belong to and falls
  // back to their own, so the query is scoped to p1 — never p2.
  const supabase = mockSupabase(chatRespond);
  await listDirectMessages(supabase, ME, PEER, "p2");
  const query = supabase.log.find((q) => q.table === "chat_messages");
  assert.ok(query.calls.some((c) => c[0] === "eq" && c[1] === "project_id" && c[2] === "p1"), "scoped to own project");
  assert.ok(!query.calls.some((c) => c.includes("p2")), "the requested foreign project is never queried");
});

const isAdminListQuery = (calls) => calls.some((c) => c[0] === "eq" && c[1] === "user_role");

test("bootstrap: once an Admin exists, a registered email's user id is never returned", async () => {
  const supabase = mockSupabase((table, calls) => {
    if (table === "users" && isAdminListQuery(calls)) return { data: [{ user_id: "admin-1", user_mail: "a@x", status: "Active", department_id: "d" }], error: null };
    if (table === "users") return { data: { user_id: "victim-user-id" }, error: null };
    return { data: [], error: null };
  });
  await assert.rejects(bootstrapAdminUser(supabase, { email: "victim@x", departmentId: "d" }), /already exists/);
});

test("bootstrap: with no Admin yet, the first Admin is still created", async () => {
  const inserted = [];
  const supabase = mockSupabase((table, calls) => {
    const insert = calls.find((c) => c[0] === "insert");
    if (table === "users" && insert) {
      inserted.push(insert[1]);
      return { data: { user_id: "new-admin" }, error: null };
    }
    if (table === "users" && isAdminListQuery(calls)) return { data: [], error: null };
    if (table === "users") return { data: null, error: null };
    return { data: [], error: null };
  });
  assert.equal(await bootstrapAdminUser(supabase, { email: "first@x", departmentId: "d" }), "new-admin");
  assert.equal(inserted[0].user_role, "ADMIN");
});
