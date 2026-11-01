import "server-only";
import * as XLSX from "xlsx";
import { readWorkbookGuarded } from "./safeWorkbookRead";

/**
 * Raw, layout-faithful extraction of an uploaded workbook — the step
 * BEFORE any construction mapping (lib/excelImport.ts). Every worksheet,
 * in workbook order, and every populated cell in it is read exactly as
 * stored: original value (no rounding, no trimming), Excel's formatted
 * text, formula text, number format, merged range and A1 location. Rows
 * are kept with their real sheet row numbers, so blank rows and section
 * gaps are visible as gaps rather than lost. Nothing here depends on
 * whether a row can become a work item.
 *
 * Formulas are NOT recalculated: `value` is the result Excel cached in
 * the file (when it has one) and `formula` is the expression. A formula
 * with no cached result is reported, never guessed.
 *
 * Pure — no I/O. The uploaded bytes are only read, never modified.
 */

export type RawCellType = "string" | "number" | "boolean" | "date" | "error" | "empty";

export type RawCell = {
  /** A1 address in the sheet, e.g. "D12". */
  ref: string;
  /** 1-based sheet row / 0-based column index. */
  row: number;
  col: number;
  type: RawCellType;
  /** The stored value, unchanged (numbers at full precision). Null for
   * errors and for a formula with no cached result. */
  value: string | number | boolean | null;
  /** Excel's displayed text for the cell (e.g. "053", "1/1/2025", "50%",
   * "#REF!"), when the file or parser provides one. */
  text: string | null;
  formula?: string;
  /** Number format, when not "General". */
  format?: string;
  /** ISO date (YYYY-MM-DD, or with time) for a date-formatted number. */
  date?: string;
  /** The merged range this cell is the top-left of, e.g. "E4:F4". */
  merge?: string;
};

export type RawRow = { row: number; cells: RawCell[] };

export type RawSheetStatus =
  /** Read in full. */
  | "ok"
  /** The sheet has no cells. */
  | "empty"
  /** Chart / dialog / macro sheet — holds no cell data to extract. */
  | "unsupported"
  /** Read, but fewer cells than the file declares (malformed XML). */
  | "incomplete"
  /** Could not be read at all. */
  | "error";

export type RawSheet = {
  name: string;
  /** 0-based position in the workbook. */
  index: number;
  visibility: "visible" | "hidden" | "veryHidden";
  status: RawSheetStatus;
  /** Why the sheet is not "ok" (never contains cell contents). */
  message?: string;
  /** Range declared by the sheet (its `!ref`). */
  declaredRange: string | null;
  /** Range actually covered by populated cells. */
  usedRange: string | null;
  merges: string[];
  /** Populated rows only, in sheet order; gaps are blank rows. */
  rows: RawRow[];
  populatedRows: number;
  populatedCells: number;
  /** Blank rows between the first and last populated row. */
  blankRowsWithin: number;
  formulaCells: number;
  formulasWithoutCachedValue: number;
  /** Value-bearing cells counted in the worksheet's own XML (.xlsx
   * only) — compared with what was read to detect a malformed sheet. */
  cellsInFile: number | null;
};

export type RawWorkbook = { sheets: RawSheet[] };

/** Read options shared by the importer: number formats are kept (needed
 * for dates and formatted identifiers), dates stay serial numbers, and
 * the package parts are kept so each sheet's XML can be cross-checked.
 *
 * Stub cells are read too, because SheetJS otherwise DROPS a formula cell
 * whose cached result is empty (`<f>…</f><v></v>` — common in generated
 * workbooks never opened in Excel), losing the formula. Such a cell comes
 * back as { t: "z", f, v: 0 } — the 0 is not a value (see toRawCell). Stubs
 * without a formula (formatted blank cells) are removed again, so ranges
 * and the work-item grid are exactly as without stubs. */
export function readWorkbookForExtraction(buffer: ArrayBuffer): XLSX.WorkBook {
  const workbook = readWorkbookGuarded(buffer, {
    type: "array",
    cellDates: false,
    cellNF: true,
    cellFormula: true,
    bookFiles: true,
    sheetStubs: true,
  });
  for (const ws of Object.values(workbook.Sheets)) {
    for (const key of Object.keys(ws)) {
      if (key.startsWith("!")) continue;
      const cell = ws[key] as XLSX.CellObject | undefined;
      if (cell?.t === "z" && !cell.f) delete ws[key];
    }
  }
  return workbook;
}

export function isDateFormat(format: unknown): boolean {
  return typeof format === "string" && format !== "General" && XLSX.SSF.is_date(format);
}

/** ISO text for an Excel serial date: YYYY-MM-DD, plus THH:MM[:SS] when
 * the value has a time part. Null when it isn't a valid date code. */
