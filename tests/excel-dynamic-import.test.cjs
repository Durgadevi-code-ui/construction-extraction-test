/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Fully dynamic Excel import, end to end through the real import route
// (app/api/admin/projects/import/route.ts) with an in-memory database and
// file storage in place of Supabase. Proves two layers:
//   Layer 1 — every populated cell of every worksheet is extracted with its
//             sheet's own structure and STORED; checked against an
//             independent read of the source file, cell by cell.
//   Layer 2 — rows of work-item tables become work items without merging,
//             inventing or mis-mapping; other tables never become items.
// Only the session, the database client and the storage client are
// replaced; parsing, extraction, mapping, storage and upsert code is real.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const XLSX = require("xlsx");

const ROOT = path.resolve(__dirname, "..");
function stub(rel, exports) {
  const file = require.resolve(path.join(ROOT, rel));
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}

const { fakeSupabase } = require("./support/fakeSupabase.cjs");
const { richWorkbook, generatedWorkbook, sourceCells } = require("./support/workbooks.cjs");

const ADMIN = { authUserId: "auth-admin", userId: "user-admin", email: "admin@example.com" };
let db = fakeSupabase();
stub("lib/session.ts", { getCurrentUser: async () => ADMIN, requireCurrentUser: async () => ADMIN });
stub("lib/supabase.ts", { getSupabaseClient: () => db });
stub("lib/supabaseAdmin.ts", { getSupabaseServiceRoleClient: () => db, createPasswordCheckClient: () => db });
delete process.env.RATE_LIMIT_BACKEND;
delete process.env.VERCEL_ENV;

const importRoute = require("../app/api/admin/projects/import/route.ts");
const extractionRoute = require("../app/api/admin/projects/import/extraction/route.ts");
const { NextRequest } = require("next/server");
const PROJECT = "project-1";

