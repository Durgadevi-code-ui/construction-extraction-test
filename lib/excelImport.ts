import "server-only";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { buildWorkbookExtraction, type WorkbookExtraction } from "./workbookStructure";
import { EXPORT_LATEST_HEADERS } from "./excelExportColumns";
import { assertWithinCellLimit } from "./workbookLimits";
import {
  extractRawWorkbook,
  isDateFormat,
  readWorkbookForExtraction,
  rowPreview,
  serialToIsoDate,
  sheetGrid,
  type RawSheet,
  type RawSheetStatus,
  type RawWorkbook,
} from "./workbookExtract";

/**
 * Reusable project-file ingestion layer (see AGENTS.md master prompt
 * section 5/6: "reusable and maintainable", "tolerate different
 * column ordering, reasonable column-name variations, blank rows,
 * extra columns, optional columns, multiple sheets"). Pure parsing —
 * no I/O, no Supabase — so it can be unit-tested and reused from any
 * future caller (API route today, could be a script tomorrow).
 *
 * Deliberately does NOT assume a fixed column order or one sheet: every
 * sheet in the workbook is scanned, its header row is detected as the
 * first non-empty row, and each column is matched against a list of
 * accepted header aliases per normalized field (case/spacing/punctuation
 * insensitive). A row is only skipped for genuinely missing required
 * data, never for column order or extra columns.
 */

export type ParsedWorkItemRow = {
  /** 1-based row number in its source sheet (the real Excel row, also
   * when the sheet's used range doesn't start at row 1). */
  sourceRow: number;
  sourceSheet: string;
  department: string;
  workItemNo: string | null;
  description: string;
  /** True when `description` couldn't be read from the file and was
   * synthesized from other identifying data on the row (see
   * synthesizeDescription) — surfaced so a caller/UI can flag it rather
   * than presenting a guess as if the file actually said it. */
  descriptionInferred: boolean;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  scheduledValue: number | null;
  csiLineCode: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Column data present in the file that didn't map to any known
   * field above (e.g. "Retainage", "% Complete", "Materials Stored") —
   * keyed by the file's own original header text, never silently
   * dropped. Null when this row's header row had no unmatched columns
   * with a value. Preserved through commit into
   * work_items.additional_fields (see supabase/migrations/
   * 00000000000019_work_item_additional_fields.sql) — display-only,
   * never used in any matching/dedupe logic. */
  additionalFields: Record<string, string | number> | null;
};

export type ParseIssue = {
  sourceRow: number;
  sourceSheet: string;
  message: string;
};

export type ParseResult = {
  rows: ParsedWorkItemRow[];
  issues: ParseIssue[];
  sheetsScanned: string[];
  /** How each work-item sheet's columns were understood — shown in the
   * import preview so the operator can see what was read as what. */
  columnMappings: {
    sheet: string;
    headerRow: number;
    /** `col` is the 0-based sheet column (as in the Layer 1 extraction). */
    columns: { col: number; header: string; field: string }[];
  }[];
  /** Plain-language notes on sheets that couldn't be read as a work-item
   * table — used to explain an import that found nothing. */
  diagnostics: string[];
  /** Completeness report: every worksheet and every populated row, and
   * what became of it (see ExtractionReport). */
  extraction: ExtractionReport;
  /** The complete raw extraction the mapping above was made from. Not
   * sent to the browser (it can be large); the uploaded file itself is
   * what's kept as the source of record. */
  raw: RawWorkbook;
  /** Layer 1: the complete, dynamic extraction (every populated cell of
   * every sheet, with each sheet's own tables and headers) — stored with
   * the import and available to AI analysis/reporting. */
  complete: WorkbookExtraction;
};

/** What a populated source row was read as. Only "work-item" rows become
 * construction records; every other row is still in the raw extraction. */
export type RowKind =
  | "info"
  | "header"
  | "division"
  | "heading"
  | "work-item"
  | "total"
  | "repeated-header"
  | "note"
  | "unmapped"
  /** A row of a second table on the sheet that has no work-item columns. */
  | "other-table";

export type SheetExtractionReport = {
  name: string;
  index: number;
  visibility: RawSheet["visibility"];
  /** How the raw read went (see RawSheetStatus). */
  status: RawSheetStatus;
  /** How work-item mapping went for this sheet. */
  mapping: "mapped" | "no-work-items" | "not-a-work-item-table" | "skipped" | "error";
  message?: string;
  usedRange: string | null;
  mergedRanges: number;
  populatedRows: number;
  populatedCells: number;
  blankRowsWithin: number;
  formulaCells: number;
  formulasWithoutCachedValue: number;
  headerRow: number | null;
  rowsMapped: number;
  rowsByKind: Partial<Record<RowKind, number>>;
  /** Every populated row that did not become a work item, with why. */
  unmappedRows: { row: number; kind: RowKind; reason: string; text: string }[];
};

export type ExtractionReport = {
  /** False when any worksheet failed or was only partly read. */
  complete: boolean;
  sheetsDiscovered: number;
  sheetsRead: number;
  sheetsWithWorkItems: number;
  populatedRows: number;
  populatedCells: number;
  rowsMapped: number;
  rowsNotMapped: number;
  /** Sheet-level failures / warnings (no cell contents). */
  problems: string[];
  sheets: SheetExtractionReport[];
};

/** Display names for the fields a column can be read as. */
export const FIELD_LABELS: Record<NormalizedField, string> = {
  department: "Department",
  workItemNo: "Item No",
  description: "Description",
  plannedQuantity: "Quantity",
  unitOfMeasure: "Unit",
  scheduledValue: "Scheduled Value",
  csiLineCode: "CSI Code",
  startDate: "Start Date",
  endDate: "Finish Date",
};

/** Department used when a row has no department evidence at all (no
 * department column, no DIVISION/category heading above it). Existing
 * work items are still matched by item number first (see lib/admin.ts
 * upsertWorkItemFromImport), so this only ever holds genuinely new items
 * — visibly, so an Admin can move them, rather than rejecting the file. */
export const UNASSIGNED_DEPARTMENT = "Unassigned";

export type NormalizedField =
  | "department"
  | "workItemNo"
  | "description"
  | "plannedQuantity"
  | "unitOfMeasure"
  | "scheduledValue"
  | "csiLineCode"
  | "startDate"
  | "endDate";

// Alias lists are intentionally generous — real-world project files
// rarely agree on column names. Matched against normalizeHeader()
// output, so casing/spacing/punctuation in this list doesn't matter.
const FIELD_ALIASES: Record<NormalizedField, string[]> = {
  department: ["department", "dept", "trade", "workcategory", "category", "discipline"],
  workItemNo: [
    "workitemno", "lineitemno", "itemno", "itemnumber", "wbs", "lineitem", "item", "linenumber",
    "linen", "code",
  ],
  description: [
    "description", "descriptionofwork", "workitemdescription", "workitem", "itemdescription",
    "scope", "scopeofwork", "task", "activity",
  ],
  plannedQuantity: [
    "plannedquantity", "quantity", "qty", "target", "targetquantity", "estimatedquantity",
  ],
  unitOfMeasure: ["unit", "uom", "unitofmeasure", "units"],
  scheduledValue: [
    "scheduledvalue", "schedulevalue", "amount", "value", "budget", "contractvalue", "estimatedamount", "cost",
  ],
  // "csicode" was previously ALSO listed under workItemNo (to let a
  // generic "Code" column double as either) — that was wrong: a column
  // literally titled "CSI Code" is unambiguous, not a work-item number,
  // and workItemNo being checked first meant a file whose only code-ish
  // column was named exactly that had it swallowed as the line-item
  // number, leaving csi_line_code empty end to end. Only the genuinely
  // ambiguous bare "Code" header is still shared with workItemNo (see
  // FIELD_MATCH_ORDER below); every CSI-specific spelling belongs only
  // here.
  csiLineCode: [
    "csilinecode", "csi", "csicode", "csicodeno", "csinumber", "specsection", "csicoderef",
    "section", "sectionnumber",
  ],
  startDate: ["startdate", "start", "begindate"],
  endDate: ["enddate", "finish", "finishdate", "completiondate", "duedate"],
};

