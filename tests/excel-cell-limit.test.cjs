/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// The workbook cell limit (lib/workbookLimits.ts), end to end through the
// real import route with the workbook_* tables on a real PostgreSQL
// (PGlite, migration 24 applied unchanged): the limit counts populated
// cells across ALL sheets, a workbook at the limit imports in full, one
// over it is refused at preview and commit with nothing stored — no
// Storage file, no workbook_* row, no work item.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const XLSX = require("xlsx");
const { fakeSupabase } = require("./support/fakeSupabase.cjs");
const { pgRest } = require("./support/pgRest.cjs");
const { richWorkbook, sourceCells } = require("./support/workbooks.cjs");

const ROOT = path.resolve(__dirname, "..");
const WORKBOOK_TABLES = ["workbook_imports", "workbook_sheets", "workbook_cells"];

function stub(rel, exports) {
  const file = require.resolve(path.join(ROOT, rel));
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}

const ADMIN = { authUserId: "auth-admin", userId: "00000000-0000-4000-8000-0000000000ad", email: "admin@example.com" };
const PROJECT = "11111111-1111-4111-8111-111111111111";

let pg;
let db;
stub("lib/session.ts", { getCurrentUser: async () => ADMIN, requireCurrentUser: async () => ADMIN });
stub("lib/supabase.ts", { getSupabaseClient: () => db });
stub("lib/supabaseAdmin.ts", { getSupabaseServiceRoleClient: () => db, createPasswordCheckClient: () => db });
delete process.env.RATE_LIMIT_BACKEND;
delete process.env.VERCEL_ENV;
delete process.env.WORKBOOK_MAX_CELLS;

const importRoute = require("../app/api/admin/projects/import/route.ts");
const { saveProjectImport } = require("../lib/projectDocuments.ts");
const { parseProjectWorkbook } = require("../lib/excelImport.ts");
const { workbookMaxCells, DEFAULT_WORKBOOK_MAX_CELLS, WorkbookTooLargeError } = require("../lib/workbookLimits.ts");
const { NextRequest } = require("next/server");

