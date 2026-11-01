/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Layer 1 persistence on a REAL PostgreSQL (PGlite = PostgreSQL compiled
// to WebAssembly, in memory): supabase/migrations/00000000000024_
// workbook_extractions.sql is applied unchanged, and the real import route
// writes the workbook_* tables through tests/support/pgRest.cjs, which runs
// actual SQL and returns at most 1000 rows per request like Supabase's
// PostgREST. Every check reads the rows back from Postgres and compares
// them with an independent read of the uploaded workbook, cell by cell.
// Other tables (users, work_items, …) and file storage stay in memory.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const XLSX = require("xlsx");
const { fakeSupabase } = require("./support/fakeSupabase.cjs");
const { pgRest } = require("./support/pgRest.cjs");
const { richWorkbook, generatedWorkbook, uncachedFormulaWorkbook, sourceCells } = require("./support/workbooks.cjs");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION = path.join(ROOT, "supabase/migrations/00000000000024_workbook_extractions.sql");
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
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";

let pg;
let db;
stub("lib/session.ts", { getCurrentUser: async () => ADMIN, requireCurrentUser: async () => ADMIN });
stub("lib/supabase.ts", { getSupabaseClient: () => db });
stub("lib/supabaseAdmin.ts", { getSupabaseServiceRoleClient: () => db, createPasswordCheckClient: () => db });
delete process.env.RATE_LIMIT_BACKEND;
delete process.env.VERCEL_ENV;

const importRoute = require("../app/api/admin/projects/import/route.ts");
const extractionRoute = require("../app/api/admin/projects/import/extraction/route.ts");
const { NextRequest } = require("next/server");

test.before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  pg = new PGlite();
  // What the migration expects from a Supabase database: its roles and the
  // projects table (created outside these migrations).
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.projects (project_id uuid primary key, project_name text);
    insert into public.projects values ('${PROJECT}', 'Synthetic test project'), ('${OTHER_PROJECT}', 'Other synthetic project');
    -- Test-only fault switch: a row here makes inserts into that table fail
    -- inside Postgres (a real error, as a constraint or outage would be).
    create table public.test_faults (tbl text primary key);
  `);
  const sql = fs.readFileSync(MIGRATION, "utf8");
  await pg.exec(sql);
  await pg.exec(sql); // idempotent
  await pg.exec(`
    create function public.test_fault() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from public.test_faults where tbl = tg_table_name) then
        raise exception 'simulated % failure', tg_table_name;
      end if;
      return null;
    end $$;
    create trigger t_fault before insert on public.workbook_imports for each statement execute function public.test_fault();
    create trigger t_fault before insert on public.workbook_sheets for each statement execute function public.test_fault();
    create trigger t_fault before insert on public.workbook_cells for each statement execute function public.test_fault();
  `);
});
test.after(async () => pg?.close());

async function freshDb() {
  await pg.exec("delete from public.workbook_imports; delete from public.test_faults;");
  const toPg = pgRest(pg);
  db = fakeSupabase({}, Object.fromEntries(WORKBOOK_TABLES.map((t) => [t, toPg])));
  db.tables.users.push({ user_id: ADMIN.userId, user_role: "ADMIN", status: "Active", user_mail: ADMIN.email });
}
async function post(bytes, { project = PROJECT, name = "Synthetic_Workbook.xlsx" } = {}) {
  const form = new FormData();
  form.set("projectId", project);
  form.set("file", new File([bytes], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  form.set("commit", "1");
  const res = await importRoute.POST(new NextRequest("http://localhost/api/admin/projects/import", { method: "POST", body: form }));
  return { status: res.status, body: await res.json() };
}
async function getExtraction(q) {
  const res = await extractionRoute.GET(new NextRequest(`http://localhost/api/admin/projects/import/extraction?projectId=${PROJECT}${q}`));
  return { status: res.status, body: await res.json() };
}
const count = async (table, importId) =>
  Number((await pg.query(`select count(*)::int as n from public.${table}${importId ? " where import_id = $1" : ""}`, importId ? [importId] : [])).rows[0].n);

/** Reads the import back from Postgres and checks it against the source
 * workbook: every populated cell exactly once, same position, value,
 * formula; sheets in workbook order; totals consistent. */