export function serialToIsoDate(serial: number): string | null {
  const p = XLSX.SSF.parse_date_code(serial);
  if (!p) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  if (!p.H && !p.M && !p.S) return date;
  return `${date}T${pad(p.H)}:${pad(p.M)}${p.S ? `:${pad(Math.floor(p.S))}` : ""}`;
}

/** Whether a SheetJS cell holds anything (a value or a formula). */
function holdsContent(cell: XLSX.CellObject | undefined): cell is XLSX.CellObject {
  if (!cell || cell.t === undefined) return false;
  if (cell.f) return true;
  if (cell.t === "z") return false;
  if (cell.t === "e") return true;
  return cell.v !== undefined && cell.v !== null && !(typeof cell.v === "string" && cell.v === "");
}

function toRawCell(cell: XLSX.CellObject, r: number, c: number, merge: string | undefined): RawCell {
  const format = typeof cell.z === "string" && cell.z !== "General" ? cell.z : undefined;
  let type: RawCellType;
  let value: RawCell["value"] = null;
  let date: string | undefined;
  // A formula with no saved result has no value of any type (SheetJS may
  // label it an error cell) — reported as such, never as an error.
  const uncachedFormula = !!cell.f && (cell.v === undefined || cell.t === "z");
  switch (uncachedFormula ? "z" : cell.t) {
    case "s":
      type = "string";
      value = cell.v === undefined ? null : String(cell.v);
      break;
    case "b":
      type = "boolean";
      value = cell.v === undefined ? null : !!cell.v;
      break;
    case "n":
      type = typeof cell.v === "number" && isDateFormat(format) ? "date" : "number";
      value = typeof cell.v === "number" ? cell.v : null;
      if (type === "date") date = serialToIsoDate(cell.v as number) ?? undefined;
      break;
    case "d":
      type = "date";
      value = cell.v instanceof Date ? cell.v.toISOString() : String(cell.v);
      date = value;
      break;
    case "e":
      type = "error";
      break;
    default:
      type = "empty";
  }
  const out: RawCell = {
    ref: XLSX.utils.encode_cell({ r, c }),
    row: r + 1,
    col: c,
    type,
    value,
    text: uncachedFormula ? null : typeof cell.w === "string" ? cell.w : value === null ? null : String(value),
  };
  if (cell.f) out.formula = cell.f;
  if (format) out.format = format;
  if (date) out.date = date;
  if (merge) out.merge = merge;
  return out;
}

/** Sheet name -> worksheet XML, from the package parts SheetJS kept. */
function worksheetXmlByName(workbook: XLSX.WorkBook): Map<string, string> | null {
  const files = (workbook as unknown as { files?: Record<string, { content?: Uint8Array }> }).files;
  if (!files) return null;
  const text = (path: string) => {
    const content = files[path]?.content;
    return content ? Buffer.from(content).toString("utf8") : null;
  };
  const rels = text("xl/_rels/workbook.xml.rels");
  if (!rels) return null;
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = m[1].match(/\bId="([^"]*)"/)?.[1];
    const target = m[1].match(/\bTarget="([^"]*)"/)?.[1];
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const out = new Map<string, string>();
  for (const info of workbook.Workbook?.Sheets ?? []) {
    const id = (info as { id?: string }).id;
    const path = id ? targets.get(id) : undefined;
    const xml = path ? text(path) : null;
    if (info.name && xml !== null) out.set(info.name, xml);
  }
  return out;
}