// workItemNo and csiLineCode still share the bare "Code" alias on
// purpose (a real file with no other code-ish column and a header
// that's JUST "Code" is genuinely ambiguous) — csiLineCode is matched
// second so workItemNo wins only that one genuine ambiguity. Every
// CSI-specific spelling ("CSI Code", "CSI Number", "Section", ...) is
// unambiguous and lives only in csiLineCode's own list above, so it's
// never at risk of being claimed by workItemNo first.
const FIELD_MATCH_ORDER: NormalizedField[] = [
  "department",
  "description",
  "plannedQuantity",
  "unitOfMeasure",
  "scheduledValue",
  "startDate",
  "endDate",
  "workItemNo",
  "csiLineCode",
];

function normalizeHeader(header: unknown): string {
  return String(header ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ------------------------------------------------------------------
// Column interpretation. Real project files name columns however their
// author likes ("Division" / "Trade" / "Group", "Item No." / "Activity
// ID" / "Ref", "Scope Description" / "What Needs To Be Done", …), so a
// column's meaning is decided from several signals instead of one exact
// heading name:
//   1. heading — the exact aliases above (strongest, so every file that
//      imported before maps exactly the same), else the heading's words
//      ("Planned Qty" → quantity, "Activity ID" → item number), with
//      negative words that rule a field out ("Notes" is never the
//      description, "Unit Price" is never the scheduled value);
//   2. cell data — long varied text reads as a description, short unique
//      codes as item numbers, repeated short labels / "DIVISION 03 – …"
//      as a department, measurement words (EA, LF, SF…) as units,
//      numbers as quantity/amount;
//   3. compatibility — a heading is only trusted when the data agrees
//      (a "Work Item" column holding 101, 102, … is an item number, not
//      a description).
// Each field is then given to its best-scoring column, one column each.
// ------------------------------------------------------------------

type ColumnProfile = {
  /** Non-blank sample values. */
  n: number;
  numFrac: number;
  textFrac: number;
  /** Short identifiers with a digit: 053, 101, A-101, 1.2, CO-01a. */
  codeFrac: number;
  /** CSI-style section numbers written as text: "03310", "26 05 19",
   * "03 30 00". Text only — a plain number like 25000 is far more often
   * an amount than a section number. */
  csiFrac: number;
  /** Values that are either a short code or a CSI section number. */
  csiCodeFrac: number;
  /** Measurement-unit words: EA, LF, SF, CY, LS, HR, … */
  unitFrac: number;
  /** "DIVISION 03 — CONCRETE"-style values. */
  divisionFrac: number;
  avgLen: number;
  distinctRatio: number;
  medianNumber: number;
};

/** Common construction measurement units — a vocabulary of cell VALUES
 * (what a unit column contains), not of column headings. */
const UNIT_WORDS = new Set([
  "ea", "each", "lf", "lin ft", "sf", "sq ft", "sqft", "sy", "sq yd", "cy", "cu yd", "cf", "ls", "lump sum", "lot",
  "allow", "allowance", "ton", "tons", "hr", "hrs", "hour", "hours", "day", "days", "wk", "week", "mo", "month", "m",
  "m2", "m3", "sqm", "lm", "kg", "lb", "lbs", "gal", "ft", "yd", "in", "pcs", "pc", "set", "sets", "unit", "units",
  "no", "nos", "%", "pct", "job", "item", "mh", "lnft", "bf", "msf", "sq",
]);

function profileColumn(values: unknown[]): ColumnProfile {
  const present = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  const n = present.length;
  if (n === 0) {
    return { n: 0, numFrac: 0, textFrac: 0, codeFrac: 0, csiFrac: 0, csiCodeFrac: 0, unitFrac: 0, divisionFrac: 0, avgLen: 0, distinctRatio: 0, medianNumber: 0 };
  }
  const texts = present.map((v) => String(v).trim());
  // Signed: a negative amount (a credit line) is still a number — it must
  // not make an amount column look like text.
  const numbers = present.map((v) => parseNumber(v)).filter((v): v is number => v !== null);
  const isCode = (v: unknown, t: string) =>
    typeof v === "number" ? Number.isInteger(v) && v >= 0 && v < 1e6 : /^[A-Za-z]{0,4}[-.\s]?\d[\w.\-/]{0,11}$/.test(t);
  const isCsi = (v: unknown, t: string) => typeof v === "string" && /^\d{2}\s?\d{2}\s?\d{1,2}(\.\d+)?$/.test(t);
  const sorted = [...numbers].sort((a, b) => a - b);
  return {
    n,
    numFrac: numbers.length / n,
    textFrac: texts.filter((t) => /[A-Za-z]/.test(t)).length / n,
    codeFrac: present.filter((v, i) => isCode(v, texts[i])).length / n,
    csiFrac: present.filter((v, i) => isCsi(v, texts[i])).length / n,
    csiCodeFrac: present.filter((v, i) => isCode(v, texts[i]) || isCsi(v, texts[i])).length / n,
    unitFrac: texts.filter((t) => UNIT_WORDS.has(t.toLowerCase().replace(/\./g, ""))).length / n,
    divisionFrac: texts.filter((t) => /^division\b/i.test(t)).length / n,
    avgLen: texts.reduce((s, t) => s + t.length, 0) / n,
    distinctRatio: new Set(texts.map((t) => t.toLowerCase())).size / n,
    medianNumber: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
  };
}

/** Heading words → fields. Weight 1 = the word alone says it; lower =
 * a hint the data must confirm. `not` words rule the field out. */
const HEADING_WORDS: Record<NormalizedField, { words: Record<string, number>; not: string[] }> = {
  department: {
    words: { department: 1, dept: 1, division: 1, trade: 1, discipline: 1, category: 1, workstream: 1, group: 0.7, package: 0.6, system: 0.5 },
    not: ["note", "notes", "comment", "comments", "remark", "remarks", "phase", "status", "location", "area", "zone", "level", "building", "floor", "date", "responsible", "contractor", "subcontractor", "code", "no", "number", "id"],
  },
  description: {
    words: { description: 1, desc: 1, scope: 1, task: 1, activity: 0.8, title: 0.7, narrative: 0.8, details: 0.6, work: 0.5, what: 0.5, name: 0.5, item: 0.4 },
    not: ["note", "notes", "comment", "comments", "remark", "remarks", "status", "phase", "location", "area", "zone", "level", "building", "floor", "contractor", "subcontractor", "responsible", "party", "date", "id", "no", "number", "code", "ref", "qty", "quantity", "unit", "uom", "value", "amount", "cost", "price"],
  },
  workItemNo: {
    words: { no: 1, number: 1, num: 1, ref: 1, reference: 1, id: 1, wbs: 1, line: 0.7, item: 0.6, code: 0.6, sn: 0.8, sl: 0.6 },
    not: ["description", "desc", "scope", "qty", "quantity", "unit", "value", "amount", "cost", "price", "csi", "spec", "phone", "date"],
  },
  csiLineCode: {
    words: { csi: 1, masterformat: 1, spec: 0.9, specification: 0.8, section: 0.7 },
    not: ["description", "desc", "qty", "quantity", "value", "amount"],
  },
  plannedQuantity: {
    words: { qty: 1, quantity: 1, quantities: 1, planned: 0.6, target: 0.6, estimated: 0.5, count: 0.6, volume: 0.6, units: 0.5 },
    not: ["price", "cost", "rate", "value", "amount", "%", "percent", "completed", "previous", "period", "stored", "balance", "retainage"],
  },
  unitOfMeasure: {
    words: { uom: 1, unit: 1, units: 0.8, measure: 1, measurement: 1, um: 0.8 },
    not: ["price", "cost", "rate", "value", "amount"],
  },
  scheduledValue: {
    words: { amount: 1, value: 1, cost: 1, budget: 1, scheduled: 0.8, contract: 0.6, sum: 0.6, total: 0.5, price: 0.4 },
    not: ["unit", "rate", "per", "percent", "%", "retainage", "balance", "previous", "period", "stored", "completed", "approved", "earned"],
  },
  startDate: { words: { start: 1, begin: 1, commence: 1 }, not: [] },
  endDate: { words: { finish: 1, end: 1, completion: 0.8, due: 1 }, not: ["balance"] },
};

/** How strongly a heading alone suggests `field`: 1 for an exact alias
 * (the original matching rule), else the best heading-word weight, or
 * -1 when a ruling-out word is present. */
function headingScore(field: NormalizedField, header: unknown): number {
  const compact = normalizeHeader(header);
  if (!compact) return 0;
  if (FIELD_ALIASES[field].includes(compact)) return 1;
  const words = String(header ?? "")
    .toLowerCase()
    .replace(/%/g, " % ")
    .split(/[^a-z0-9%]+/)
    .filter(Boolean);
  const { words: known, not } = HEADING_WORDS[field];
  if (words.some((w) => not.includes(w))) return -1;
  return words.reduce((best, w) => Math.max(best, known[w] ?? 0), 0);
}

/** Whether the column's data can be this field at all. */
function dataCompatible(field: NormalizedField, p: ColumnProfile): boolean {
  switch (field) {
    case "description":
      return p.textFrac >= 0.6 && p.numFrac < 0.4;
    case "department":
      return p.textFrac >= 0.6 && p.unitFrac < 0.5;
    case "workItemNo":
      return p.codeFrac >= 0.6 && p.avgLen <= 20;
    case "csiLineCode":
      return p.csiCodeFrac >= 0.6;
    case "plannedQuantity":
    case "scheduledValue":
      return p.numFrac >= 0.6;
    case "unitOfMeasure":
      return p.textFrac >= 0.6 && p.avgLen <= 12;
    default:
      return true;
  }
}

/** How much the column's data alone looks like this field (0–1). */
function dataScore(field: NormalizedField, p: ColumnProfile, colIndex: number): number {
  switch (field) {
    case "description":
      return p.textFrac * Math.min(1, p.avgLen / 25) * (0.4 + 0.6 * p.distinctRatio);
    case "department":
      if (p.divisionFrac >= 0.5) return 1;
      return p.n >= 3 && p.distinctRatio < 1 ? p.textFrac * (1 - p.distinctRatio) * (p.avgLen <= 40 ? 1 : 0.5) : 0;
    case "workItemNo":
      return p.codeFrac * p.distinctRatio * (colIndex <= 2 ? 1 : 0.8);
    case "csiLineCode":
      return p.csiFrac;
    case "unitOfMeasure":
      return p.unitFrac;
    case "plannedQuantity":
      return p.numFrac * 0.3;
    case "scheduledValue":
      return p.numFrac * 0.3 + (p.medianNumber >= 1000 ? 0.2 : 0);
    default:
      return 0;
  }
}

/** Minimum data score for a column with no heading support at all —
 * only fields whose data is distinctive enough to stand on its own. */
const DATA_ONLY_THRESHOLD: Partial<Record<NormalizedField, number>> = {
  description: 0.45,
  department: 0.6,
  workItemNo: 0.6,
  unitOfMeasure: 0.7,
  csiLineCode: 0.8,
};

type ColumnInterpretation = {
  columnField: Map<number, NormalizedField>;
  score: number;
  /** Fields whose column had heading support (not data alone). */
  headingBacked: number;
  /** Which fields those were. */
  headingFields: Set<NormalizedField>;
  /** Fields matched by an exact alias (the original rule). */
  exactAliases: number;
};

/** Interprets one candidate header row against the rows below it. */
function interpretColumns(headerRow: unknown[], sampleRows: unknown[][]): ColumnInterpretation {
  const candidates: { col: number; field: NormalizedField; total: number; heading: number }[] = [];
  const width = Math.max(headerRow.length, ...sampleRows.map((r) => r.length));
  for (let col = 0; col < width; col++) {
    const header = headerRow[col];
    // The download's own "Latest …" columns are computed output, never
    // source data — they are not interpreted as any field.
    const headerText = toStringOrNull(header);
    if (headerText && EXPORT_LATEST_HEADER_SET.has(headerText)) continue;
    const profile = profileColumn(sampleRows.map((r) => r[col]));
    for (const field of FIELD_MATCH_ORDER) {
      const heading = headingScore(field, header);
      if (heading < 0) continue;
      if (profile.n === 0 ? heading < 0.9 : !dataCompatible(field, profile)) continue;
      const data = profile.n === 0 ? 0 : dataScore(field, profile, col);
      if (heading >= 0.4) {
        if (heading + data >= 0.7) candidates.push({ col, field, total: heading + data, heading });
      } else if (
        data >= (DATA_ONLY_THRESHOLD[field] ?? Infinity) &&
        // Repeated short labels under a heading of their own ("Inspector",
        // "Crew", "Status") are that column's data, kept under its own
        // header — never re-read as the department. Content alone decides
        // only for an unlabeled column or "DIVISION …" values.
        (field !== "department" || !headerText || profile.divisionFrac >= 0.5)
      ) {
        candidates.push({ col, field, total: data, heading: 0 });
      }
    }
  }
  // Best pairs first; ties keep the original field priority and leftmost column.
  candidates.sort(
    (a, b) =>
      b.total - a.total ||
      FIELD_MATCH_ORDER.indexOf(a.field) - FIELD_MATCH_ORDER.indexOf(b.field) ||
      a.col - b.col
  );
  const columnField = new Map<number, NormalizedField>();
  const taken = new Set<NormalizedField>();
  const headingFields = new Set<NormalizedField>();
  let score = 0;
  let headingBacked = 0;
  let exactAliases = 0;
  for (const c of candidates) {
    if (columnField.has(c.col) || taken.has(c.field)) continue;
    columnField.set(c.col, c.field);
    taken.add(c.field);
    score += c.total;
    if (c.heading > 0) {
      headingBacked++;
      headingFields.add(c.field);
    }
    if (FIELD_ALIASES[c.field].includes(normalizeHeader(headerRow[c.col]))) exactAliases++;
  }
  return { columnField, score, headingBacked, headingFields, exactAliases };
}

function isRowBlank(row: unknown[]): boolean {
  return row.every((cell) => cell === undefined || cell === null || String(cell).trim() === "");
}

// AIA G703 Continuation Sheets group work items under section rows like
// "DIVISION 03 — CONCRETE" instead of a per-row Department column. Such a
// row has exactly one non-blank cell (the rest are blank/merged) and that
// cell starts with "DIVISION". Detected regardless of which column the
// text lands in, since it isn't tied to any header mapping. Returns just
// the division's name (e.g. "CONCRETE"), stripping the "DIVISION 03 —"
// prefix, so the department is created under a plain name rather than the
// full section label. Falls back to the full text if the row doesn't
// follow the "DIVISION <number> <separator> <name>" convention.
function extractDivisionHeader(row: unknown[]): string | null {
  const nonBlankCells = row
    .map((cell) => toStringOrNull(cell))
    .filter((cell): cell is string => cell !== null);
  if (nonBlankCells.length !== 1) return null;
  const text = nonBlankCells[0].trim();
  if (!/^division\b/i.test(text)) return null;
  // The identifier after "DIVISION" isn't always numeric — AIA G703
  // change-order sections use "DIVISION CO — CHANGE ORDERS" — so match
  // any alphanumeric code, not just digits.
  const match = text.match(/^division\s*[\w.]*\s*[-–—:]\s*(.+)$/i);
  return (match ? match[1].trim() : text) || text;
}

// The actual column-header row of an AIA G703 continuation sheet (or any
// project workbook) is rarely the first non-blank row — real exports have
// a project/application-info block ("AIA DOCUMENT G703", "APPLICATION
// NO.", "PERIOD TO:", etc.) above the real table header. So the first
// HEADER_SEARCH_ROW_LIMIT rows are each tried as the header, interpreted
// against the rows below them (interpretColumns), and the best
// interpretation wins. To avoid reading a summary/cover sheet (e.g. AIA
// G702) or a data row as a table, a header row must be mostly text and
// either name a department/description column exactly (the original rule)
// or back at least two fields with its headings — and it must yield a
// description column (or a department plus an item/CSI number).
const HEADER_SEARCH_ROW_LIMIT = 50;
const HEADER_SAMPLE_ROWS = 40;

function isSingleCellRow(row: unknown[]): boolean {
  return row.filter((cell) => toStringOrNull(cell) !== null).length === 1;
}

// Multi-row headers. AIA G703 and similar forms put a merged group
// heading in the header row ("WORK COMPLETED" over two columns) with the
// real column names in the row below ("FROM PREVIOUS APPLICATION", "THIS
// PERIOD"), often followed by a column-letter row ("A", "B", "C", …,
// "G/C"). Those rows are part of the header, not data: they must not be
// imported as a work item or profiled as column data.
const HEADER_BAND_MAX_ROWS = 3;

/** A column-letter row: two or more short labels like A, B, AA, G/C, (C-G), D+E. */
function isColumnLetterRow(row: unknown[]): boolean {
  const cells = row.map((cell) => toStringOrNull(cell)).filter((cell): cell is string => cell !== null);
  return (
    cells.length >= 2 &&
    row.every((cell) => cell === null || cell === undefined || typeof cell === "string") &&
    cells.every((t) => /^\(?[A-Z]{1,2}(\s*[-+/÷×*]\s*[A-Z]{1,2})*\)?$/.test(t))
  );
}

/** A sub-header row directly under the header row: text only, with at
 * least one label under a header cell that is blank (the continuation of
 * a merged group heading), and nothing under an item-number or
 * description heading (a data row always has one of those). */
function isSubHeaderRow(row: unknown[], headerRow: unknown[]): boolean {
  const filled = row.map((cell, c) => ({ cell, c })).filter(({ cell }) => toStringOrNull(cell) !== null);
  if (filled.length === 0) return false;
  if (!filled.every(({ cell }) => typeof cell === "string" && /[A-Za-z]/.test(cell))) return false;
  if (/^division\b/i.test(String(filled[0].cell).trim()) || isTotalRowMarker(String(filled[0].cell))) return false;
  if (!filled.some(({ c }) => toStringOrNull(headerRow[c]) === null)) return false;
  return !filled.some(({ c }) => headingScore("description", headerRow[c]) >= 1 || headingScore("workItemNo", headerRow[c]) >= 1);
}

/** How many rows directly under the header row belong to the header. */
function headerBandLength(grid: unknown[][], headerIndex: number): number {
  let n = 0;
  while (n < HEADER_BAND_MAX_ROWS) {
    const row = grid[headerIndex + 1 + n];
    if (!row || !(isColumnLetterRow(row) || isSubHeaderRow(row, grid[headerIndex]))) break;
    n++;
  }
  return n;
}

type HeaderMatch = { index: number; columnField: Map<number, NormalizedField>; score: number };

/**
 * Whether grid row `i` is a work-item table header, judged against the
 * rows below it up to `sampleEnd` (the next table's start — a second table
 * on the sheet must never be profiled as this table's data).
 */
function evaluateHeader(grid: unknown[][], i: number, sampleEnd = grid.length): HeaderMatch | null {
  const row = grid[i];
  if (!row || isRowBlank(row)) return null;
  const cells = row.filter((cell) => toStringOrNull(cell) !== null);
  const textCells = cells.filter((cell) => typeof cell === "string" && /[A-Za-z]/.test(cell));
  if (textCells.length / cells.length < 0.6) return null;

  const sample: unknown[][] = [];
  for (let r = i + 1 + headerBandLength(grid, i); r < sampleEnd && sample.length < HEADER_SAMPLE_ROWS; r++) {
    const candidate = grid[r];
    if (isRowBlank(candidate) || isSingleCellRow(candidate) || isTotalRow(candidate) || isColumnLetterRow(candidate)) continue;
    sample.push(candidate);
  }

  const interpretation = interpretColumns(row, sample);
  const fields = new Set(interpretation.columnField.values());
  // Without a description column, a table only counts as work items when
  // its item-number/CSI column is NAMED as one: a numeric column guessed
  // from its contents alone (e.g. "Rate/hr" next to "Trade") would turn a
  // rate or price list into fake work items with invented descriptions.
  const namedIdentifier = interpretation.headingFields.has("workItemNo") || interpretation.headingFields.has("csiLineCode");
  const hasCore = fields.has("description") || (fields.has("department") && namedIdentifier);
  if (!hasCore) return null;
  const exactCore = [...interpretation.columnField].some(
    ([col, field]) =>
      (field === "description" || field === "department") && FIELD_ALIASES[field].includes(normalizeHeader(row[col]))
  );
  if (interpretation.headingBacked < 2 && !exactCore) return null;
  return { index: i, columnField: interpretation.columnField, score: interpretation.score };
}

/**
 * The best work-item header among the first HEADER_SEARCH_ROW_LIMIT rows
 * and any extra candidate rows (Layer 1 table starts, wherever they are).
 * Each candidate's column sample stops at the next table start.
 */
function findHeaderRow(
  grid: unknown[][],
  candidates: number[] = [],
  tableStarts: number[] = []
): HeaderMatch | null {
  const rowsToTry = new Set<number>(candidates);
  for (let i = 0; i < Math.min(grid.length, HEADER_SEARCH_ROW_LIMIT); i++) rowsToTry.add(i);
  const nextStart = (i: number) => tableStarts.filter((s) => s > i).sort((a, b) => a - b)[0] ?? grid.length;

  let best: HeaderMatch | null = null;
  for (const i of [...rowsToTry].sort((a, b) => a - b)) {
    const match = evaluateHeader(grid, i, nextStart(i));
    if (match && match.score > (best?.score ?? 0)) best = match;
  }
  return best;
}

/** Null for anything unparsable OR negative — a negative planned
 * quantity/scheduled value is never valid data, so it's treated the
 * same as "not provided" rather than silently stored and later
 * producing a negative/garbage progress percentage (see
 * lib/calculations.ts, which itself also guards against a negative
 * plannedQuantity, but rejecting it here means the import preview
 * shows the row as genuinely incomplete instead of a deceptively
 * present-but-wrong number). Returns whether a negative value was
 * dropped so the caller can raise a visible issue instead of silently
 * losing it. */
function toNumberOrNull(value: unknown): { value: number | null; wasNegative: boolean } {
  const n = parseNumber(value);
  if (n === null) return { value: null, wasNegative: false };
  if (n < 0) return { value: null, wasNegative: true };
  return { value: n, wasNegative: false };
}

/** A cell as a number (signed), or null when it isn't one. Never rounds. */
function parseNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || typeof value === "boolean") return null;
  if (value instanceof Date) return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Number formats that only pad/shape an identifier ("000" → 053,
 * "0.00" → 1.10, "00 00 00" → 03 30 00) — for those, the text Excel shows
 * IS the identifier, and String(value) would silently change it. */
const IDENTIFIER_FORMAT = /^[0#?.\s\-/]+$/;

/** Item numbers / CSI codes as the file shows them. */
function identifierText(cell: XLSX.CellObject | undefined, gridValue: unknown): string | null {
  if (
    cell?.t === "n" &&
    typeof cell.z === "string" &&
    IDENTIFIER_FORMAT.test(cell.z) &&
    typeof cell.w === "string" &&
    cell.w.trim() !== ""
  ) {
    return cell.w.trim();
  }
  return toStringOrNull(gridValue);
}

function toStringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/** Whether `text` (already extracted from the description, item-no, or
 * CSI-code column of a row — wherever it landed) is a subtotal/total
 * marker rather than real data: "SUBTOTAL", "TOTAL", "GRAND TOTAL", etc.
 * Anchored to the start of the trimmed text so a genuine description
 * that merely contains the word "total" (e.g. "Total station survey
 * equipment") is never mistaken for one. */
function isTotalRowMarker(text: string | null): boolean {
  return !!text && /^(grand\s+)?(sub)?\s*totals?\b/i.test(text.trim());
}

/** A real G703/continuation-sheet row can legitimately have no
 * "Description of Work" text at all (e.g. a row that's really just a
 * CSI code + scheduled value, or a General Requirements line whose
 * description lives in a merged cell the flattened grid didn't
 * capture) — dropping it outright would silently lose a real work item
 * just because one field was blank. Falls back to whatever OTHER
 * identifying data the row does have, in order of how identifying it
 * is; returns null only when the row truly has nothing to go on
 * (caller still skips it then — see the "Missing work item
 * description" issue). */
function synthesizeDescription(workItemNo: string | null, csiLineCode: string | null): string | null {
  if (workItemNo) return `Item ${workItemNo}`;
  if (csiLineCode) return `CSI ${csiLineCode}`;
  return null;
}

/** Every column the header row has that ISN'T one of the recognized
 * fields — captured under the file's own original header text (not the
 * normalized key) so it stays human-readable in the preview/DB. Only
 * columns with an actual non-blank value on THIS row are included (an
 * empty cell in an extra column isn't "additional data"). Returns null
 * rather than `{}` when there's nothing to report, so
 * ParsedWorkItemRow.additionalFields can mean "none" cleanly. */
/**
 * Headings of the columns "Download updated Excel" appends — defined in
 * lib/excelExportColumns.ts (client-safe, shared with the download
 * dialog). They hold figures computed from the app's own approved
 * progress, never source data, so when a downloaded file is uploaded
 * again they are not stored as work item fields.
 */
export { EXPORT_LATEST_HEADERS };
const EXPORT_LATEST_HEADER_SET = new Set<string>(Object.values(EXPORT_LATEST_HEADERS));

function collectAdditionalFields(
  columnKeys: (string | null)[],
  columnField: Map<number, NormalizedField>,
  row: unknown[],
  cellAt: (col: number) => XLSX.CellObject | undefined
): Record<string, string | number> | null {
  let fields: Record<string, string | number> | null = null;
  columnKeys.forEach((key, colIndex) => {
    if (key === null || columnField.has(colIndex)) return;
    const value = additionalValue(cellAt(colIndex), row[colIndex]);
    if (value === null) return;
    fields ??= {};
    fields[key] = value;
  });
  return fields;
}

/** A cell's value as kept in additional fields: numbers unchanged, text
 * trimmed, date-formatted numbers as ISO dates (a bare serial number
 * would change their meaning), error cells as their error text, and a
 * formula with no saved result as its formula text. */
function additionalValue(cell: XLSX.CellObject | undefined, gridValue: unknown): string | number | null {
  if (cell?.f && (cell.v === undefined || cell.t === "z")) return `=${cell.f}`;
  if (cell?.t === "e") return cell.w ?? "#ERROR";
  if (gridValue === undefined || gridValue === null || String(gridValue).trim() === "") return null;
  if (typeof gridValue === "number") {
    return isDateFormat(cell?.z) ? (serialToIsoDate(gridValue) ?? gridValue) : gridValue;
  }
  return String(gridValue).trim();
}

/**
 * The name each column's data is kept under in additional fields — the
 * file's own header text, as before, so re-imports keep the same keys.
 * Where the header row alone doesn't name a column, the header band and
 * merged ranges do:
 *   - a merged group heading with sub-headings below → "WORK COMPLETED /
 *     THIS PERIOD" (previously the second column was dropped);
 *   - a blank header cell with a sub-heading → the sub-heading;
 *   - a merged group with no sub-heading → "GROUP (F)";
 *   - nothing at all → "Column F" (data is never dropped for lack of a
 *     heading).
 * A heading used by an earlier column gets its column letter appended
 * instead of overwriting that column's value. Null = not source data
 * (the download's own "Latest …" columns).
 */
function columnHeaderKeys(
  grid: unknown[][],
  headerIndex: number,
  bandLength: number,
  merges: XLSX.Range[],
  colOffset: number
): (string | null)[] {
  const header = grid[headerIndex] ?? [];
  const width = grid.reduce((w, row) => Math.max(w, row.length), header.length);
  const bandRows = grid.slice(headerIndex + 1, headerIndex + 1 + bandLength).filter((row) => !isColumnLetterRow(row));
  const used = new Set<string>();
  const keys: (string | null)[] = [];
  for (let c = 0; c < width; c++) {
    const own = toStringOrNull(header[c]);
    if (own && EXPORT_LATEST_HEADER_SET.has(own)) {
      keys.push(null);
      continue;
    }
    const letter = XLSX.utils.encode_col(colOffset + c);
    const group = merges.find(
      (m) => m.s.r <= headerIndex && headerIndex <= m.e.r && m.s.c <= c && c <= m.e.c && m.e.c > m.s.c
    );
    const groupText = group ? toStringOrNull(grid[group.s.r]?.[group.s.c]) : null;
    const subs = bandRows.map((row) => toStringOrNull(row[c])).filter((t): t is string => t !== null);
    let key: string;
    if (groupText && subs.length > 0) key = [groupText, ...subs].join(" / ");
    else if (own) key = own;
    else if (subs.length > 0) key = subs.join(" / ");
    else if (groupText) key = `${groupText} (${letter})`;
    else key = `Column ${letter}`;
    if (used.has(key)) key = `${key} (${letter})`;
    used.add(key);
    keys.push(key);
  }
  return keys;
}

/** Same rule as lib/admin.ts normalizeLineItemNo ("1" and "001" are one
 * item) — the key commit matches existing work items by. */
function lineItemKey(raw: string): string {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? String(parseInt(trimmed, 10)) : trimmed.toLowerCase();
}

/** Excel serial date or a plain string — normalized to an ISO date
 * string (YYYY-MM-DD) where recognizable, otherwise passed through as
 * whatever text was there (never thrown away, never invented). */
function toDateStringOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const mm = String(parsed.m).padStart(2, "0");
      const dd = String(parsed.d).padStart(2, "0");
      return `${parsed.y}-${mm}-${dd}`;
    }
  }
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * Parses every sheet of an uploaded workbook. Two stages:
 *   1. Raw extraction (lib/workbookExtract.ts): every worksheet and every
 *      populated cell, exactly as stored, independent of any mapping.
 *   2. Mapping: on each sheet that holds a work-item table, eligible rows
 *      become ParsedWorkItemRow; every other populated row is classified
 *      (header, division, total, note, …) with a reason, so nothing the
 *      file holds disappears without being reported (see `extraction`).
 * Each sheet is mapped independently — its own header row and column
 * layout — and a failure on one sheet is reported against that sheet
 * without hiding the others.
 *
 * Never throws for bad *data* (a row missing a required field becomes an
 * issue). SheetJS's `read()` is extremely lenient about bad *files* —
 * plain text, random bytes and a zero-byte buffer all parse to zero
 * sheets/rows — so the caller's `rows.length === 0` check (see
 * app/api/admin/projects/import/route.ts) is the real "not a usable
 * project file" signal; a throw (e.g. the safe-read guard) is still
 * treated as an unreadable file by the caller. The one deliberate throw
 * is WorkbookTooLargeError (lib/workbookLimits.ts): more populated cells
 * than the import limit, across all sheets combined.
 */