async function assertPersistedMatchesSource(bytes, importId) {
  const src = sourceCells(bytes);
  const sheets = (await pg.query("select * from public.workbook_sheets where import_id = $1 order by sheet_index", [importId])).rows;
  assert.deepEqual(sheets.map((s) => s.sheet_name), src.names, "every worksheet, in workbook order");
  const cells = (await pg.query("select * from public.workbook_cells where import_id = $1 order by sheet_index, row_number, col_index", [importId])).rows;
  const seen = new Map();
  for (const c of cells) {
    const key = `${c.sheet_name}!${c.cell_ref}`;
    assert.ok(!seen.has(key), `${key} exactly once`);
    seen.set(key, c);
  }
  for (const [key, cell] of src.cells) {
    const row = seen.get(key);
    assert.ok(row, `${key} persisted`);
    const ref = XLSX.utils.decode_cell(key.slice(key.lastIndexOf("!") + 1));
    assert.equal(row.row_number, ref.r + 1, `${key} original row`);
    assert.equal(row.col_index, ref.c, `${key} original column`);
    assert.equal(row.column_letter, XLSX.utils.encode_col(ref.c));
    assert.equal(row.sheet_index, src.names.indexOf(row.sheet_name));
    const v = cell.value;
    if (typeof v === "number") assert.equal(row.value_number, v, `${key} number exact`);
    else if (typeof v === "boolean") assert.equal(row.value_boolean, v, `${key} boolean`);
    else if (v !== undefined && v !== null && v !== "") assert.equal(row.value_text, String(v), `${key} text exact`);
    assert.equal(row.formula ?? undefined, cell.formula, `${key} formula`);
    if (cell.formula) {
      // The result Excel cached in the file, or none (never invented).
      assert.equal(row.value_number ?? row.value_text ?? row.value_boolean, v ?? null, `${key} cached formula result`);
    }
  }
  assert.equal(seen.size, src.cells.size, "no extra or fabricated cells");
  const imp = (await pg.query("select * from public.workbook_imports where import_id = $1", [importId])).rows[0];
  assert.equal(imp.cell_count, src.cells.size);
  assert.equal(imp.sheet_count, src.names.length);
  assert.equal(sheets.reduce((n, s) => n + s.populated_cells, 0), src.cells.size, "sheet counts add up");
  return { sheets, cells: seen, imp };
}

// ---------------------------------------------------------------- schema

test("migration on PostgreSQL: three tables, RLS on, clients denied, server allowed, re-runnable", async () => {
  const rows = (
    await pg.query(`
      select relname, relrowsecurity,
        has_table_privilege('anon', oid, 'select') as anon_select,
        has_table_privilege('authenticated', oid, 'insert') as authenticated_insert,
        has_table_privilege('service_role', oid, 'select') and has_table_privilege('service_role', oid, 'insert')
          and has_table_privilege('service_role', oid, 'delete') as service_role_rw
      from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace and relname like 'workbook_%' order by relname`)
  ).rows;
  assert.deepEqual(rows.map((r) => r.relname), ["workbook_cells", "workbook_imports", "workbook_sheets"]);
  for (const r of rows) {
    assert.equal(r.relrowsecurity, true, `${r.relname} RLS`);
    assert.equal(r.anon_select, false, `${r.relname} anon denied`);
    assert.equal(r.authenticated_insert, false, `${r.relname} authenticated denied`);
    assert.equal(r.service_role_rw, true, `${r.relname} service_role allowed`);
  }
  const policies = (await pg.query("select count(*)::int as n from pg_policies where tablename like 'workbook_%'")).rows[0].n;
  assert.equal(policies, 0, "no policy opens the tables");
});

// ---------------------------------------------------------------- integrity