test.before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.projects (project_id uuid primary key);
    insert into public.projects values ('${PROJECT}');
    create table public.test_faults (tbl text primary key);
  `);
  await pg.exec(fs.readFileSync(path.join(ROOT, "supabase/migrations/00000000000024_workbook_extractions.sql"), "utf8"));
  await pg.exec(`
    create function public.test_fault() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from public.test_faults where tbl = tg_table_name) then
        raise exception 'simulated % failure', tg_table_name;
      end if;
      return null;
    end $$;
    create trigger t_fault before insert on public.workbook_cells for each statement execute function public.test_fault();
  `);
});
test.after(async () => pg?.close());
test.afterEach(() => {
  delete process.env.WORKBOOK_MAX_CELLS;
});

async function freshDb() {
  await pg.exec("delete from public.workbook_imports; delete from public.test_faults;");
  const toPg = pgRest(pg);
  db = fakeSupabase({}, Object.fromEntries(WORKBOOK_TABLES.map((t) => [t, toPg])));
  db.tables.users.push({ user_id: ADMIN.userId, user_role: "ADMIN", status: "Active", user_mail: ADMIN.email });
}
async function post(bytes, { commit = true } = {}) {
  const form = new FormData();
  form.set("projectId", PROJECT);
  form.set("file", new File([bytes], "Synthetic.xlsx"));
  if (commit) form.set("commit", "1");
  const res = await importRoute.POST(new NextRequest("http://localhost/api/admin/projects/import", { method: "POST", body: form }));
  return { status: res.status, body: await res.json() };
}
const rowCount = async (table) => Number((await pg.query(`select count(*)::int as n from public.${table}`)).rows[0].n);

/** Nothing of an import anywhere: no file, no row in any workbook_* table, no work item or department. */
async function assertNothingStored(label) {
  for (const t of WORKBOOK_TABLES) assert.equal(await rowCount(t), 0, `${label}: ${t} empty`);
  assert.equal(db.files.size, 0, `${label}: no Storage file`);
  assert.equal(db.tables.work_items.length, 0, `${label}: no work item`);
  assert.equal(db.tables.departments.length, 0, `${label}: no department`);
}

/** Sheets of plain numbers: `cells` populated cells per sheet, 10 per row. */
function numberWorkbook(cellsPerSheet) {
  const wb = XLSX.utils.book_new();
  cellsPerSheet.forEach((cells, s) => {
    const aoa = [];
    for (let i = 0; i < cells; i++) {
      if (i % 10 === 0) aoa.push([]);
      aoa[aoa.length - 1].push(s * 1e6 + i + 0.25);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), `Sheet ${s + 1}`);
  });
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

// ---------------------------------------------------------------- configuration

test("limit: 100,000 cells by default; WORKBOOK_MAX_CELLS overrides it; an invalid value falls back to the default", () => {
  assert.equal(DEFAULT_WORKBOOK_MAX_CELLS, 100000);
  assert.equal(workbookMaxCells(), 100000);
  process.env.WORKBOOK_MAX_CELLS = "250";
  assert.equal(workbookMaxCells(), 250);
  for (const bad of ["0", "-5", "abc", "12.5", "1e400"]) {
    process.env.WORKBOOK_MAX_CELLS = bad;
    assert.equal(workbookMaxCells(), 100000, `"${bad}" ignored`);
  }
});

// ---------------------------------------------------------------- below / at / above

test("below the limit: imported in full — every cell, formula and header stored", async () => {
  await freshDb();
  const bytes = richWorkbook();
  const cells = sourceCells(bytes).cells.size;
  process.env.WORKBOOK_MAX_CELLS = String(cells + 1);
  const { status, body } = await post(bytes);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(await rowCount("workbook_cells"), cells);
  const e11 = (await pg.query("select formula, value_number, header from public.workbook_cells where sheet_name = 'Schedule' and cell_ref = 'E11'")).rows[0];
  assert.deepEqual(e11, { formula: "C11*2500", value_number: 10000, header: "Amount" });
  assert.ok(db.tables.work_items.length > 0);
});

test("exactly at the limit: allowed and imported in full", async () => {
  await freshDb();
  const bytes = richWorkbook();
  const cells = sourceCells(bytes).cells.size;
  process.env.WORKBOOK_MAX_CELLS = String(cells);
  const preview = await post(bytes, { commit: false });
  assert.equal(preview.status, 200);
  const { status, body } = await post(bytes);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(await rowCount("workbook_cells"), cells);
  const imp = (await pg.query("select cell_count, complete from public.workbook_imports")).rows[0];
  assert.deepEqual(imp, { cell_count: cells, complete: true });
});

test("one cell over the limit: refused at preview and at commit with a clear message; nothing stored", async () => {
  await freshDb();
  const bytes = richWorkbook();
  const cells = sourceCells(bytes).cells.size;
  process.env.WORKBOOK_MAX_CELLS = String(cells - 1);
  for (const commit of [false, true]) {
    const { status, body } = await post(bytes, { commit });
    assert.equal(status, 413, `commit=${commit}`);
    assert.equal(body.cellCount, cells);
    assert.equal(body.cellLimit, cells - 1);
    assert.match(body.error, new RegExp(`has ${cells} populated cells across 6 sheets`));
    assert.match(body.error, /more than the import limit of/);
    assert.match(body.error, /Nothing was imported/);
    assert.ok(!("rows" in body) && !("extraction" in body), "no preview data for a refused workbook");
  }
  await assertNothingStored("over the limit");
});

test("several sheets each under the limit but over it combined: refused — the limit is for the whole workbook", async () => {
  await freshDb();
  process.env.WORKBOOK_MAX_CELLS = "100";
  const bytes = numberWorkbook([40, 40, 40]);
  const perSheet = sourceCells(bytes);
  assert.equal(perSheet.cells.size, 120);
  const { status, body } = await post(bytes);
  assert.equal(status, 413, JSON.stringify(body));
  assert.equal(body.cellCount, 120);
  assert.match(body.error, /120 populated cells across 3 sheets \("Sheet 1" 40, "Sheet 2" 40, "Sheet 3" 40\)/);
  await assertNothingStored("combined over the limit");
});

test("the real default: exactly 100,000 cells is accepted, 100,001 (the extra cell on another sheet) is refused", async () => {
  await freshDb();
  const atLimit = numberWorkbook([100000]);
  const ok = await post(atLimit, { commit: false });
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.equal(ok.body.workbook.totals.cells, 100000);

  const overLimit = numberWorkbook([100000, 1]);
  const refused = await post(overLimit);
  assert.equal(refused.status, 413);
  assert.equal(refused.body.cellCount, 100001);
  assert.equal(refused.body.cellLimit, 100000);
  await assertNothingStored("100,001 cells");
});

// ---------------------------------------------------------------- cleanup and defence in depth

test("storage layer refuses an over-limit extraction itself, before the first upload", async () => {
  await freshDb();
  const bytes = richWorkbook();
  const parsed = parseProjectWorkbook(bytes.buffer ?? bytes, "Synthetic.xlsx");
  process.env.WORKBOOK_MAX_CELLS = String(parsed.complete.totals.cells - 1);
  await assert.rejects(
    saveProjectImport(PROJECT, { name: "Synthetic.xlsx", bytes, contentType: "" }, parsed.complete),
    (err) => err instanceof WorkbookTooLargeError
  );
  await assertNothingStored("storage-level refusal");
});

test("an import within the limit that fails while writing cells leaves no rows and no files", async () => {
  await freshDb();
  const bytes = numberWorkbook([1500, 900]); // more than one 1000-cell batch
  process.env.WORKBOOK_MAX_CELLS = "2400";
  await pg.query("insert into public.test_faults values ('workbook_cells')");
  const { status, body } = await post(bytes);
  assert.equal(status, 503);
  assert.match(body.error, /nothing was imported/);
  await assertNothingStored("failed cell write");

  // The same workbook imports in full once the database is healthy again.
  await pg.query("delete from public.test_faults");
  const retry = await post(bytes);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(await rowCount("workbook_cells"), 2400);
  assert.equal(db.files.size, 2, "original workbook + extraction JSON");
});