export function parseProjectWorkbook(buffer: ArrayBuffer, fileName = "workbook"): ParseResult {
  const workbook = readWorkbookForExtraction(buffer);
  const raw = extractRawWorkbook(workbook);
  // Too many cells (all sheets together): refuse before any further work.
  assertWithinCellLimit(raw.sheets);
  // Layer 1 first: every populated cell of every sheet, with its sheet's
  // own structure (throws if any cell would be lost or duplicated).
  const complete = buildWorkbookExtraction(raw, {
    fileName,
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(new Uint8Array(buffer)).digest("hex"),
  });
  const tableStartsBySheet = new Map(complete.sheets.map((s) => [s.name, s.tables.map((t) => t.firstRow)]));

  const rows: ParsedWorkItemRow[] = [];
  const issues: ParseIssue[] = [];
  const sheetsScanned: string[] = [];
  const columnMappings: ParseResult["columnMappings"] = [];
  const diagnostics: string[] = [];
  const problems: string[] = [];
  const sheetReports: SheetExtractionReport[] = [];

  for (const rawSheet of raw.sheets) {
    const sheetName = rawSheet.name;
    const outcome = new Map<number, { kind: RowKind; reason: string }>();
    let mapping: SheetExtractionReport["mapping"] = "skipped";
    let message = rawSheet.message;
    let headerRow: number | null = null;

    if (rawSheet.status === "error" || rawSheet.status === "incomplete") {
      problems.push(`Sheet "${sheetName}": ${rawSheet.message}`);
    }
    if (rawSheet.status === "ok" || rawSheet.status === "incomplete") {
      try {
        const mapped = mapSheet(workbook.Sheets[sheetName], sheetName, tableStartsBySheet.get(sheetName) ?? []);
        mapped.outcome.forEach((v, k) => outcome.set(k, v));
        rows.push(...mapped.rows);
        issues.push(...mapped.issues);
        diagnostics.push(...mapped.diagnostics);
        headerRow = mapped.headerRow;
        if (mapped.columnMappings.length > 0) {
          sheetsScanned.push(sheetName);
          columnMappings.push(...mapped.columnMappings);
          mapping = mapped.rows.length > 0 ? "mapped" : "no-work-items";
        } else {
          mapping = "not-a-work-item-table";
        }
        if (mapped.diagnostics.length > 0 && rawSheet.status === "ok") message = mapped.diagnostics.join(" ");
      } catch (err) {
        outcome.clear();
        mapping = "error";
        message = `Work-item mapping failed on this sheet: ${err instanceof Error ? err.message : "unknown error"}.`;
        problems.push(`Sheet "${sheetName}": ${message}`);
      }
    }

    const rowsByKind: SheetExtractionReport["rowsByKind"] = {};
    const unmappedRows: SheetExtractionReport["unmappedRows"] = [];
    for (const rawRow of rawSheet.rows) {
      const o = outcome.get(rawRow.row) ?? {
        kind: "unmapped" as const,
        reason:
          mapping === "error"
            ? "Not mapped — work-item mapping failed on this sheet."
            : "Only error values or formulas without a saved result — nothing to map.",
      };
      rowsByKind[o.kind] = (rowsByKind[o.kind] ?? 0) + 1;
      if (o.kind !== "work-item") unmappedRows.push({ row: rawRow.row, kind: o.kind, reason: o.reason, text: rowPreview(rawRow) });
    }
    sheetReports.push({
      name: sheetName,
      index: rawSheet.index,
      visibility: rawSheet.visibility,
      status: rawSheet.status,
      mapping,
      ...(message ? { message } : {}),
      usedRange: rawSheet.usedRange,
      mergedRanges: rawSheet.merges.length,
      populatedRows: rawSheet.populatedRows,
      populatedCells: rawSheet.populatedCells,
      blankRowsWithin: rawSheet.blankRowsWithin,
      formulaCells: rawSheet.formulaCells,
      formulasWithoutCachedValue: rawSheet.formulasWithoutCachedValue,
      headerRow,
      rowsMapped: rowsByKind["work-item"] ?? 0,
      rowsByKind,
      unmappedRows,
    });
  }

  // Commit matches existing work items by item number project-wide
  // (lib/admin.ts upsertWorkItemFromImport), so the same item number on
  // two sheets — or under two departments — updates ONE work item with
  // the later row's values. Same-sheet, same-department repeats are
  // already reported per sheet; every other case is reported here.
  const firstByItem = new Map<string, ParsedWorkItemRow>();
  for (const row of rows) {
    if (!row.workItemNo) continue;
    const key = lineItemKey(row.workItemNo);
    const first = firstByItem.get(key);
    if (!first) {
      firstByItem.set(key, row);
      continue;
    }
    const sameSheetSameDept =
      first.sourceSheet === row.sourceSheet &&
      first.department.trim().toLowerCase() === row.department.trim().toLowerCase();
    if (!sameSheetSameDept) {
      issues.push({
        sourceRow: row.sourceRow,
        sourceSheet: row.sourceSheet,
        message: `Item # ${row.workItemNo} also appears on sheet "${first.sourceSheet}" row ${first.sourceRow} — on import both rows update the same work item (this row's values are applied last).`,
      });
    }
  }

  const populatedRows = sheetReports.reduce((n, s) => n + s.populatedRows, 0);
  const extraction: ExtractionReport = {
    complete: problems.length === 0,
    sheetsDiscovered: raw.sheets.length,
    sheetsRead: raw.sheets.filter((s) => s.status !== "error").length,
    sheetsWithWorkItems: sheetReports.filter((s) => s.rowsMapped > 0).length,
    populatedRows,
    populatedCells: sheetReports.reduce((n, s) => n + s.populatedCells, 0),
    rowsMapped: rows.length,
    rowsNotMapped: populatedRows - rows.length,
    problems,
    sheets: sheetReports,
  };

  return { rows, issues, sheetsScanned, columnMappings, diagnostics, extraction, raw, complete };
}