test("PostgreSQL: a 6-sheet workbook is persisted cell for cell — headers, roles, two tables, formulas, dates, totals", async () => {
  await freshDb();
  const bytes = richWorkbook();
  const { status, body } = await post(bytes);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.extractionStored, true);
  const { cells, sheets, imp } = await assertPersistedMatchesSource(bytes, body.importId);
  assert.equal(imp.project_id, PROJECT);
  assert.equal(imp.imported_by, ADMIN.userId);
  assert.equal(cells.get("Equipment!E2").header, "Last Service");
  assert.equal(cells.get("Equipment!E2").value_date, "2024-11-04");
  assert.equal(cells.get("Equipment!B3").header, "Make", "custom column keeps its header");
  assert.equal(cells.get("Schedule!H5").header, "Site Contact");
  assert.equal(cells.get("Schedule!E11").formula, "C11*2500");
  assert.equal(cells.get("Schedule!E11").value_number, 10000);
  assert.equal(cells.get("Schedule!C14").header, "Budget", "second table's own header");
  assert.equal(cells.get("Schedule!C14").table_index, 2);
  assert.equal(cells.get("Schedule!C5").header, "Qty");
  assert.equal(cells.get("Schedule!C5").table_index, 1);
  assert.equal(cells.get("Schedule!A9").row_role, "total");
  assert.equal(cells.get("Schedule!A8").row_role, "note");
  assert.equal(cells.get("Schedule!A4").row_role, "section");
  assert.equal(cells.get("Cover!B3").row_role, "metadata");
  assert.equal(cells.get("Schedule!A1").merge_range, "A1:H1");
  assert.equal(cells.get("Schedule!A3").row_role, "header");
  assert.ok(!cells.has("Schedule!H6"), "blank cell not invented");
  assert.equal(sheets.find((s) => s.sheet_name === "Rates").visibility, "hidden");
  const schedule = sheets.find((s) => s.sheet_name === "Schedule");
  assert.deepEqual(schedule.tables.map((t) => t.columns.map((c) => c.header)), [
    ["Item No", "Description", "Qty", "Unit", "Amount", "% Complete", "Start", "Site Contact"],
    ["Code", "Allowance", "Budget", "Owner Approved"],
  ]);
  // The same item number "1" on two sheets: two cells, two work items.
  assert.equal(cells.get("Schedule!A5").value_text, "1");
  assert.equal(cells.get("Change Orders!A2").value_text, "1");
  assert.equal(db.tables.work_items.filter((w) => w.additional_fields.__source.lineItemNo === "1").length, 2);
});

