/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Admin Setup → Users → New User: the success message must follow the
// server's answer (app/api/admin/users → { userCreated, loginCreated }),
// not the form's own guess. A delegated Contractor only sees users in their
// scope, so an email that already exists elsewhere looks "new" to the form:
// the server then only adds the role, and the form must NOT claim a login
// was created or show a temporary password that was never set.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

// tests/register-ts.cjs handles .ts; this file also needs the .tsx component.
if (!require.extensions[".tsx"]) {
  require.extensions[".tsx"] = function (module, filename) {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
      fileName: filename,
    });
    module._compile(outputText, filename);
  };
}
const PANEL = path.resolve(__dirname, "../components/admin/AdminSetupPanel.tsx");
const { createUserNotice } = require(PANEL);
const SENT = "Temp-Pass-12345";

test("notice: new user + login created by the server → 'User and login created' with the temporary password", () => {
  assert.deepEqual(createUserNotice({ ok: true, userCreated: true, loginCreated: true }, "new@example.com", SENT), {
    kind: "created",
    email: "new@example.com",
    password: SENT,
  });
});

test("notice: existing user (visible to the form, no password sent) → role added, no password", () => {
  const n = createUserNotice({ ok: true, userCreated: false, loginCreated: false }, "known@example.com", null);
  assert.deepEqual(n, { kind: "role-added", email: "known@example.com" });
});

test("notice: delegated Contractor, email exists outside their scope (form sent a password) → role added, the password is NEVER shown", () => {
  const n = createUserNotice({ ok: true, userCreated: false, loginCreated: false }, "elsewhere@example.com", SENT);
  assert.equal(n.kind, "role-added");
  assert.ok(!JSON.stringify(n).includes(SENT), "the unused password is not in the notice");
});

test("notice: anything short of a confirmed new login never shows a password", () => {
  for (const response of [
    { ok: true, userCreated: true, loginCreated: false },
    { ok: true }, // e.g. an older server without the new fields
    {},
    { ok: true, userCreated: "true", loginCreated: "true" }, // not booleans
  ]) {
    const n = createUserNotice(response, "x@example.com", SENT);
    assert.notEqual(n.kind, "created", JSON.stringify(response));
    assert.ok(!JSON.stringify(n).includes(SENT), JSON.stringify(response));
  }
  assert.equal(createUserNotice({ ok: true, userCreated: true, loginCreated: true }, "x@example.com", null).kind, "saved", "no password sent → none to show");
});

test("Users tab: the message comes from the server's answer, and the password text appears only for a confirmed new login", () => {
  const source = fs.readFileSync(PANEL, "utf8");
  const usersTab = source.slice(source.indexOf("function UsersTab("), source.indexOf("function RemoveAssignmentButton("));
  assert.match(usersTab, /setNotice\(createUserNotice\(result, /, "notice decided by createUserNotice from the submit result");
  assert.doesNotMatch(usersTab, /if \(!isExistingUser\) set/, "no longer decided by the form's own (scoped) user list");
  const passwordText = usersTab.indexOf("Temporary password (shown once");
  assert.ok(passwordText > 0);
  const GUARD = 'notice?.kind === "created"';
  const guard = usersTab.lastIndexOf(GUARD, passwordText);
  // The nearest branch before the password text is the "created" one.
  assert.ok(guard > 0 && !usersTab.slice(guard + GUARD.length, passwordText).includes("notice?.kind ==="), "password text only inside the 'created' branch");
  assert.equal(usersTab.split("Temporary password (shown once").length - 1, 1, "shown in exactly one place");
  assert.match(usersTab, /Role assignment added to the existing account/);
  assert.match(usersTab, /Its login and password were not changed\./);
});

test("submit helper: returns the server's response on success (still truthy for every other form's `if (ok)`)", () => {
  const source = fs.readFileSync(PANEL, "utf8");
  const helper = source.slice(source.indexOf("function useSubmit("), source.indexOf("return { submit, submitting, error };"));
  assert.match(helper, /return data && typeof data === "object" \? data : \{\};/);
  assert.match(helper, /return false;/);
  assert.doesNotMatch(helper, /return true;/);
});