/** Cells in a worksheet's XML that carry a value, inline string or formula. */
function countValueCellsInXml(xml: string): number {
  let n = 0;
  for (const m of xml.matchAll(/<c\b[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (m[1] && /<(v|is|f)\b/.test(m[1])) n++;
  }
  return n;
}

/**
 * The range a sheet's data really covers: its declared `!ref` widened to
 * include any cell outside it, so nothing stored is ever left unread.
 */
export function effectiveRange(ws: XLSX.WorkSheet): XLSX.Range | null {
  let range: XLSX.Range | null = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
  for (const key of Object.keys(ws)) {
    if (key.startsWith("!")) continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (!range) range = { s: { r, c }, e: { r, c } };
    range.s.r = Math.min(range.s.r, r);
    range.s.c = Math.min(range.s.c, c);
    range.e.r = Math.max(range.e.r, r);
    range.e.c = Math.max(range.e.c, c);
  }
  return range;
}

/**
 * The value grid the work-item mapper reads: one array per row of
 * effectiveRange (blank rows kept), cell values as stored. Matches what
 * XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })
 * returned for this importer before number formats were kept — date
 * cells stay serial numbers rather than becoming time-zone-shifted Date
 * objects, and error cells read as blank. Grid row r / column c is sheet
 * cell (rowOffset + r, colOffset + c).
 */
export function sheetGrid(ws: XLSX.WorkSheet): { grid: unknown[][]; rowOffset: number; colOffset: number } {
  const range = effectiveRange(ws);
  if (!range) return { grid: [], rowOffset: 0, colOffset: 0 };
  const grid: unknown[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: unknown[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      if (!cell || cell.t === "z" || cell.t === "e" || cell.v === undefined) row.push(null);
      else if (cell.t === "d") row.push(cell.v instanceof Date ? cell.v : new Date(cell.v as string));
      else row.push(cell.v);
    }
    grid.push(row);
  }
  return { grid, rowOffset: range.s.r, colOffset: range.s.c };
}

function extractSheet(
  workbook: XLSX.WorkBook,
  name: string,
  index: number,
  xmlByName: Map<string, string> | null
): RawSheet {
  const hidden = workbook.Workbook?.Sheets?.[index]?.Hidden;
  const sheet: RawSheet = {
    name,
    index,
    visibility: hidden === 1 ? "hidden" : hidden === 2 ? "veryHidden" : "visible",
    status: "ok",
    declaredRange: null,
    usedRange: null,
    merges: [],
    rows: [],
    populatedRows: 0,
    populatedCells: 0,
    blankRowsWithin: 0,
    formulaCells: 0,
    formulasWithoutCachedValue: 0,
    cellsInFile: null,
  };
  const ws = workbook.Sheets[name];
  if (!ws) {
    return { ...sheet, status: "error", message: "The worksheet could not be read (missing or unsupported sheet part)." };
  }
  const kind = (ws as { "!type"?: string })["!type"];
  if (kind && kind !== "sheet") {
    return { ...sheet, status: "unsupported", message: `This is a ${kind} sheet, which holds no cell data to extract.` };
  }
  try {
    sheet.declaredRange = ws["!ref"] ?? null;
    const merges = ws["!merges"] ?? [];
    sheet.merges = merges.map((m) => XLSX.utils.encode_range(m));
    const mergeAt = new Map(merges.map((m) => [XLSX.utils.encode_cell(m.s), XLSX.utils.encode_range(m)]));

    const byRow = new Map<number, RawCell[]>();
    let cellsRead = 0;
    let minR = Infinity, minC = Infinity, maxR = -1, maxC = -1;
    for (const key of Object.keys(ws)) {
      if (key.startsWith("!")) continue;
      const cell = ws[key] as XLSX.CellObject;
      if (cell && (cell.v !== undefined || cell.f)) cellsRead++;
      if (!holdsContent(cell)) continue;
      const { r, c } = XLSX.utils.decode_cell(key);
      const raw = toRawCell(cell, r, c, mergeAt.get(key));
      if (raw.formula) {
        sheet.formulaCells++;
        if (cell.v === undefined || cell.t === "z") sheet.formulasWithoutCachedValue++;
      }
      if (!byRow.has(r)) byRow.set(r, []);
      byRow.get(r)!.push(raw);
      minR = Math.min(minR, r); minC = Math.min(minC, c);
      maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
    }
    sheet.rows = [...byRow.entries()]
      .sort(([a], [b]) => a - b)
      .map(([r, cells]) => ({ row: r + 1, cells: cells.sort((a, b) => a.col - b.col) }));
    sheet.populatedRows = sheet.rows.length;
    sheet.populatedCells = sheet.rows.reduce((n, row) => n + row.cells.length, 0);
    if (maxR >= 0) {
      sheet.usedRange = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
      sheet.blankRowsWithin = maxR - minR + 1 - sheet.populatedRows;
    } else {
      sheet.status = "empty";
      sheet.message = "The worksheet has no populated cells.";
    }

    const xml = xmlByName?.get(name);
    if (xml !== undefined) {
      sheet.cellsInFile = countValueCellsInXml(xml);
      if (sheet.cellsInFile > cellsRead) {
        sheet.status = "incomplete";
        sheet.message = `The file stores ${sheet.cellsInFile} value cell(s) for this worksheet but only ${cellsRead} could be read — the worksheet appears malformed, so its data may be incomplete.`;
      }
    }
    return sheet;
  } catch (err) {
    return {
      ...sheet,
      rows: [],
      status: "error",
      message: `The worksheet could not be read: ${err instanceof Error ? err.message : "unknown error"}.`,
    };
  }
}

/** Raw extraction of every worksheet, in workbook order. */
export function extractRawWorkbook(workbook: XLSX.WorkBook): RawWorkbook {
  const xmlByName = worksheetXmlByName(workbook);
  return { sheets: workbook.SheetNames.map((name, index) => extractSheet(workbook, name, index, xmlByName)) };
}

/** Short, single-line view of a raw row's text, for reports. */
export function rowPreview(row: RawRow, maxLength = 120): string {
  const text = row.cells
    .map((c) => (c.text ?? (c.value === null ? "" : String(c.value))).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