test("PostgreSQL: a large 5-sheet workbook survives the 1000-row request limit — insert batches and API paging", async () => {
  await freshDb();
  const bytes = generatedWorkbook();
  const src = sourceCells(bytes);
  const { status, body } = await post(bytes);
  assert.equal(status, 200, JSON.stringify(body));
  const { sheets } = await assertPersistedMatchesSource(bytes, body.importId);
  assert.deepEqual(sheets.map((s) => s.tables.length), [2, 2, 2, 2, 1]);
  // The limit is real: one unpaged request stops at 1000 rows …
  const capped = await pgRest(pg)("workbook_cells").select("*").eq("import_id", body.importId);
  assert.equal(capped.data.length, 1000);
  // … and the API pages past it without losing or repeating a cell.
  const all = await getExtraction("&format=cells");
  assert.equal(all.status, 200);
  assert.equal(all.body.cells.length, src.cells.size);
  assert.equal(new Set(all.body.cells.map((c) => `${c.sheet_name}!${c.cell_ref}`)).size, src.cells.size);
  const order = all.body.cells.map((c) => [c.sheet_index, c.row_number, c.col_index]);
  const sorted = [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  assert.deepEqual(order, sorted, "sheet / row / column order");
  const one = await getExtraction(`&format=cells&sheet=${encodeURIComponent("Register 4")}`);
  assert.equal(one.body.cells.length, sheets.find((s) => s.sheet_name === "Register 4").populated_cells);
});

test("PostgreSQL: the sheet/rows API pages a sheet's rows with every cell, header and formula", async () => {
  await freshDb();
  const bytes = generatedWorkbook();
  const { body } = await post(bytes);
  const sheetRows = (await pg.query("select count(distinct row_number)::int as n from public.workbook_cells where import_id = $1 and sheet_name = 'Register 3'", [body.importId])).rows[0].n;
  const seen = [];
  for (let page = 1; ; page++) {
    const res = await getExtraction(`&format=rows&sheet=${encodeURIComponent("Register 3")}&page=${page}&pageSize=50`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totalRows, sheetRows);
    seen.push(...res.body.rows);
    if (page >= res.body.pageCount) break;
  }
  assert.equal(seen.length, sheetRows, "every row of the sheet, across pages");
  assert.deepEqual(seen.map((r) => r.row), [...seen.map((r) => r.row)].sort((a, b) => a - b));
  const cellsSeen = seen.reduce((n, r) => n + r.cells.length, 0);
  const cellsInDb = (await pg.query("select count(*)::int as n from public.workbook_cells where import_id = $1 and sheet_name = 'Register 3'", [body.importId])).rows[0].n;
  assert.equal(cellsSeen, cellsInDb, "every cell of the sheet");
  const formula = seen.flatMap((r) => r.cells).find((c) => c.formula);
  assert.ok(formula && formula.value_number !== null, "formula comes with its cached result");
  const header = seen.find((r) => r.role === "header");
  assert.equal(header.cells[1].value_text, "Custom 3.2");
  const total = seen.find((r) => r.role === "total");
  assert.ok(total, "total row returned, not hidden");
});

// ---------------------------------------------------------------- failure and re-import

test("PostgreSQL: a database error on any table leaves no rows, no files and no work items", async () => {
  for (const tbl of WORKBOOK_TABLES) {
    await freshDb();
    await pg.query("insert into public.test_faults values ($1)", [tbl]);
    const { status, body } = await post(generatedWorkbook());
    assert.equal(status, 503, tbl);
    assert.match(body.error, /nothing was imported/);
    for (const t of WORKBOOK_TABLES) assert.equal(await count(t), 0, `${tbl} failure: ${t} empty`);
    assert.equal(db.files.size, 0, `${tbl} failure: no orphaned files`);
    assert.equal(db.tables.work_items.length, 0);
    assert.equal(db.tables.departments.length, 0);
  }
});

test("PostgreSQL: an import for a project that does not exist is refused by the foreign key, with nothing left behind", async () => {
  await freshDb();
  db.tables.users[0].user_role = "ADMIN";
  const { status } = await post(richWorkbook(), { project: "33333333-3333-4333-8333-333333333333" });
  assert.equal(status, 503);
  for (const t of WORKBOOK_TABLES) assert.equal(await count(t), 0);
  assert.equal(db.files.size, 0);
});

test("PostgreSQL: re-import keeps every import complete and separate; a failed re-import doesn't touch the earlier one", async () => {
  await freshDb();
  const bytes = richWorkbook();
  const first = await post(bytes);
  const firstCells = await count("workbook_cells", first.body.importId);
  const itemsBefore = db.tables.work_items.map((w) => w.work_item_id).sort();

  await pg.query("insert into public.test_faults values ('workbook_cells')");
  assert.equal((await post(bytes)).status, 503);
  await pg.query("delete from public.test_faults");
  assert.equal(await count("workbook_imports"), 1, "failed re-import left nothing");
  assert.equal(await count("workbook_cells", first.body.importId), firstCells, "earlier import untouched");

  const second = await post(bytes);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.importId, first.body.importId);
  assert.equal(await count("workbook_imports"), 2);
  await assertPersistedMatchesSource(bytes, first.body.importId);
  await assertPersistedMatchesSource(bytes, second.body.importId);
  assert.deepEqual(db.tables.work_items.map((w) => w.work_item_id).sort(), itemsBefore, "same work items updated, none added");
  const latest = await getExtraction("&format=cells");
  assert.equal(latest.body.importId, second.body.importId, "newest import served by default");
  const older = await getExtraction(`&format=cells&importId=${encodeURIComponent(first.body.importId)}`);
  assert.equal(older.body.cells.length, firstCells);
  // Deleting an import (or its project) removes its sheets and cells with it.
  await pg.query("delete from public.workbook_imports where import_id = $1", [first.body.importId]);
  assert.equal(await count("workbook_cells", first.body.importId), 0, "cascade");
  assert.equal(await count("workbook_cells", second.body.importId), firstCells, "other import kept");
});

