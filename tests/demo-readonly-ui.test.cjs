/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs. */
// Demo Login read-only UI (components/ui/ReadOnly.tsx): rendered to HTML
// with react-dom/server. For a demo session every wrapped write control is
// disabled and explained; for everyone else the output is byte-for-byte
// what it was without the wrapper — real users' screens don't change.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const ts = require("typescript");

// .tsx for this file only (tests/register-ts.cjs handles .ts).
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
const Button = require("../components/ui/Button.tsx").default;
const {
  ReadOnlyProvider,
  ReadOnlyFieldset,
  ReadOnlyBanner,
  WriteButton,
  READ_ONLY_MESSAGE,
} = require("../components/ui/ReadOnly.tsx");

const h = React.createElement;
const render = (readOnly, node) => renderToStaticMarkup(h(ReadOnlyProvider, { readOnly }, node));
const writeForm = () =>
  h("form", null, h("input", { name: "quantity" }), h(Button, { type: "submit" }, "Save"));

test("real users: wrapped controls render exactly as without the wrapper", () => {
  const plain = renderToStaticMarkup(writeForm());
  assert.equal(render(false, h(ReadOnlyFieldset, { notice: "x" }, writeForm())), plain);
  assert.equal(render(false, h(ReadOnlyBanner)), "", "no banner");
  assert.equal(
    render(false, h(WriteButton, { variant: "danger", onClick: () => {} }, "Remove")),
    renderToStaticMarkup(h(Button, { variant: "danger", onClick: () => {} }, "Remove"))
  );
  // No provider at all (e.g. /login): same as a real user.
  assert.equal(renderToStaticMarkup(h(ReadOnlyFieldset, null, writeForm())), plain);
});

test("demo sessions: every input and button in a wrapped block is disabled, with the reason", () => {
  const html = render(true, h(ReadOnlyFieldset, { notice: "Saving is off in the demo." }, writeForm()));
  assert.match(html, /^<fieldset disabled=""/, "native fieldset disables every control inside it");
  assert.ok(html.includes(READ_ONLY_MESSAGE.replace(/'/g, "&#x27;")), "tooltip explains why");
  assert.match(html, /Saving is off in the demo\./, "visible explanation");
  assert.match(html, /<input name="quantity"\/>/, "inputs still shown (disabled by the fieldset)");
});

test("demo sessions: WriteButton is disabled with the read-only reason; banner shown once per page", () => {
  const btn = render(true, h(WriteButton, { onClick: () => {} }, "Edit"));
  assert.match(btn, /disabled=""/);
  assert.match(btn, /title="This view is read-only/);
  const banner = render(true, h(ReadOnlyBanner));
  assert.match(banner, /role="status"/);
  assert.match(banner, /Read-only\./);
});

test("read-only wiring: every client component that sends a write is demo-aware", () => {
  // Each of these sends a non-GET request; each must read the read-only
  // state (directly or through ReadOnlyFieldset / WriteButton).
  const writers = [
    "components/admin/AdminSetupPanel.tsx",
    "components/admin/DelegationManager.tsx",
    "components/admin/ExcelImportPanel.tsx",
    "components/workflow/AssignmentManager.tsx",
    "components/workflow/ChatPanel.tsx",
    "components/workflow/DailyWorkUpdate.tsx",
    "components/workflow/DelegatedAdminPanel.tsx",
    "components/workflow/ForemanQueue.tsx",
    "components/workflow/LiveUpdateBar.tsx",
    "components/workflow/NotificationBell.tsx",
    "components/workflow/PlannedQuantityEditor.tsx",
    "components/workflow/SupervisorPanel.tsx",
    "components/workflow/WorkItemTaskManager.tsx",
    "components/workflow/WorkerTaskUpdates.tsx",
  ];
  for (const file of writers) {
    const src = fs.readFileSync(`${__dirname}/../${file}`, "utf8");
    assert.match(src, /@\/components\/ui\/ReadOnly/, file);
  }
  // The worker's submit form and voice/text capture are only reached
  // through DailyWorkUpdate's wrapped capture step.
  assert.match(fs.readFileSync(`${__dirname}/../components/workflow/DailyWorkUpdate.tsx`, "utf8"), /<ReadOnlyFieldset[\s\S]*<VoiceUpload[\s\S]*<TextInput[\s\S]*<\/ReadOnlyFieldset>/);
  // Both app areas provide the state from the session.
  for (const layout of ["app/workflow/layout.tsx", "app/admin/setup/layout.tsx"]) {
    assert.match(fs.readFileSync(`${__dirname}/../${layout}`, "utf8"), /<ReadOnlyProvider readOnly=\{await isDemoSession\(\)\}>/, layout);
  }
  assert.match(fs.readFileSync(`${__dirname}/../components/workflow/DashboardShell.tsx`, "utf8"), /<ReadOnlyBanner \/>/);
});