/**
 * Work-item mapping of one worksheet (Layer 2). Row numbers are real sheet
 * rows. `tableStartRows` are the sheet rows where Layer 1
 * (lib/workbookStructure.ts) found a table header: each table is mapped
 * on ITS OWN header, so a second table on the sheet is never read through
 * the first table's columns, and a table without work-item columns
 * contributes no work items (its rows stay in Layer 1).
 */
function mapSheet(
  sheet: XLSX.WorkSheet,
  sheetName: string,
  tableStartRows: number[] = []
): {
  rows: ParsedWorkItemRow[];
  issues: ParseIssue[];
  diagnostics: string[];
  columnMappings: ParseResult["columnMappings"];
  headerRow: number | null;
  outcome: Map<number, { kind: RowKind; reason: string }>;
} {
  const rows: ParsedWorkItemRow[] = [];
  const issues: ParseIssue[] = [];
  const diagnostics: string[] = [];
  const outcome = new Map<number, { kind: RowKind; reason: string }>();
  const { grid, rowOffset, colOffset } = sheetGrid(sheet);
  const sheetRow = (r: number) => rowOffset + r + 1;
  const classify = (r: number, kind: RowKind, reason: string) => outcome.set(sheetRow(r), { kind, reason });
  const tableStarts = tableStartRows.map((n) => n - rowOffset - 1).filter((i) => i >= 0 && i < grid.length);
  const nextTableStart = (i: number) => tableStarts.filter((s) => s > i).sort((a, b) => a - b)[0] ?? grid.length;

  // Header row = the best-matching row within the first
  // HEADER_SEARCH_ROW_LIMIT rows or at any Layer 1 table start, not
  // necessarily the first non-blank one (real exports, e.g. AIA G703,
  // have project/application-info rows above the actual table header).
  // A sheet with no row that resolves any department/description column
  // at all is treated as "not a work-item sheet" (e.g. a cover page or
  // notes tab): its rows stay in the complete extraction and are reported
  // as not mapped.
  const headerMatch = findHeaderRow(grid, tableStarts, tableStarts);
  if (!headerMatch) {
    diagnostics.push(
      `Sheet "${sheetName}": no row could be read as a work-item table header (a row naming the columns, with a work description column underneath).`
    );
    grid.forEach((row, r) => {
      if (!isRowBlank(row)) {
        classify(r, "info", "This sheet has no work-item table (e.g. a cover page, AIA G702 summary or notes) — kept in the complete extraction, not mapped.");
      }
    });
    return { rows, issues, diagnostics, columnMappings: [], headerRow: null, outcome };
  }
  const merges = (sheet["!merges"] ?? []).map((m) => ({
    s: { r: m.s.r - rowOffset, c: m.s.c - colOffset },
    e: { r: m.e.r - rowOffset, c: m.e.c - colOffset },
  }));
  // A table that has item numbers/quantities/values: a line there with
  // ONLY description text (a note, a legend) is not a work item.
  const identifyingFields: NormalizedField[] = ["workItemNo", "csiLineCode", "plannedQuantity", "unitOfMeasure", "scheduledValue"];

  // The mapping in force — replaced at each work-item table on the sheet.
  let headerRowIndex = 0;
  let headerRowNumber = 0;
  let headerCells: unknown[] = [];
  let bandLength = 0;
  let columnKeys: (string | null)[] = [];
  let columnField = new Map<number, NormalizedField>();
  let fieldCol = new Map<NormalizedField, number>();
  let mappedFields = new Set<NormalizedField>();
  let hasDepartmentColumn = false;
  let tableHasIdentifiers = false;
  let columnMapping: ParseResult["columnMappings"][number] = { sheet: sheetName, headerRow: 0, columns: [] };
  const columnMappings: ParseResult["columnMappings"] = [];
  const applyHeader = (match: HeaderMatch) => {
    headerRowIndex = match.index;
    columnField = match.columnField;
    headerRowNumber = sheetRow(headerRowIndex);
    headerCells = grid[headerRowIndex];
    bandLength = headerBandLength(grid, headerRowIndex);
    columnKeys = columnHeaderKeys(grid, headerRowIndex, bandLength, merges, colOffset);
    fieldCol = new Map<NormalizedField, number>([...columnField].map(([col, field]) => [field, col]));
    mappedFields = new Set(columnField.values());
    hasDepartmentColumn = mappedFields.has("department");
    tableHasIdentifiers = identifyingFields.some((f) => mappedFields.has(f));
    columnMapping = {
      sheet: sheetName,
      headerRow: headerRowNumber,
      columns: [...columnField]
        .sort(([a], [b]) => a - b)
        .map(([col, field]) => ({ col: col + colOffset, header: String(headerCells[col] ?? "").replace(/\s+/g, " ").trim(), field: FIELD_LABELS[field] })),
    };
    columnMappings.push(columnMapping);
    classify(headerRowIndex, "header", "Column header row.");
    for (let r = headerRowIndex + 1; r <= headerRowIndex + bandLength; r++) {
      classify(r, "header", isColumnLetterRow(grid[r]) ? "Column-letter row of the header." : "Sub-header row (column names under a merged group heading).");
    }
  };
  applyHeader(headerMatch);
  const firstHeaderRowNumber = headerRowNumber;
  // Rows of a table that has no work-item columns (e.g. an allowance or
  // contact list next to the schedule): kept in Layer 1, never items.
  let inNonWorkItemTable = false;
  let unassignedCount = 0;

  for (let r = 0; r < headerRowIndex; r++) {
    if (!isRowBlank(grid[r])) {
      classify(r, "info", "Above the table header (title, project or application information) — kept in the complete extraction, not mapped.");
    }
  }

  // (department, workItemNo) pairs already seen ON THIS SHEET — the
  // upsert key upsertWorkItemFromImport commits with. Surfaced as a
  // visible issue rather than silently letting the later row's
  // values overwrite the earlier one's with no record of it having
  // happened (both rows are still imported; upsert intentionally
  // collapses them to one work item, same as a genuine re-upload
  // would — this is only about the operator being told).
  const seenKeys = new Set<string>();
  // Current AIA G703 "DIVISION NN — Name" section, applied to rows
  // below it as their department when the sheet has no explicit
  // Department column (see extractDivisionHeader above).
  let currentDivision: string | null = null;

  for (let r = headerRowIndex + 1 + bandLength; r < grid.length; r++) {
    const row = grid[r];
    if (isRowBlank(row)) continue;

    // Another table starts here (Layer 1): map it on its own header, or —
    // when it has no work-item columns — keep all its rows out of Layer 2.
    if (tableStarts.includes(r) && r > headerRowIndex) {
      const match = evaluateHeader(grid, r, nextTableStart(r));
      if (match) {
        applyHeader(match);
        inNonWorkItemTable = false;
        r = headerRowIndex + bandLength;
        continue;
      }
      inNonWorkItemTable = true;
    }
    if (inNonWorkItemTable) {
      classify(r, "other-table", "Row of a table without work-item columns — kept in the complete extraction, not a work item.");
      continue;
    }

    const divisionHeader = extractDivisionHeader(row);
    if (divisionHeader) {
      currentDivision = divisionHeader;
      classify(r, "division", "Division heading — sets the department of the rows below it.");
      continue;
    }
    // Any other single-cell line (a title, legend, note or GRAND TOTAL
    // label) is not a work item. In a sheet with no department column,
    // a short ALL-CAPS line is a category heading for the rows below
    // (e.g. "ELECTRICAL WORK"), the same way a DIVISION row is.
    if (isSingleCellRow(row)) {
      const text = row.map((cell) => toStringOrNull(cell)).find((cell) => cell !== null) ?? "";
      if (isTotalRowMarker(text)) {
        classify(r, "total", "Total line — not a work item.");
      } else if (
        !hasDepartmentColumn &&
        text.length <= 60 &&
        /[A-Z]/.test(text) &&
        text === text.toUpperCase()
      ) {
        currentDivision = text.trim();
        classify(r, "heading", "Section heading — sets the department of the rows below it.");
      } else {
        classify(r, "note", "Single text line (title, note or legend) — not a work item.");
      }
      continue;
    }
    // A repeated header row (multi-page sheets): two or more cells equal
    // their own column's heading.
    if (
      isColumnLetterRow(row) ||
      row.filter((cell, c) => toStringOrNull(cell) !== null && normalizeHeader(cell) === normalizeHeader(headerCells[c]))
        .length >= 2
    ) {
      classify(r, "repeated-header", "Repeated column-header row.");
      continue;
    }

    const sourceRow = sheetRow(r);
    const cellAt = (col: number) =>
      sheet[XLSX.utils.encode_cell({ r: rowOffset + r, c: colOffset + col })] as XLSX.CellObject | undefined;
    const get = (field: NormalizedField): unknown => {
      const col = fieldCol.get(field);
      return col === undefined ? undefined : row[col];
    };
    const cellOf = (field: NormalizedField) => {
      const col = fieldCol.get(field);
      return col === undefined ? undefined : cellAt(col);
    };

    // A department cell may itself read "DIVISION 03 — CONCRETE": keep
    // just the name, exactly as a DIVISION heading row does.
    const departmentCell = toStringOrNull(get("department"));
    const departmentFromCell = departmentCell
      ? (departmentCell.match(/^division\s*[\w.]*\s*[-–—:]\s*(.+)$/i)?.[1].trim() ?? departmentCell)
      : null;
    let department = departmentFromCell ?? currentDivision;
    const rawDescription = toStringOrNull(get("description"));
    const workItemNo = identifierText(cellOf("workItemNo"), get("workItemNo"));
    const csiLineCode = identifierText(cellOf("csiLineCode"), get("csiLineCode"));

    // Multi-page continuation sheets repeat the column header row on
    // every page, and typically carry a subtotal/grand-total row per
    // division or at the sheet's end. Neither is a real work item, so
    // both are skipped (and reported as such) rather than imported as
    // bogus rows. Checked against whichever of description/item-no/
    // CSI-code the marker text actually landed in — a sheet with no
    // Department column (e.g. G703) puts "SUBTOTAL"/"GRAND TOTAL" under
    // ITEM NO., not Description, and it must be caught there too, BEFORE
    // synthesizeDescription below would otherwise turn it into a fake
    // "Item SUBTOTAL" work item.
    if (rawDescription && FIELD_ALIASES.description.includes(normalizeHeader(rawDescription))) {
      classify(r, "repeated-header", "Repeated column-header row.");
      continue;
    }
    if (isTotalRowMarker(rawDescription) || isTotalRowMarker(workItemNo) || isTotalRowMarker(csiLineCode)) {
      classify(r, "total", "Subtotal/total line — not a work item.");
      continue;
    }

    if (tableHasIdentifiers && identifyingFields.every((f) => toStringOrNull(get(f)) === null)) {
      if (rawDescription) {
        issues.push({
          sourceRow,
          sourceSheet: sheetName,
          message: "No item number, CSI code, quantity, unit or value — read as a note, not a work item (skipped).",
        });
        classify(r, "note", "No item number, CSI code, quantity, unit or value — read as a note.");
      } else {
        classify(r, "unmapped", "No description, item number, CSI code, quantity, unit or value in the mapped columns.");
      }
      continue;
    }

    // A row genuinely missing "Description of Work" isn't necessarily
    // a bad row — G703 structure means the item number or CSI code
    // often still uniquely identifies it (see synthesizeDescription).
    // Only a row with NEITHER a description NOR anything to infer one
    // from is truly unusable and skipped.
    const description = rawDescription ?? synthesizeDescription(workItemNo, csiLineCode);
    if (!description) {
      issues.push({ sourceRow, sourceSheet: sheetName, message: "Missing work item description — row skipped." });
      classify(r, "unmapped", "Missing work item description (and no item number or CSI code to identify it).");
      continue;
    }

    if (!department) {
      department = UNASSIGNED_DEPARTMENT;
      unassignedCount++;
    }
    const descriptionInferred = !rawDescription;
    if (descriptionInferred) {
      issues.push({
        sourceRow,
        sourceSheet: sheetName,
        message: `No description column value — used "${description}" from the item/CSI code instead.`,
      });
    }

    // Values in mapped columns that can't be stored in their field (text
    // in a quantity column, a negative amount, an error cell, a formula
    // with no saved result, a date) are kept with the item's additional
    // fields under the column's own heading — never silently dropped.
    const preserved: Record<string, string | number> = {};
    const preserve = (field: NormalizedField, value?: string | number | null) => {
      const col = fieldCol.get(field);
      const key = col === undefined ? null : columnKeys[col];
      const v = value !== undefined ? value : col === undefined ? null : additionalValue(cellAt(col), row[col]);
      if (key && v !== null) preserved[key] = v;
    };
    const readAmount = (field: "plannedQuantity" | "scheduledValue", negativeMessage: string): number | null => {
      const col = fieldCol.get(field);
      if (col === undefined) return null;
      const label = FIELD_LABELS[field];
      const cell = cellAt(col);
      if (cell?.f && (cell.v === undefined || cell.t === "z")) {
        issues.push({
          sourceRow,
          sourceSheet: sheetName,
          message: `${label} is a formula with no saved result in the file (formulas are not recalculated) — not imported as ${label}; formula kept with the item's extra columns.`,
        });
        preserve(field);
        return null;
      }
      if (cell?.t === "e") {
        issues.push({
          sourceRow,
          sourceSheet: sheetName,
          message: `${label} cell shows an error (${cell.w ?? "error"}) — not imported as ${label}; kept with the item's extra columns.`,
        });
        preserve(field);
        return null;
      }
      const parsed = toNumberOrNull(row[col]);
      if (parsed.wasNegative) {
        issues.push({ sourceRow, sourceSheet: sheetName, message: `${negativeMessage} Original value kept with the item's extra columns.` });
        preserve(field);
      } else if (parsed.value === null && toStringOrNull(row[col]) !== null) {
        const text = String(row[col]).trim();
        issues.push({
          sourceRow,
          sourceSheet: sheetName,
          message: `${label} "${text.length > 40 ? `${text.slice(0, 39)}…` : text}" is not a number — not imported as ${label}; kept with the item's extra columns.`,
        });
        preserve(field);
      }
      return parsed.value;
    };
    const plannedQuantity = readAmount("plannedQuantity", "Planned quantity was negative — ignored, row still imported without it.");
    const scheduledValue = readAmount("scheduledValue", "Scheduled value was negative — ignored, row still imported without it.");
    // Work items have no date columns: mapped dates are kept with the
    // item's additional fields (ISO) instead of being discarded on commit.
    const startDate = toDateStringOrNull(get("startDate"));
    const endDate = toDateStringOrNull(get("endDate"));
    if (startDate) preserve("startDate", startDate);
    if (endDate) preserve("endDate", endDate);

    const dedupeKey = `${department.trim().toLowerCase()}::${(workItemNo ?? description).trim().toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) {
      issues.push({
        sourceRow,
        sourceSheet: sheetName,
        message: `Duplicate of an earlier row in this sheet (same department${
          workItemNo ? " and item #" : " and description"
        }) — this row's values will overwrite the earlier one's on import.`,
      });
    }
    seenKeys.add(dedupeKey);

    const extra = collectAdditionalFields(columnKeys, columnField, row, cellAt);
    const additionalFields = extra || Object.keys(preserved).length > 0 ? { ...(extra ?? {}), ...preserved } : null;
    rows.push({
      sourceRow,
      sourceSheet: sheetName,
      department,
      workItemNo,
      description,
      descriptionInferred,
      plannedQuantity,
      unitOfMeasure: toStringOrNull(get("unitOfMeasure")),
      scheduledValue,
      csiLineCode,
      startDate,
      endDate,
      additionalFields,
    });
    classify(r, "work-item", "Work item.");
  }

  if (unassignedCount > 0) {
    issues.push({
      sourceRow: firstHeaderRowNumber,
      sourceSheet: sheetName,
      message: `${unassignedCount} row(s) have no department column or DIVISION/category heading — they will be placed under "${UNASSIGNED_DEPARTMENT}" (existing work items keep their own department).`,
    });
  }
  if (rows.length === 0) {
    const read = columnMappings[0].columns.map((c) => `${c.header} → ${c.field}`).join(", ");
    diagnostics.push(
      `Sheet "${sheetName}": header row ${firstHeaderRowNumber} was read (${read}), but no row below it had a work description or item number.`
    );
  }
  return { rows, issues, diagnostics, columnMappings, headerRow: firstHeaderRowNumber, outcome };
}

/**
 * Layout helpers for the "Download updated Excel" export
 * (lib/excelExport.ts), which re-opens the ORIGINAL uploaded workbook
 * and must find exactly the header row, columns, division rows and
 * total rows this parser found — so they're exposed here rather than
 * re-implemented there. Pure, no behavior change to parsing.
 */
export function findSheetLayout(
  grid: unknown[][]
): { headerRowIndex: number; columnField: Map<number, NormalizedField> } | null {
  const match = findHeaderRow(grid);
  return match ? { headerRowIndex: match.index, columnField: match.columnField } : null;
}

/** Whether a row is an AIA G703 "DIVISION NN — Name" section heading. */
export function isDivisionHeaderRow(row: unknown[]): boolean {
  return extractDivisionHeader(row) !== null;
}

/** Whether a row is a SUBTOTAL / TOTAL / GRAND TOTAL line (any cell). */
export function isTotalRow(row: unknown[]): boolean {
  return row.some((cell) => typeof cell === "string" && isTotalRowMarker(cell));
}

/** Distinct department names found in a parse result, in first-seen
 * order — what the upload flow activates/creates per project. */
export function distinctDepartments(rows: ParsedWorkItemRow[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    const key = row.department.trim();
    if (!seen.has(key.toLowerCase())) {
      seen.add(key.toLowerCase());
      ordered.push(key);
    }
  }
  return ordered;
}
