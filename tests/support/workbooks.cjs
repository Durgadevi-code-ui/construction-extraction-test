/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose, like the tests that use it. */
// Synthetic test workbooks (no client data) and an independent read of a
// workbook's populated cells, shared by the import tests.
const XLSX = require("xlsx");

function richWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([["ABC Construction — Project Cover"], ["Project", "Riverside Clinic"], ["Contract Sum", 1250000], ["Retainage %", 10], ["Owner", "Riverside Health Trust"]]),
    "Cover"
  );
  const schedule = XLSX.utils.aoa_to_sheet([
    ["SCHEDULE OF VALUES — APPLICATION #4"],
    [],
    ["Item No", "Description", "Qty", "Unit", "Amount", "% Complete", "Start", "Site Contact"],
    ["DIVISION 03 — CONCRETE"],
    ["1", "Footings", 120, "CY", 48000, 0.5, 45658, "R. Patel"],
    ["2", "Slab on grade", 300, "CY", 96000, 0.25, 45670, null],
    [null, "Rebar allowance", 1, "LS", 5000, 0, null, "R. Patel"],
    ["Note: quantities per drawing S-101 rev 3"],
    ["SUBTOTAL", null, null, null, 149000],
    ["DIVISION 26 — ELECTRICAL"],
    ["10", "Panel boards", 4, "EA", null, 0, null, null],
    [],
    ["Code", "Allowance", "Budget", "Owner Approved"],
    ["A-1", "Owner contingency", 25000, "Yes"],
    ["A-2", "Testing & inspection", 8000, "No"],
  ]);
  schedule["E11"] = { t: "n", f: "C11*2500", v: 10000 };
  schedule["G5"].z = "yyyy-mm-dd";
  schedule["G6"].z = "yyyy-mm-dd";
  schedule["E5"].z = '"$"#,##0.00';
  schedule["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
  XLSX.utils.book_append_sheet(wb, schedule, "Schedule");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([["Item No", "Description", "Amount", "Approved By"], ["1", "CO-01 Added footing at grid C", 3200, "J. Owner"], ["CO-2", "CO-02 Upgraded panel", 4100, "J. Owner"]]),
    "Change Orders"
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Asset Tag", "Make", "Model", "Hours", "Last Service", "Operator"],
      ["EQ-101", "CAT", "320", 1820.5, 45600, "M. Silva"],
      ["EQ-102", "Bobcat", "S650", 640, 45612, null],
      ["EQ-103", "JLG", "600S", 0, null, "T. Nguyen"],
    ]),
    "Equipment"
  );
  wb.Sheets.Equipment.E2.z = "dd/mm/yyyy";
  wb.Sheets.Equipment.E3.z = "dd/mm/yyyy";
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Site notes"], ["Crane booked for 12 Feb"], [], ["Inspector visit pending"]]), "Notes");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Trade", "Rate/hr", "OT Rate"], ["Electrician", 92, 138], ["Plumber", 88, 132]]), "Rates");
  wb.Workbook = { Sheets: wb.SheetNames.map((name) => ({ name, Hidden: name === "Rates" ? 1 : 0 })) };
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

/** Independent read of the source: every value/formula cell, by sheet!ref.
 * Stubs are read so a formula with no cached result (which SheetJS drops
 * otherwise) is counted too; its value is undefined (no cached result). */
function sourceCells(bytes) {
  const wb = XLSX.read(bytes, { type: "array", cellFormula: true, cellNF: true, sheetStubs: true });
  const out = new Map();
  wb.SheetNames.forEach((name) => {
    for (const [ref, cell] of Object.entries(wb.Sheets[name])) {
      if (ref.startsWith("!")) continue;
      const value = cell.t === "z" ? undefined : cell.v;
      if (cell.f || (value !== undefined && value !== null && value !== "")) out.set(`${name}!${ref}`, { value, formula: cell.f });
    }
  });
  return { names: wb.SheetNames, cells: out };
}

/** The workbook with the cached results of these formula cells removed
 * (<f>…</f><v></v>), as a workbook written by a script and never opened
 * in Excel has them. `refs` maps sheet number (1-based) to cell refs. */
