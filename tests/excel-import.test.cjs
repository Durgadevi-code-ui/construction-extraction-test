/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Excel import fidelity tests: every worksheet and every populated cell
// of an uploaded workbook must reach the raw extraction unchanged, every
// populated row must be accounted for (work item, or reported with a
// reason), and the work-item mapping must stay compatible with the app.
// Workbooks are built in memory as real .xlsx files. Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const XLSX = require("xlsx");

const ROOT = path.resolve(__dirname, "..");

// ---- in-memory Supabase (commit path only) ----------------------------
/** Just enough of the PostgREST builder for upsertWorkItemFromImport and
 * findOrCreateProjectDepartment: select/insert/update with eq filters,
 * head counts and single(). */
function memorySupabase() {
  const tables = { departments: [], work_items: [], standard_departments: [] };
  let seq = 0;
  return {
    tables,
    from(table) {
      const q = { op: "select", filters: [], head: false, single: false, payload: null };
      const rows = () => (tables[table] ??= []);
      const builder = {
        select(_cols, opts) {
          if (q.op === "select" && opts?.head) q.head = true;
          return builder;
        },
        insert(payload) {
          q.op = "insert";
          q.payload = payload;
          return builder;
        },
        update(payload) {
          q.op = "update";
          q.payload = payload;
          return builder;
        },
        eq(col, value) {
          q.filters.push((r) => r[col] === value);
          return builder;
        },
        single() {
          q.single = true;
          return builder;
        },
        then(resolve, reject) {
          try {
            const match = (r) => q.filters.every((f) => f(r));
            let result;
            if (q.op === "insert") {
              const row = { ...q.payload, [table === "departments" ? "department_id" : "work_item_id"]: `${table}-${++seq}` };
              rows().push(row);
              result = { data: q.single ? row : [row], error: null };
            } else if (q.op === "update") {
              rows().filter(match).forEach((r) => Object.assign(r, q.payload));
              result = { data: null, error: null };
            } else {
              const found = rows().filter(match).map((r) => ({ ...r }));
              result = q.head ? { count: found.length, data: null, error: null } : { data: q.single ? found[0] ?? null : found, error: null };
            }
            resolve(result);
          } catch (err) {
            reject(err);
          }
        },
      };
      return builder;
    },
  };
}

let supabase = memorySupabase();
{
  const file = require.resolve(path.join(ROOT, "lib/supabaseAdmin.ts"));
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = { getSupabaseServiceRoleClient: () => supabase };
  require.cache[file] = m;
}

const { parseProjectWorkbook } = require("../lib/excelImport.ts");
const { upsertWorkItemFromImport } = require("../lib/admin.ts");

// ---- workbook builders -------------------------------------------------
/** sheets: [{ name, aoa, origin?, merges?, hidden? }] → .xlsx bytes. */
function buildXlsx(sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = s.aoa ? XLSX.utils.aoa_to_sheet(s.aoa, s.origin ? { origin: s.origin } : undefined) : {};
    if (s.merges) ws["!merges"] = s.merges.map((m) => XLSX.utils.decode_range(m));
    XLSX.utils.book_append_sheet(wb, ws, s.name);
    if (s.hidden) XLSX.utils.book_set_sheet_visibility(wb, s.name, 1);
  }
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

const toArrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const parse = (bytes) => parseProjectWorkbook(toArrayBuffer(bytes));

/**
 * Source-versus-extracted check, for every workbook in this file:
 *   - every worksheet discovered, names and order preserved;
 *   - every populated source cell present in the raw extraction at the
 *     same A1 location and row, with the same stored value and formula
 *     (no rounding, trimming or type change), and nothing extra;
 *   - every populated row accounted for exactly once (work item, or a
 *     classified row with a reason), mapped rows pointing at real rows.
 */
