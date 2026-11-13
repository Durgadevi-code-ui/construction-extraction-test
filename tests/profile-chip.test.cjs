/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs. */
// ProfileChip header control (components/workflow/ProfileChip.tsx): the
// sidebar name/avatar shown on every role's page. A Demo Login account's
// email local-part is its role (e.g. demo.worker.electrical@…), so the
// email-derived guess would read "Demo Worker Electrical". The chip must
// instead show the account's REAL display name (public.users first/last
// name, resolved server-side) whenever one is passed — the user's explicit
// requirement that no "Demo <role>" label appears in the profile, fixed via
// the underlying name data, not CSS. Without a name it still falls back to
// the email guess, so non-demo behaviour is unchanged.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const ts = require("typescript");

require.extensions[".tsx"] ??= function (module, filename) {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ProfileChip = require("../components/workflow/ProfileChip.tsx").default;
const h = React.createElement;

const DEMO_EMAIL = "demo.worker.electrical@example.com";

test("real name is preferred: a demo Worker shows 'Alex Rivera', never 'Demo Worker'", () => {
  const html = renderToStaticMarkup(
    h(ProfileChip, { email: DEMO_EMAIL, name: "Alex Rivera", roleLabel: "Worker" })
  );
  assert.match(html, /Alex Rivera/, "the real display name is shown");
  assert.ok(!/Demo Worker/.test(html), "the email-derived 'Demo Worker' label is gone");
  assert.match(html, />AR</, "initials come from the real name (A+R), not the email (DW)");
  assert.ok(!/>DW</.test(html), "no email-derived initials");
});

test("aria-label uses the real name too", () => {
  const html = renderToStaticMarkup(
    h(ProfileChip, { email: DEMO_EMAIL, name: "Alex Rivera", roleLabel: "Worker", onClick: () => {} })
  );
  assert.match(html, /aria-label="Profile — Alex Rivera, Worker"/);
});

test("blank/absent name falls back to the email guess (non-demo behaviour unchanged)", () => {
  const fallback = renderToStaticMarkup(
    h(ProfileChip, { email: "ramesh.kumar@x.com", roleLabel: "Worker" })
  );
  assert.match(fallback, /Ramesh Kumar/, "email local-part humanised when no name is given");
  const blank = renderToStaticMarkup(
    h(ProfileChip, { email: "ramesh.kumar@x.com", name: "   ", roleLabel: "Worker" })
  );
  assert.match(blank, /Ramesh Kumar/, "a whitespace-only name is treated as absent");
});

test("every role passes the real display name into the shared shell", () => {
  // DashboardShell forwards displayName -> ProfileChip.name; each role's
  // page must supply it (profile.displayName / the admin's resolved name)
  // so none of them fall back to the email guess.
  assert.match(
    fs.readFileSync(`${__dirname}/../components/workflow/DashboardShell.tsx`, "utf8"),
    /<ProfileChip[\s\S]*name=\{displayName\}/,
    "DashboardShell forwards displayName to the chip"
  );
  for (const file of [
    "components/workflow/WorkerTabs.tsx",
    "components/workflow/ContractorTabs.tsx",
    "components/workflow/ForemanTabs.tsx",
  ]) {
    assert.match(
      fs.readFileSync(`${__dirname}/../${file}`, "utf8"),
      /displayName=\{profile\.displayName\}/,
      file
    );
  }
  assert.match(
    fs.readFileSync(`${__dirname}/../components/admin/AdminSetupPanel.tsx`, "utf8"),
    /displayName=\{userDisplayName\}/,
    "AdminSetupPanel forwards the admin's resolved name"
  );
});