function withUncachedFormulas(bytes, refs) {
  const zip = XLSX.CFB.read(Buffer.from(bytes), { type: "buffer" });
  for (const [sheetNo, cells] of Object.entries(refs)) {
    const i = zip.FullPaths.findIndex((p) => p.endsWith(`/sheet${sheetNo}.xml`));
    let xml = Buffer.from(zip.FileIndex[i].content).toString("utf8");
    for (const ref of cells) {
      const before = xml;
      xml = xml.replace(new RegExp(`(<c r="${ref}"[^>]*>(?:(?!</c>)[^])*?</f>)<v>[^<]*</v>`), "$1<v></v>");
      if (xml === before) throw new Error(`no cached formula at sheet${sheetNo} ${ref}`);
    }
    zip.FileIndex[i].content = Buffer.from(xml);
  }
  return new Uint8Array(XLSX.CFB.write(zip, { type: "buffer", fileType: "zip" }));
}

/** A small work-item sheet whose Amount column is all formulas with no
 * cached results, plus a summary sheet with one more. */
function uncachedFormulaWorkbook() {
  const items = XLSX.utils.aoa_to_sheet([
    ["Item No", "Description", "Qty", "Rate", "Amount"],
    ["1", "Excavation", 40, 25, null],
    ["2", "Backfill", 30, 18, null],
    ["Total", null, null, null, null],
  ]);
  items.E2 = { t: "n", f: "C2*D2", v: 1000 };
  items.E3 = { t: "n", f: "C3*D3", v: 540 };
  items.E4 = { t: "n", f: "SUM(E2:E3)", v: 1540 };
  const summary = XLSX.utils.aoa_to_sheet([["Contract total", null]]);
  summary.B1 = { t: "n", f: "Items!E4", v: 1540 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, items, "Items");
  XLSX.utils.book_append_sheet(wb, summary, "Summary");
  return withUncachedFormulas(XLSX.write(wb, { type: "array", bookType: "xlsx" }), { 1: ["E2", "E3", "E4"], 2: ["B1"] });
}

/** 5 sheets, each with its own column count, custom headers, row count,
 * two tables, title/metadata/notes, blanks, formulas, dates and totals;
 * one is a work-item table with unknown extra columns and duplicate item
 * numbers. Deterministic, synthetic data only. */
function generatedWorkbook() {
  const wb = XLSX.utils.book_new();
  for (let k = 1; k <= 4; k++) {
    const cols = 3 + k * 5; // 8, 13, 18, 23 columns
    const n = 40 + k * 70; // 110 ... 320 rows
    const aoa = [[`Register ${k} - synthetic test data`], ["Prepared by", `Tester ${k}`], []];
    const headers = Array.from({ length: cols }, (_, j) => `Custom ${k}.${j + 1}${j % 4 === 0 ? " (ref)" : ""}`);
    aoa.push(headers);
    for (let i = 0; i < n; i++) {
      aoa.push(headers.map((_, j) => ((i + j) % 7 === 0 ? null : j === 0 ? `R${k}-${i + 1}` : j % 3 === 0 ? (i * 37 + j) / 4 : j % 5 === 0 ? 45000 + i : `v${i}.${j}`)));
    }
    aoa.push(["Total", null, n]);
    aoa.push([]);
    aoa.push([`Side table ${k}`, "Amount", "Flag"]);
    aoa.push(["first", 10 * k, true], ["second", 20 * k, false]);
    aoa.push(["Note: generated for the extraction test"]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let i = 0; i < n; i += 9) ws[XLSX.utils.encode_cell({ r: 4 + i, c: cols - 1 })] = { t: "n", f: `ROW()*${k}`, v: (5 + i) * k };
    for (let i = 0; i < n; i++) {
      const date = ws[XLSX.utils.encode_cell({ r: 4 + i, c: 5 })];
      if (date && date.t === "n") date.z = "yyyy-mm-dd";
    }
    XLSX.utils.book_append_sheet(wb, ws, `Register ${k}`);
  }
  const items = [["Bid package - work items"], [], ["Item No", "Description", "Qty", "Unit", "Amount", "Crew", "Inspector", "Risk Score"]];
  for (let i = 0; i < 30; i++) items.push([String((i % 15) + 1), `Synthetic task ${i + 1}`, 10 + i, "EA", 1000 + i * 10, i % 4 ? `Crew ${i % 4}` : null, `Insp ${i % 3}`, i / 10]);
  items.push(["TOTAL", null, null, null, 30 * 1000 + 4350]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(items), "Bid Items");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

module.exports = { richWorkbook, generatedWorkbook, uncachedFormulaWorkbook, withUncachedFormulas, sourceCells };