function freshDb(faults) {
  db = fakeSupabase(faults);
  db.tables.users.push({ user_id: ADMIN.userId, user_role: "ADMIN", status: "Active", user_mail: ADMIN.email });
  return db;
}
async function post(bytes, { commit = false, name = "Riverside_Clinic.xlsx" } = {}) {
  const form = new FormData();
  form.set("projectId", PROJECT);
  form.set("file", new File([bytes], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  if (commit) form.set("commit", "1");
  const res = await importRoute.POST(new NextRequest("http://localhost/api/admin/projects/import", { method: "POST", body: form }));
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------- realistic workbooks

function deepHeaderWorkbook() {
  const rows = [["Project information"]];
  for (let i = 0; i < 54; i++) rows.push(i % 2 ? [] : [`Info line ${i}`, `value ${i}`]);
  rows.push(["Line", "Scope of Work", "Quantity", "Unit", "Value", "Remarks"]);
  rows.push(["L1", "Drywall level 2", 900, "SF", 12600, "Night shift"]);
  rows.push(["L2", "Paint level 2", 900, "SF", 5400, null]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Deep");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

function mergedHeaderWorkbook() {
  const ws = XLSX.utils.aoa_to_sheet([
    ["Item", "Description", "Work Completed", null, "Balance"],
    [null, null, "Previous", "This Period", null],
    ["1", "Excavation", 10000, 2500, 7500],
    ["2", "Backfill", 4000, 1000, 3000],
  ]);
  ws["!merges"] = [{ s: { r: 0, c: 2 }, e: { r: 0, c: 3 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "G703");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

function storedExtraction() {
  const entry = [...db.files.entries()].find(([p]) => p.startsWith(`projects/${PROJECT}/extractions/`));
  assert.ok(entry, "an extraction JSON was stored");
  return JSON.parse(new TextDecoder().decode(entry[1]));
}

function assertEveryCellStored(bytes, extraction) {
  const src = sourceCells(bytes);
  assert.deepEqual(extraction.sheets.map((s) => s.name), src.names, "all worksheets, original order");
  const stored = new Map();
  for (const s of extraction.sheets) {
    for (const r of s.rows) {
      for (const c of r.cells) {
        const key = `${s.name}!${c.ref}`;
        assert.ok(!stored.has(key), `${key} stored once`);
        stored.set(key, { ...c, rowRole: r.role, order: r.order });
      }
    }
  }
  for (const [key, cell] of src.cells) {
    const got = stored.get(key);
    assert.ok(got, `${key} is in the stored extraction`);
    const expected = cell.value === undefined ? null : typeof cell.value === "number" || typeof cell.value === "boolean" ? cell.value : String(cell.value);
    assert.equal(got.value, expected, `${key} value unchanged`);
    assert.equal(got.formula, cell.formula, `${key} formula kept`);
  }
  assert.equal(stored.size, src.cells.size, "no invented cells");
  return stored;
}

// ================================================================ Layer 1 through the real route

test("preview: every sheet, its own tables and headers are discovered dynamically (no fixed column names)", async () => {
  freshDb();
  const { status, body } = await post(richWorkbook());
  assert.equal(status, 200);
  const sheets = Object.fromEntries(body.workbook.sheets.map((s) => [s.name, s]));
  assert.deepEqual(body.workbook.sheets.map((s) => s.name), ["Cover", "Schedule", "Change Orders", "Equipment", "Notes", "Rates"]);
  assert.equal(sheets.Rates.visibility, "hidden", "hidden sheet included");
  assert.deepEqual(sheets.Schedule.tables.map((t) => t.columns), [
    ["Item No", "Description", "Qty", "Unit", "Amount", "% Complete", "Start", "Site Contact"],
    ["Code", "Allowance", "Budget", "Owner Approved"],
  ], "two tables on one sheet, each with its own headers");
  assert.deepEqual(sheets.Equipment.tables[0].columns, ["Asset Tag", "Make", "Model", "Hours", "Last Service", "Operator"], "custom columns never defined in the app");
  assert.deepEqual(sheets["Change Orders"].tables[0].columns, ["Item No", "Description", "Amount", "Approved By"]);
  assert.equal(sheets.Cover.tables.length, 0);
  assert.equal(sheets.Cover.rowsByRole.metadata, 4);
  assert.equal(body.workbook.totals.cells, sourceCells(richWorkbook()).cells.size, "every populated cell counted");
  assert.equal(db.tables.work_items.length, 0, "preview writes nothing");
  assert.equal(db.files.size, 0, "preview stores nothing");
});

test("commit: the original file and the COMPLETE extraction are stored; every source cell is in it, unchanged", async () => {
  freshDb();
  const bytes = richWorkbook();
  const { status, body } = await post(bytes, { commit: true });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.extractionStored, true);
  const original = [...db.files.entries()].find(([p]) => p.startsWith(`projects/${PROJECT}/imports/`));
  assert.ok(original, "original stored");
  assert.deepEqual(Buffer.from(original[1]), Buffer.from(bytes), "original byte-for-byte");

  const ex = storedExtraction();
  const stored = assertEveryCellStored(bytes, ex);
  // Relationships: sheet, row, column header, original order, dates, formulas.
  assert.equal(stored.get("Equipment!E2").header, "Last Service");
  assert.equal(stored.get("Equipment!E2").date, "2024-11-04"); // Excel day 45600
  assert.equal(stored.get("Equipment!B3").header, "Make");
  assert.equal(stored.get("Schedule!C14").header, "Budget");
  assert.equal(stored.get("Schedule!C14").value, 25000);
  assert.equal(stored.get("Schedule!E11").formula, "C11*2500");
  assert.equal(stored.get("Schedule!E11").value, 10000);
  assert.equal(stored.get("Schedule!H5").header, "Site Contact");
  assert.equal(stored.get("Schedule!A9").rowRole, "total");
  assert.equal(stored.get("Schedule!A4").rowRole, "section");
  assert.equal(stored.get("Schedule!A8").rowRole, "note");
  assert.equal(stored.get("Cover!B3").rowRole, "metadata");
  assert.equal(stored.get("Notes!A4").rowRole, "title");
  const scheduleRows = ex.sheets.find((s) => s.name === "Schedule").rows;
  assert.deepEqual(scheduleRows.map((r) => r.order), scheduleRows.map((_, i) => i + 1), "original order kept");
  assert.deepEqual(scheduleRows.map((r) => r.row).slice(0, 3), [1, 3, 4], "real sheet row numbers (row 2 was blank)");
});

test("commit: the extraction API returns it — full or as { header: value } records for AI/reporting", async () => {
  freshDb();
  await post(richWorkbook(), { commit: true });
  const get = async (q) => {
    const res = await extractionRoute.GET(new NextRequest(`http://localhost/api/admin/projects/import/extraction?projectId=${PROJECT}${q}`));
    return { status: res.status, body: await res.json() };
  };
  const full = await get("");
  assert.equal(full.status, 200);
  assert.equal(full.body.extraction.sheets.length, 6);
  const rec = await get("&format=records");
  const equipment = rec.body.sheets.find((s) => s.name === "Equipment").tables[0];
  assert.deepEqual(equipment.records[0].values, { "Asset Tag": "EQ-101", Make: "CAT", Model: "320", Hours: 1820.5, "Last Service": "2024-11-04", Operator: "M. Silva" });
  assert.equal(equipment.records.length, 3);
  const cover = rec.body.sheets.find((s) => s.name === "Cover");
  assert.equal(cover.other.length, 5, "rows outside tables are returned too");
  const list = await get("&list=1");
  assert.equal(list.body.imports.length, 1);
});

// ================================================================ Layer 2: work items, no merging, no fakes

test("commit: each table is mapped on its own headers; rate tables, notes, totals and headers never become work items", async () => {
  freshDb();
  await post(richWorkbook(), { commit: true });
  const items = db.tables.work_items;
  const bySource = items.map((w) => `${w.additional_fields.__source.sheet}!${w.additional_fields.__source.row}`).sort();
  assert.deepEqual(
    bySource,
    ["Change Orders!2", "Change Orders!3", "Schedule!11", "Schedule!14", "Schedule!15", "Schedule!5", "Schedule!6", "Schedule!7"].sort()
  );
  // The allowance table (Code | Allowance | Budget | Owner Approved) is
  // mapped on ITS OWN header: budget is the value, not a quantity.
  const contingency = items.find((w) => w.line_item_no === "A-1");
  assert.equal(contingency.description_of_work, "Owner contingency");
  assert.equal(contingency.scheduled_value, 25000);
  assert.equal(contingency.planned_quantity, null);
  assert.equal(contingency.additional_fields["Owner Approved"], "Yes");
  assert.equal(contingency.additional_fields.__source.table, 2);
  // A rate list (Trade | Rate/hr | OT Rate) has no work-item columns.
  assert.ok(!items.some((w) => w.additional_fields.__source.sheet === "Rates"), "rates are not work items");
  assert.ok(!items.some((w) => /^Item \d/.test(w.description_of_work)), "no invented descriptions");
  assert.ok(
    !items.some((w) => w.line_item_no === "Code" || w.description_of_work === "Allowance" || /SUBTOTAL/i.test(w.line_item_no) || /^Note:/i.test(w.description_of_work)),
    "no header, note or total rows"
  );
});

test("commit: the same item number on two sheets becomes TWO work items — nothing merged or overwritten", async () => {
  freshDb();
  await post(richWorkbook(), { commit: true });
  const ones = db.tables.work_items.filter((w) => w.line_item_no === "1");
  assert.equal(ones.length, 2);
  assert.deepEqual(ones.map((w) => w.description_of_work).sort(), ["CO-01 Added footing at grid C", "Footings"]);
  const footings = ones.find((w) => w.description_of_work === "Footings");
  assert.equal(footings.scheduled_value, 48000, "the schedule's value is not overwritten by the change order's");
  assert.equal(footings.additional_fields["Site Contact"], "R. Patel", "unknown column kept with the item");
  const co = ones.find((w) => w.description_of_work !== "Footings");
  assert.equal(co.additional_fields["Approved By"], "J. Owner");
});

test("commit: provenance is kept and a missing item number is never presented as the file's", async () => {
  freshDb();
  await post(richWorkbook(), { commit: true });
  const rebar = db.tables.work_items.find((w) => w.description_of_work === "Rebar allowance");
  assert.match(rebar.line_item_no, /^AUTO-\d+$/);
  assert.deepEqual(
    { ...rebar.additional_fields.__source, importId: "x" },
    { importId: "x", sheet: "Schedule", row: 7, table: 1, lineItemNo: null },
    "sheet, row, table and the original (blank) item number are recorded"
  );
});

test("re-import of the same file updates the same work items — no duplicates, still no merging", async () => {
  freshDb();
  const bytes = richWorkbook();
  await post(bytes, { commit: true });
  const before = db.tables.work_items.map((w) => w.work_item_id).sort();
  const second = await post(bytes, { commit: true });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(db.tables.work_items.map((w) => w.work_item_id).sort(), before, "same items");
  assert.equal(second.body.workItemsCreated, 0);
  assert.equal(second.body.workItemsUpdated, 8);
  assert.equal(db.tables.work_items.filter((w) => w.line_item_no === "1").length, 2);
  assert.equal([...db.files.keys()].filter((p) => p.includes("/extractions/")).length, 2, "each import's extraction kept");
});

test("storage failure: nothing is imported (no work items, no half-stored file)", async () => {
  freshDb({ storageFails: true });
  const { status, body } = await post(richWorkbook(), { commit: true });
  assert.equal(status, 503);
  assert.match(body.error, /nothing was imported/);
  assert.equal(db.tables.work_items.length, 0);
  assert.equal(db.tables.departments.length, 0);
  assert.equal(db.files.size, 0);
});

test("a workbook with NO work-item table is still extracted and can be stored (no work items)", async () => {
  freshDb();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Company", "Phone"], ["Ann Lee", "ABC", "555-0101"], ["Raj Shah", "XYZ", "555-0102"]]), "Contacts");
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const preview = await post(bytes);
  assert.equal(preview.status, 200);
  assert.match(preview.body.notice, /no sheet has a work-item table/);
  const commit = await post(bytes, { commit: true });
  assert.equal(commit.status, 200);
  assert.equal(db.tables.work_items.length, 0);
  assertEveryCellStored(bytes, storedExtraction());
  assert.deepEqual(storedExtraction().sheets[0].tables[0].columns.map((c) => c.header), ["Name", "Company", "Phone"]);
});

test("header below row 50 and a two-row merged header are both found; every cell stored", async () => {
  freshDb();
  const deep = deepHeaderWorkbook();
  const r1 = await post(deep, { commit: true });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assertEveryCellStored(deep, storedExtraction());
  assert.deepEqual(
    db.tables.work_items.map((w) => [w.line_item_no, w.description_of_work, w.planned_quantity, w.scheduled_value, w.additional_fields.Remarks ?? null]),
    [["L1", "Drywall level 2", 900, 12600, "Night shift"], ["L2", "Paint level 2", 900, 5400, null]]
  );

  freshDb();
  const merged = mergedHeaderWorkbook();
  await post(merged, { commit: true });
  const ex = storedExtraction();
  assertEveryCellStored(merged, ex);
  assert.deepEqual(ex.sheets[0].tables[0].columns.map((c) => c.header), ["Item", "Description", "Work Completed / Previous", "Work Completed / This Period", "Balance"]);
});

// ================================================================ Layer 1 in the database (workbook_* tables)

/** Every source cell is exactly one workbook_cells row with the same value
 * and formula, and the same header/role as the stored JSON extraction. */
function assertEveryCellInDb(bytes) {
  const src = sourceCells(bytes);
  const json = assertEveryCellStored(bytes, storedExtraction());
  const imports = db.tables.workbook_imports ?? [];
  assert.equal(imports.length, 1, "one workbook_imports row");
  const cells = (db.tables.workbook_cells ?? []).filter((c) => c.import_id === imports[0].import_id);
  const sheets = (db.tables.workbook_sheets ?? []).filter((s) => s.import_id === imports[0].import_id);
  assert.deepEqual(sheets.map((s) => s.sheet_name), src.names, "a workbook_sheets row for every worksheet, in order");
  const byKey = new Map();
  for (const c of cells) {
    const key = `${c.sheet_name}!${c.cell_ref}`;
    assert.ok(!byKey.has(key), `${key} stored once in the database`);
    byKey.set(key, c);
  }
  for (const [key, cell] of src.cells) {
    const row = byKey.get(key);
    assert.ok(row, `${key} is in workbook_cells`);
    const v = cell.value;
    if (typeof v === "number") assert.equal(row.value_number, v, `${key} number unchanged`);
    else if (typeof v === "boolean") assert.equal(row.value_boolean, v, `${key} boolean unchanged`);
    else if (v !== undefined && v !== null && v !== "") assert.equal(row.value_text, String(v), `${key} text unchanged`);
    assert.equal(row.formula ?? undefined, cell.formula, `${key} formula kept`);
    const j = json.get(key);
    assert.equal(row.header ?? undefined, j.header, `${key} header`);
    assert.equal(row.row_role, j.rowRole, `${key} row role`);
    assert.equal(row.row_order, j.order, `${key} row order`);
    assert.equal(row.row_number, Number(key.match(/\d+$/)[0]), `${key} original row number`);
  }
  assert.equal(byKey.size, src.cells.size, "no invented cells in the database");
  assert.equal(imports[0].cell_count, src.cells.size);
  assert.equal(imports[0].sheet_count, src.names.length);
  return { imports, sheets, cells: byKey };
}

test("database: every populated cell of every sheet is a workbook_cells row with its own header, role and order", async () => {
  freshDb();
  const bytes = richWorkbook();
  const { status, body } = await post(bytes, { commit: true });
  assert.equal(status, 200, JSON.stringify(body));
  const { imports, sheets, cells } = assertEveryCellInDb(bytes);
  assert.equal(imports[0].import_id, body.importId);
  assert.equal(imports[0].project_id, PROJECT);
  assert.equal(imports[0].imported_by, ADMIN.userId);
  assert.equal(cells.get("Equipment!E2").header, "Last Service");
  assert.equal(cells.get("Equipment!E2").value_date, "2024-11-04");
  assert.equal(cells.get("Schedule!E11").formula, "C11*2500");
  assert.equal(cells.get("Schedule!H5").header, "Site Contact");
  assert.equal(cells.get("Schedule!C14").table_index, 2, "second table on the same sheet");
  assert.equal(cells.get("Schedule!A9").row_role, "total");
  assert.equal(sheets.find((s) => s.sheet_name === "Rates").visibility, "hidden");
  assert.deepEqual(sheets.find((s) => s.sheet_name === "Equipment").tables[0].columns.map((c) => c.header), ["Asset Tag", "Make", "Model", "Hours", "Last Service", "Operator"]);
  // Work items point back to their source rows in the database.
  for (const w of db.tables.work_items) {
    const src = w.additional_fields.__source;
    assert.equal(src.importId, body.importId);
    assert.ok([...cells.values()].some((c) => c.sheet_name === src.sheet && c.row_number === src.row), `${src.sheet} row ${src.row} is in workbook_cells`);
  }
});

test("database: a large generated 5-sheet workbook (different columns, rows, headers, two tables per sheet) is stored cell for cell", async () => {
  freshDb();
  const bytes = generatedWorkbook();
  const src = sourceCells(bytes);
  assert.ok(src.cells.size > 5000, `stress size (${src.cells.size} cells) spans several insert batches`);
  const { status, body } = await post(bytes, { commit: true });
  assert.equal(status, 200, JSON.stringify(body));
  const { sheets } = assertEveryCellInDb(bytes);
  sheets.slice(0, 4).forEach((s, i) => {
    const k = i + 1;
    assert.equal(s.tables.length, 2, `${s.sheet_name}: both tables found`);
    assert.equal(s.tables[0].columns.length, 3 + k * 5, `${s.sheet_name}: its own column count`);
    assert.equal(s.tables[0].columns[1].header, `Custom ${k}.2`);
    assert.deepEqual(s.tables[1].columns.map((c) => c.header), [`Side table ${k}`, "Amount", "Flag"]);
  });
  // Only the work-item table maps, with every row its own item (duplicate
  // item numbers kept apart) and unknown columns kept with the item.
  const items = db.tables.work_items;
  assert.equal(items.length, 30);
  assert.ok(items.every((w) => w.additional_fields.__source.sheet === "Bid Items"));
  assert.equal(items.filter((w) => w.additional_fields.__source.lineItemNo === "1").length, 2);
  const t2 = items.find((w) => w.description_of_work === "Synthetic task 2");
  assert.equal(t2.additional_fields.Crew, "Crew 1");
  assert.equal(t2.additional_fields.Inspector, "Insp 1");
  assert.equal(t2.additional_fields["Risk Score"], 0.1);
});

test("database: the cells API returns every stored cell (paged), optionally for one sheet", async () => {
  freshDb();
  const bytes = generatedWorkbook();
  await post(bytes, { commit: true });
  const get = async (q) => {
    const res = await extractionRoute.GET(new NextRequest(`http://localhost/api/admin/projects/import/extraction?projectId=${PROJECT}${q}`));
    return { status: res.status, body: await res.json() };
  };
  const all = await get("&format=cells");
  assert.equal(all.status, 200);
  const src = sourceCells(bytes);
  assert.equal(all.body.cells.length, src.cells.size, "more than one page, nothing dropped");
  assert.equal(new Set(all.body.cells.map((c) => `${c.sheet_name}!${c.cell_ref}`)).size, src.cells.size);
  const one = await get(`&format=cells&sheet=${encodeURIComponent("Register 2")}`);
  assert.ok(one.body.cells.length > 0 && one.body.cells.every((c) => c.sheet_name === "Register 2"));
  const ordered = one.body.cells.map((c) => c.row_number * 1000 + c.col_index);
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b), "sheet/row/column order");
  freshDb();
  assert.equal((await get("&format=cells")).status, 404);
});

test("database failure: nothing is imported and nothing half-stored (files, extraction rows, work items)", async () => {
  for (const failInsert of ["workbook_imports", "workbook_sheets", "workbook_cells"]) {
    freshDb({ failInsert });
    const { status, body } = await post(generatedWorkbook(), { commit: true });
    assert.equal(status, 503, failInsert);
    assert.match(body.error, /nothing was imported/);
    assert.equal(db.files.size, 0, `${failInsert}: stored files removed`);
    for (const t of ["workbook_imports", "workbook_sheets", "workbook_cells", "work_items", "departments"]) {
      assert.equal((db.tables[t] ?? []).length, 0, `${failInsert}: ${t} empty`);
    }
  }
});