function assertFaithful(bytes, parsed) {
  const src = XLSX.read(bytes, { type: "buffer", cellNF: true, cellFormula: true });
  assert.deepEqual(parsed.raw.sheets.map((s) => s.name), src.SheetNames, "every worksheet, in workbook order");
  assert.equal(parsed.extraction.sheetsDiscovered, src.SheetNames.length);
  src.SheetNames.forEach((name, i) => {
    const ws = src.Sheets[name];
    const rawSheet = parsed.raw.sheets[i];
    const rawCells = new Map(rawSheet.rows.flatMap((r) => r.cells.map((c) => [c.ref, c])));
    let expected = 0;
    for (const key of Object.keys(ws)) {
      if (key.startsWith("!")) continue;
      const cell = ws[key];
      const populated = !!cell.f || cell.t === "e" || (cell.t !== "z" && cell.v !== undefined && cell.v !== "");
      if (!populated) continue;
      expected++;
      const raw = rawCells.get(key);
      assert.ok(raw, `${name}!${key} missing from raw extraction`);
      assert.equal(raw.row, XLSX.utils.decode_cell(key).r + 1, `${name}!${key} row`);
      assert.equal(raw.formula, cell.f, `${name}!${key} formula`);
      if (cell.f && cell.v === undefined) assert.equal(raw.value, null, `${name}!${key} uncached formula`);
      else if (cell.t === "e") assert.equal(raw.text, cell.w, `${name}!${key} error text`);
      else assert.strictEqual(raw.value, cell.v, `${name}!${key} value`);
    }
    assert.equal(rawSheet.populatedCells, expected, `${name}: populated cell count`);

    const report = parsed.extraction.sheets[i];
    assert.equal(report.name, name);
    const classified = Object.values(report.rowsByKind).reduce((a, b) => a + b, 0);
    assert.equal(classified, rawSheet.populatedRows, `${name}: every populated row classified`);
    assert.equal(report.rowsMapped + report.unmappedRows.length, rawSheet.populatedRows, `${name}: rows accounted for`);
    for (const u of report.unmappedRows) assert.ok(u.reason, `${name} row ${u.row}: reason given`);
    const mapped = parsed.rows.filter((r) => r.sourceSheet === name);
    assert.equal(mapped.length, report.rowsMapped, `${name}: mapped count`);
    for (const row of mapped) assert.ok(rawSheet.rows.some((rr) => rr.row === row.sourceRow), `${name} row ${row.sourceRow} exists`);
  });
  assert.equal(parsed.extraction.rowsMapped, parsed.rows.length);
  assert.equal(parsed.extraction.rowsMapped + parsed.extraction.rowsNotMapped, parsed.extraction.populatedRows);
}

/** Every non-blank value of `aoa` is in the raw extraction unchanged. */
function assertMatchesSource(parsed, sheetName, aoa, origin = "A1") {
  const sheet = parsed.raw.sheets.find((s) => s.name === sheetName);
  const cells = new Map(sheet.rows.flatMap((r) => r.cells.map((c) => [c.ref, c])));
  const o = XLSX.utils.decode_cell(origin);
  aoa.forEach((row, r) =>
    row.forEach((value, c) => {
      if (value === null || value === undefined || value === "") return;
      const ref = XLSX.utils.encode_cell({ r: o.r + r, c: o.c + c });
      const expected = typeof value === "object" ? value.v : value;
      if (expected === undefined) return;
      assert.strictEqual(cells.get(ref)?.value, expected, `${sheetName}!${ref}`);
    })
  );
}

const kindOf = (parsed, sheet, row) =>
  parsed.extraction.sheets.find((s) => s.name === sheet).unmappedRows.find((u) => u.row === row)?.kind ?? "work-item";

// ---- 1. one worksheet --------------------------------------------------
const SINGLE = [
  ["Department", "Item No", "Description of Work", "Quantity", "Unit", "Scheduled Value", "Retainage"],
  ["Concrete", "101", "Pour slab level 2", 120.5, "CY", 45000.75, 0.1],
  ["Concrete", "102", "  Footings, grid A-C  ", 64, "CY", 18000, null],
  ["Electrical", "201", "Rough-in conduit", 1500, "LF", 22500, 0.05],
];