test("PostgreSQL: the summary recounts stored cells, lists every sheet/table/header and marks custom (unmapped) columns", async () => {
  await freshDb();
  const bytes = richWorkbook();
  const { body } = await post(bytes);
  const res = await getExtraction("&format=summary");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body;
  assert.equal(s.import.importId, body.importId);
  assert.equal(s.import.complete, true);
  assert.deepEqual(s.import.problems, []);
  assert.deepEqual(s.verification, {
    cellsExpected: sourceCells(bytes).cells.size,
    cellsInDatabase: sourceCells(bytes).cells.size,
    cellsBySheets: sourceCells(bytes).cells.size,
    sheetsExpected: 6,
    sheetsInDatabase: 6,
    matches: true,
  });
  const schedule = s.sheets.find((x) => x.name === "Schedule");
  assert.equal(schedule.populatedColumns, 8);
  assert.equal(schedule.populatedRows, 13);
  const cols = Object.fromEntries(schedule.tables[0].columns.map((c) => [c.header, c.mappedTo]));
  assert.equal(cols.Description, "Description");
  assert.equal(cols["Site Contact"], null, "custom column marked unmapped");
  assert.equal(cols["% Complete"], null);
  const equipment = s.sheets.find((x) => x.name === "Equipment");
  assert.ok(equipment.tables[0].columns.every((c) => c.mappedTo === null), "a non-work-item table: all columns custom");
  const imports = await getExtraction("&format=imports");
  assert.deepEqual(imports.body.imports.map((i) => i.import_id), [body.importId]);

  // An import of another project is not served under this project.
  const other = await post(bytes, { project: OTHER_PROJECT });
  assert.equal(other.status, 200);
  assert.equal((await getExtraction(`&format=summary&importId=${encodeURIComponent(other.body.importId)}`)).status, 404);
  assert.equal((await getExtraction(`&format=rows&sheet=0&importId=${encodeURIComponent(other.body.importId)}`)).status, 404);
  // Unknown sheet → 404; missing sheet → 400.
  assert.equal((await getExtraction("&format=rows&sheet=Nope")).status, 404);
  assert.equal((await getExtraction("&format=rows")).status, 400);
  // Sheet by index; page beyond the end clamps to the last page.
  const last = await getExtraction("&format=rows&sheet=1&page=99&pageSize=5");
  assert.equal(last.body.sheet.name, "Schedule");
  assert.equal(last.body.page, 3);
  assert.deepEqual(last.body.rows.map((r) => r.row), [13, 14, 15], "orders 11-13; blank rows 2 and 12 are gaps, not rows");
});

test("PostgreSQL: an incomplete (malformed) sheet is stored as an incomplete import, with the problem named", async () => {
  await freshDb();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Item No", "Description", "Qty"], ["1", "Sound sheet", 3]]), "Good");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Item No", "Description", "Qty"], ["1", "Broken sheet", 4], ["2", "Lost row", 5]]), "Broken");
  const bytes = Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  // Corrupt the second sheet's XML (an unterminated row) the way the
  // malformed-sheet test in excel-import.test.cjs does.
  const corrupted = corruptSecondSheet(bytes);
  const { status, body } = await post(corrupted);
  assert.equal(status, 200, JSON.stringify(body));
  const s = (await getExtraction("&format=summary")).body;
  assert.equal(s.import.complete, false, "not shown as a complete extraction");
  assert.ok(s.import.problems.some((p) => p.startsWith("Broken:")), JSON.stringify(s.import.problems));
  assert.equal(s.verification.matches, true, "what was read is all stored");
});

/** The workbook with its second sheet's XML cut short (malformed). */
function corruptSecondSheet(bytes) {
  const zip = XLSX.CFB.read(bytes, { type: "buffer" });
  const i = zip.FullPaths.findIndex((p) => /sheet2\.xml$/.test(p));
  zip.FileIndex[i].content = Buffer.from(
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c><c r="B1"><v>5</v></c></row>GARBAGE<<<'
  );
  return new Uint8Array(XLSX.CFB.write(zip, { type: "buffer", fileType: "zip" }));
}

test("PostgreSQL: formulas saved without a cached result (generated workbooks) are kept — never dropped, never read as 0", async () => {
  await freshDb();
  const bytes = uncachedFormulaWorkbook();
  assert.equal(sourceCells(bytes).cells.get("Items!E2").value, undefined, "fixture: no cached result");
  const { status, body } = await post(bytes);
  assert.equal(status, 200, JSON.stringify(body));
  const { cells, imp } = await assertPersistedMatchesSource(bytes, body.importId);
  assert.equal(imp.complete, true, "every value cell the file declares was read");
  for (const ref of ["Items!E2", "Items!E3", "Items!E4", "Summary!B1"]) {
    const c = cells.get(ref);
    assert.ok(c.formula, `${ref} formula kept`);
    assert.equal(c.value_number, null, `${ref}: no invented value`);
    assert.equal(c.value_type, "empty");
  }
  assert.equal(cells.get("Items!E4").formula, "SUM(E2:E3)");
  assert.equal(cells.get("Items!E2").header, "Amount");
  assert.equal(imp.formula_cell_count, 4);
  // Layer 2: the amount stays empty (no cached result), not 0.
  const excavation = db.tables.work_items.find((w) => w.description_of_work === "Excavation");
  assert.equal(excavation.scheduled_value, null);
  assert.equal(excavation.planned_quantity, 40);
});