test("1. one worksheet: every row and value extracted; mapping unchanged from the existing format", () => {
  const bytes = buildXlsx([{ name: "Work Items", aoa: SINGLE }]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  assertMatchesSource(parsed, "Work Items", SINGLE);
  assert.equal(parsed.extraction.complete, true);
  assert.deepEqual(
    parsed.rows.map((r) => [r.sourceRow, r.department, r.workItemNo, r.description, r.plannedQuantity, r.unitOfMeasure, r.scheduledValue, r.additionalFields]),
    [
      [2, "Concrete", "101", "Pour slab level 2", 120.5, "CY", 45000.75, { Retainage: 0.1 }],
      [3, "Concrete", "102", "Footings, grid A-C", 64, "CY", 18000, null],
      [4, "Electrical", "201", "Rough-in conduit", 1500, "LF", 22500, { Retainage: 0.05 }],
    ]
  );
  // Raw keeps the description exactly as typed (the mapped field is trimmed).
  assert.equal(parsed.raw.sheets[0].rows[2].cells[2].value, "  Footings, grid A-C  ");
  assert.deepEqual(parsed.issues, []);
});

// ---- 2. two worksheets -------------------------------------------------
const CONCRETE = [
  ["Item No", "Description", "Qty", "Unit", "Department"],
  ["C-1", "Formwork", 300, "SF", "Concrete"],
  ["C-2", "Rebar", 12, "TON", "Concrete"],
];
const ELECTRICAL = [
  ["Item No", "Description", "Qty", "Unit", "Department"],
  ["E-1", "Panelboards", 4, "EA", "Electrical"],
  ["E-2", "Lighting fixtures", 180, "EA", "Electrical"],
  ["E-3", "Fire alarm devices", 65, "EA", "Electrical"],
];

test("2. two worksheets: both processed, records keep their own sheet and row", () => {
  const bytes = buildXlsx([
    { name: "Concrete", aoa: CONCRETE },
    { name: "Electrical", aoa: ELECTRICAL },
  ]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  assert.deepEqual(parsed.sheetsScanned, ["Concrete", "Electrical"]);
  assert.deepEqual(parsed.rows.map((r) => `${r.sourceSheet}:${r.sourceRow}:${r.workItemNo}`), [
    "Concrete:2:C-1",
    "Concrete:3:C-2",
    "Electrical:2:E-1",
    "Electrical:3:E-2",
    "Electrical:4:E-3",
  ]);
  assert.equal(parsed.extraction.sheetsWithWorkItems, 2);
  assert.equal(parsed.extraction.complete, true);
});

// ---- 3. several worksheets ---------------------------------------------
test("3. several worksheets (incl. cover, notes and a hidden sheet): all discovered in order, none silently skipped", () => {
  const notes = [["Notes"], ["All quantities are take-off estimates."], ["Rev 3 — issued for bid"]];
  const cover = [["Project", "Tower A"], ["Owner", "Acme Dev LLC"], ["Contract Sum", 1250000]];
  const plumbing = [
    ["Dept", "Item", "Task", "Qty", "UOM"],
    ["Plumbing", "P-1", "Underground sanitary", 120, "LF"],
  ];
  const bytes = buildXlsx([
    { name: "Cover", aoa: cover },
    { name: "Concrete", aoa: CONCRETE },
    { name: "Notes", aoa: notes },
    { name: "Electrical", aoa: ELECTRICAL },
    { name: "Plumbing (hidden)", aoa: plumbing, hidden: true },
  ]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  const sheets = parsed.extraction.sheets;
  assert.deepEqual(sheets.map((s) => s.name), ["Cover", "Concrete", "Notes", "Electrical", "Plumbing (hidden)"]);
  assert.deepEqual(sheets.map((s) => s.mapping), ["not-a-work-item-table", "mapped", "not-a-work-item-table", "mapped", "mapped"]);
  assert.equal(sheets[4].visibility, "hidden");
  assert.equal(parsed.rows.length, 2 + 3 + 1);
  // Cover/notes data is preserved and reported, not dropped.
  assertMatchesSource(parsed, "Cover", cover);
  assert.equal(sheets[0].unmappedRows.length, 3);
  assert.match(sheets[0].unmappedRows[2].text, /Contract Sum \| 1250000/);
});

// ---- 4. data only on the second worksheet ------------------------------
test("4. data only on the second worksheet: the empty first sheet is reported, the second is fully read", () => {
  const bytes = buildXlsx([
    { name: "Sheet1", aoa: null },
    { name: "Schedule", aoa: ELECTRICAL },
  ]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  assert.equal(parsed.extraction.sheets[0].status, "empty");
  assert.equal(parsed.extraction.sheets[1].rowsMapped, 3);
  assert.deepEqual(parsed.rows.map((r) => r.sourceSheet), ["Schedule", "Schedule", "Schedule"]);
  assert.equal(parsed.extraction.complete, true, "an empty sheet loses nothing");
});

// ---- 5. different column layouts across worksheets ---------------------
test("5. different column layouts per sheet: each sheet mapped on its own headers, no columns mixed across sheets", () => {
  const siteWork = [
    ["Ref", "Trade", "Scope of Work", "Amount", "Responsible Party"],
    ["SW-01", "Sitework", "Clear and grub", 12500, "GC"],
    ["SW-02", "Sitework", "Mass excavation", 48000, "Sub A"],
  ];
  const bytes = buildXlsx([
    { name: "Concrete", aoa: CONCRETE },
    { name: "Site", aoa: siteWork, origin: "C3" },
  ]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  assertMatchesSource(parsed, "Site", siteWork, "C3");
  const site = parsed.rows.filter((r) => r.sourceSheet === "Site");
  assert.deepEqual(
    site.map((r) => [r.sourceRow, r.workItemNo, r.department, r.description, r.scheduledValue, r.plannedQuantity, r.additionalFields]),
    [
      [4, "SW-01", "Sitework", "Clear and grub", 12500, null, { "Responsible Party": "GC" }],
      [5, "SW-02", "Sitework", "Mass excavation", 48000, null, { "Responsible Party": "Sub A" }],
    ],
    "real sheet rows (table starts at C3), own columns only"
  );
  for (const r of parsed.rows.filter((x) => x.sourceSheet === "Concrete")) {
    assert.equal(r.scheduledValue, null);
    assert.equal(r.additionalFields, null);
  }
  assert.equal(parsed.columnMappings.find((m) => m.sheet === "Site").headerRow, 3);
});

// ---- 6. multiple header rows and merged headers ------------------------
const G703 = [
  ["AIA DOCUMENT G703 — CONTINUATION SHEET"],
  ["APPLICATION NO.:", 7, null, "PERIOD TO:", { t: "n", v: 45900, z: "m/d/yyyy" }],
  [],
  ["ITEM NO.", "DESCRIPTION OF WORK", "SCHEDULED VALUE", "WORK COMPLETED", null, "MATERIALS PRESENTLY STORED", "TOTAL COMPLETED AND STORED", "%", "BALANCE TO FINISH", "RETAINAGE"],
  [null, null, null, "FROM PREVIOUS APPLICATION", "THIS PERIOD"],
  ["A", "B", "C", "D", "E", "F", "G", "G/C", "H", "I"],
  ["DIVISION 03 — CONCRETE"],
  ["301", "Footings", 50000, 20000, 5000, 0, { t: "n", f: "D8+E8+F8", v: 25000 }, 0.5, 25000, 1250],
  ["302", "Slab on grade", 80000.125, 0, 10000, 2000, { t: "n", f: "D9+E9+F9", v: 12000 }, 0.15, 68000.125, 600],
  ["SUBTOTAL", null, { t: "n", f: "SUM(C8:C9)", v: 130000.125 }],
  ["DIVISION 26 — ELECTRICAL"],
  ["2601", "Conduit rough-in", 22500, 0, 2250, 0, { t: "n", f: "D12+E12+F12", v: 2250 }, 0.1, 20250, 112.5],
  ["GRAND TOTAL", null, { t: "n", f: "C10+C12", v: 152500.125 }],
];

test("6. multiple header rows + merged headers (AIA G703): sub-header columns kept, letter row not a work item", () => {
  const bytes = buildXlsx([{ name: "G703", aoa: G703, merges: ["D4:E4", "A7:J7", "A11:J11"] }]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  assertMatchesSource(parsed, "G703", G703);
  assert.deepEqual(parsed.rows.map((r) => [r.workItemNo, r.department, r.description, r.scheduledValue]), [
    ["301", "CONCRETE", "Footings", 50000],
    ["302", "CONCRETE", "Slab on grade", 80000.125],
    ["2601", "ELECTRICAL", "Conduit rough-in", 22500],
  ]);
  assert.deepEqual(parsed.rows[0].additionalFields, {
    "WORK COMPLETED / FROM PREVIOUS APPLICATION": 20000,
    "WORK COMPLETED / THIS PERIOD": 5000,
    "MATERIALS PRESENTLY STORED": 0,
    "TOTAL COMPLETED AND STORED": 25000,
    "%": 0.5,
    "BALANCE TO FINISH": 25000,
    RETAINAGE: 1250,
  });
  assert.equal(kindOf(parsed, "G703", 5), "header");
  assert.equal(kindOf(parsed, "G703", 6), "header");
  assert.equal(kindOf(parsed, "G703", 1), "info");
  assert.equal(kindOf(parsed, "G703", 2), "info");
  const sheet = parsed.raw.sheets[0];
  assert.deepEqual(sheet.merges, ["D4:E4", "A7:J7", "A11:J11"]);
  assert.equal(sheet.rows.find((r) => r.row === 4).cells.find((c) => c.ref === "D4").merge, "D4:E4");
  assert.equal(sheet.rows.find((r) => r.row === 2).cells.find((c) => c.ref === "E2").date, "2025-08-31");
  assert.equal(parsed.extraction.sheets[0].headerRow, 4);
  assert.deepEqual(parsed.issues, []);
  // Amount columns (25000, 68000.125, …) are never read as CSI codes.
  assert.ok(parsed.rows.every((r) => r.csiLineCode === null));
  const oneRow = parse(buildXlsx([{ name: "G703", aoa: G703.slice(0, 8), merges: ["D4:E4"] }]));
  assert.equal(oneRow.rows[0].csiLineCode, null);
  assert.equal(oneRow.rows[0].additionalFields["WORK COMPLETED / FROM PREVIOUS APPLICATION"], 20000);
});

// ---- 7. blank cells, blank rows and section headings -------------------
test("7. blank cells, blank rows and section headings: rows with blanks kept, gaps preserved as real row numbers", () => {
  const aoa = [
    ["Item", "Description", "Qty", "Unit", "Remarks"],
    [],
    ["SITE WORK"],
    ["1", "Silt fence", 400, "LF", null],
    ["2", "Construction entrance", null, null, "By owner"],
    [],
    [],
    ["FINISHES"],
    ["3", "Paint walls", 5200, "SF", null],
    ["4", "Carpet tile", null, "SY", null],
  ];
  const bytes = buildXlsx([{ name: "Scope", aoa }]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  assert.deepEqual(parsed.rows.map((r) => [r.sourceRow, r.department, r.workItemNo, r.plannedQuantity, r.unitOfMeasure, r.additionalFields]), [
    [4, "SITE WORK", "1", 400, "LF", null],
    [5, "SITE WORK", "2", null, null, { Remarks: "By owner" }],
    [9, "FINISHES", "3", 5200, "SF", null],
    [10, "FINISHES", "4", null, "SY", null],
  ]);
  const sheet = parsed.extraction.sheets[0];
  assert.equal(sheet.blankRowsWithin, 3);
  assert.deepEqual(parsed.raw.sheets[0].rows.map((r) => r.row), [1, 3, 4, 5, 8, 9, 10]);
  assert.equal(kindOf(parsed, "Scope", 3), "heading");
  assert.equal(kindOf(parsed, "Scope", 8), "heading");
});

// ---- 8. division headings, work items, subtotals and totals ------------
test("8. divisions, subtotals and totals: totals preserved in raw and reported, never imported as work items", () => {
  const bytes = buildXlsx([{ name: "G703", aoa: G703 }]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  const report = parsed.extraction.sheets[0];
  assert.equal(report.rowsByKind.division, 2);
  assert.equal(report.rowsByKind.total, 2);
  assert.equal(kindOf(parsed, "G703", 10), "total");
  assert.equal(kindOf(parsed, "G703", 13), "total");
  const grand = parsed.raw.sheets[0].rows.find((r) => r.row === 13).cells.find((c) => c.ref === "C13");
  assert.deepEqual([grand.value, grand.formula], [152500.125, "C10+C12"]);
  assert.ok(!parsed.rows.some((r) => /total/i.test(r.workItemNo ?? "") || /total/i.test(r.description)));
});

// ---- 9. quantities, units, dates and formulas --------------------------
test("9. numbers, units, dates, formulas and formatted identifiers: values unchanged, formulas not recalculated", () => {
  const aoa = [
    ["Item No", "CSI Code", "Description", "Quantity", "Unit", "Unit Price", "Amount", "Start Date", "Finish Date", "Inspected On", "Status"],
    [{ t: "n", v: 53, z: "000" }, { t: "n", v: 33000, z: "00 00 00" }, "Cast-in-place concrete", 12.3456789, "CY", 185.25, { t: "n", f: "D2*F2", v: 2287.0370162250002 }, { t: "n", v: 45658, z: "yyyy-mm-dd" }, { t: "n", v: 45700, z: "m/d/yyyy" }, { t: "n", v: 45710.5, z: "m/d/yyyy h:mm" }, true],
    [{ t: "n", v: 1.1, z: "0.00" }, "03 20 00", "Reinforcing steel", 0.30000000000000004, "TON", 2100, { t: "n", f: "D3*F3" }, null, null, null, false],
    ["055", null, "Waterproofing", "TBD", "SF", 4.5, -250, null, null, { t: "e", v: 0x17, w: "#REF!" }, null],
  ];
  const bytes = buildXlsx([{ name: "Quantities", aoa }]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  const [a, b, c] = parsed.rows;
  // Identifiers exactly as the file shows them.
  assert.deepEqual([a.workItemNo, a.csiLineCode, b.workItemNo, b.csiLineCode, c.workItemNo], ["053", "03 30 00", "1.10", "03 20 00", "055"]);
  // Full precision, no rounding.
  assert.equal(a.plannedQuantity, 12.3456789);
  assert.equal(b.plannedQuantity, 0.30000000000000004);
  assert.equal(a.scheduledValue, 2287.0370162250002, "cached formula result");
  // Dates: mapped and kept (work items have no date columns), extra date columns as ISO, not serials.
  assert.deepEqual([a.startDate, a.endDate], ["2025-01-01", "2025-02-12"]);
  assert.equal(a.additionalFields["Start Date"], "2025-01-01");
  assert.equal(a.additionalFields["Finish Date"], "2025-02-12");
  assert.equal(a.additionalFields["Inspected On"], "2025-02-22T12:00");
  assert.equal(a.additionalFields["Unit Price"], 185.25);
  assert.equal(a.additionalFields.Status, "true");
  // Formula with no saved result: reported, formula kept, not guessed.
  assert.equal(b.scheduledValue, null);
  assert.equal(b.additionalFields.Amount, "=D3*F3");
  assert.ok(parsed.issues.some((i) => i.sourceRow === 3 && /formula with no saved result/.test(i.message)));
  // Text / negative amounts and error cells: reported and kept, not dropped.
  assert.equal(c.plannedQuantity, null);
  assert.equal(c.additionalFields.Quantity, "TBD");
  assert.equal(c.scheduledValue, null);
  assert.equal(c.additionalFields.Amount, -250);
  assert.equal(c.additionalFields["Inspected On"], "#REF!");
  assert.ok(parsed.issues.some((i) => i.sourceRow === 4 && /Quantity "TBD" is not a number/.test(i.message)));
  assert.ok(parsed.issues.some((i) => i.sourceRow === 4 && /negative/.test(i.message)));
  // Raw keeps formulas, cached values and formats.
  const raw = parsed.raw.sheets[0];
  const cell = (ref) => raw.rows.flatMap((r) => r.cells).find((x) => x.ref === ref);
  assert.deepEqual([cell("G2").formula, cell("G2").value], ["D2*F2", 2287.0370162250002]);
  assert.deepEqual([cell("G3").formula, cell("G3").value], ["D3*F3", null]);
  assert.deepEqual([cell("A2").value, cell("A2").text, cell("A2").format], [53, "053", "000"]);
  assert.deepEqual([cell("H2").type, cell("H2").value, cell("H2").date], ["date", 45658, "2025-01-01"]);
  assert.deepEqual([cell("J4").type, cell("J4").text], ["error", "#REF!"]);
  assert.equal(raw.formulaCells, 2);
  assert.equal(raw.formulasWithoutCachedValue, 1);
});

// ---- 10. rows that cannot be mapped ------------------------------------
test("10. unmappable rows: kept in raw extraction and reported with a reason, never invented into work items", () => {
  const aoa = [
    ["Department", "Item No", "Description", "Quantity", "Unit", "Notes"],
    ["Masonry", "M-1", "CMU wall", 2400, "SF", null],
    [null, null, "Coordinate with structural drawings S-201", null, null, null],
    ["Prepared by: J. Estimator"],
    [null, null, null, null, null, "Owner to confirm finish"],
    ["Masonry", "M-2", "Brick veneer", 1800, "SF", "Alt 2"],
  ];
  const bytes = buildXlsx([{ name: "Masonry", aoa }]);
  const parsed = parse(bytes);
  assertFaithful(bytes, parsed);
  assert.deepEqual(parsed.rows.map((r) => r.workItemNo), ["M-1", "M-2"]);
  const unmapped = parsed.extraction.sheets[0].unmappedRows.filter((u) => u.kind !== "header");
  assert.deepEqual(unmapped.map((u) => [u.row, u.kind]), [
    [3, "note"],
    [4, "note"],
    [5, "note"],
  ]);
  assert.match(unmapped[0].text, /Coordinate with structural drawings/);
  assert.match(unmapped[2].text, /Owner to confirm finish/);
  assert.equal(parsed.extraction.rowsNotMapped, 4);
});

// ---- 11. malformed / unsupported worksheet -----------------------------
test("11. malformed worksheet: reported against that sheet, extraction marked incomplete, other sheets still read", () => {
  const good = buildXlsx([
    { name: "Concrete", aoa: CONCRETE },
    { name: "Broken", aoa: ELECTRICAL },
  ]);
  const zip = XLSX.CFB.read(Buffer.from(good), { type: "buffer" });
  const i = zip.FullPaths.findIndex((p) => /sheet2\.xml$/.test(p));
  zip.FileIndex[i].content = Buffer.from(
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c><c r="B1"><v>5</v></c></row>GARBAGE<<<'
  );
  const bytes = new Uint8Array(XLSX.CFB.write(zip, { type: "buffer", fileType: "zip" }));
  const parsed = parse(bytes);
  const broken = parsed.extraction.sheets.find((s) => s.name === "Broken");
  assert.equal(broken.status, "incomplete");
  assert.match(broken.message, /stores 2 value cell\(s\).*only 0 could be read/);
  assert.equal(parsed.extraction.complete, false);
  assert.ok(parsed.extraction.problems.some((p) => p.startsWith('Sheet "Broken":')));
  assert.equal(parsed.extraction.sheets.find((s) => s.name === "Concrete").rowsMapped, 2, "the good sheet is unaffected");
  assert.equal(parsed.rows.length, 2);
});

// ---- cross-cutting -----------------------------------------------------
test("same item number on two sheets: reported, since commit updates one work item for both", () => {
  const b = [
    ["Dept", "Item", "Task", "Qty", "UOM"],
    ["Concrete", "C-1", "Building B formwork", 280, "SF"],
  ];
  const parsed = parse(buildXlsx([{ name: "Building A", aoa: CONCRETE }, { name: "Building B", aoa: b }]));
  const issue = parsed.issues.find((x) => x.sourceSheet === "Building B");
  assert.match(issue.message, /Item # C-1 also appears on sheet "Building A" row 2/);
});

test("commit: re-importing the same multi-sheet workbook creates no duplicate work items or departments", async () => {
  supabase = memorySupabase();
  const bytes = buildXlsx([
    { name: "Concrete", aoa: CONCRETE },
    { name: "G703", aoa: G703, merges: ["D4:E4"] },
  ]);
  const commit = async () => {
    const parsed = parse(bytes);
    let created = 0;
    for (const row of parsed.rows) {
      const result = await upsertWorkItemFromImport(supabase, {
        projectId: "p1",
        departmentName: row.department,
        lineItemNo: row.workItemNo,
        description: row.description,
        plannedQuantity: row.plannedQuantity,
        unitOfMeasure: row.unitOfMeasure,
        scheduledValue: row.scheduledValue,
        csiLineCode: row.csiLineCode,
        additionalFields: row.additionalFields,
      });
      if (result.wasCreated) created++;
    }
    return { created, rows: parsed.rows.length };
  };
  const first = await commit();
  assert.deepEqual(first, { created: 5, rows: 5 });
  const snapshot = JSON.stringify(supabase.tables.work_items);
  const second = await commit();
  assert.deepEqual(second, { created: 0, rows: 5 });
  assert.equal(supabase.tables.work_items.length, 5);
  // "Concrete" and G703's "CONCRETE" are one department (canonical match), plus ELECTRICAL.
  assert.equal(supabase.tables.departments.length, 2);
  assert.equal(JSON.stringify(supabase.tables.work_items), snapshot, "values unchanged by the repeat");
  const slab = supabase.tables.work_items.find((w) => w.line_item_no === "302");
  assert.equal(slab.scheduled_value, 80000.125);
  assert.equal(slab.additional_fields["WORK COMPLETED / THIS PERIOD"], 10000);
});

test("repeated parsing of the same bytes is deterministic", () => {
  const bytes = buildXlsx([{ name: "G703", aoa: G703, merges: ["D4:E4"] }, { name: "Concrete", aoa: CONCRETE }]);
  const a = parse(bytes);
  const b = parse(bytes);
  assert.deepEqual(a.rows, b.rows);
  assert.deepEqual(a.extraction, b.extraction);
});

test("all supported file types (.xlsx, .xls, .csv) go through the same raw extraction", () => {
  for (const bookType of ["xlsx", "biff8", "csv"]) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(SINGLE), "Work Items");
    const out = XLSX.write(wb, { type: "buffer", bookType });
    const bytes = new Uint8Array(typeof out === "string" ? Buffer.from(out) : out);
    const parsed = parse(bytes);
    assert.equal(parsed.rows.length, 3, bookType);
    assert.equal(parsed.extraction.complete, true, bookType);
    assert.equal(parsed.extraction.populatedRows, 4, bookType);
  }
});

test("download export still fills the imported rows when the sheet's table doesn't start at row 1", () => {
  const { refillOriginalWorkbook } = require("../lib/excelExport.ts");
  const bytes = buildXlsx([{ name: "Concrete", aoa: CONCRETE, origin: "B3" }]);
  const parsed = parse(bytes);
  assert.deepEqual(parsed.rows.map((r) => r.sourceRow), [4, 5], "real sheet rows");
  const items = parsed.rows.map((r, i) => ({
    workItemId: `w${i}`,
    departmentId: "d1",
    departmentName: "Concrete",
    lineItemNo: r.workItemNo,
    description: r.description,
    csiLineCode: null,
    scheduledValue: null,
    plannedQuantity: r.plannedQuantity,
    unitOfMeasure: r.unitOfMeasure,
    isActive: true,
    additionalFields: null,
  }));
  const latest = new Map(
    items.map((w, i) => [w.workItemId, { progress: null, approvedQuantity: null, earned: null, balance: null, status: i === 0 ? "In Progress" : "Complete", lastApprovedAt: null, latestUpdate: null, tasks: null }])
  );
  const scope = { projectId: "p1", projectName: "P", departmentIds: new Set(["d1"]), amountDepartmentIds: new Set(["d1"]), fullAccess: true };
  const wb = refillOriginalWorkbook(toArrayBuffer(bytes), scope, items, latest);
  const ws = wb.Sheets.Concrete;
  const range = XLSX.utils.decode_range(ws["!ref"]);
  let statusCol = -1;
  for (let c = range.s.c; c <= range.e.c; c++) if (ws[XLSX.utils.encode_cell({ r: 2, c })]?.v === "Latest Status") statusCol = c;
  assert.ok(statusCol >= 0, "Latest Status column appended on the header row (row 3)");
  assert.equal(ws[XLSX.utils.encode_cell({ r: 3, c: statusCol })]?.v, "In Progress", "C-1 on row 4");
  assert.equal(ws[XLSX.utils.encode_cell({ r: 4, c: statusCol })]?.v, "Complete", "C-2 on row 5");
});
