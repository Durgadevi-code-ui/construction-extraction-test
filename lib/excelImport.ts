import "server-only";
import * as XLSX from "xlsx";
import { EXPORT_LATEST_HEADERS } from "./excelExportColumns";

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
  /** 1-based row number in its source sheet, for error messages. */
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
  columnMappings: { sheet: string; headerRow: number; columns: { header: string; field: string }[] }[];
  /** Plain-language notes on sheets that couldn't be read as a work-item
   * table — used to explain an import that found nothing. */
  diagnostics: string[];
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
  /** CSI-style section numbers: 03310, 26 05 19, 03 30 00. */
  csiFrac: number;
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
    return { n: 0, numFrac: 0, textFrac: 0, codeFrac: 0, csiFrac: 0, unitFrac: 0, divisionFrac: 0, avgLen: 0, distinctRatio: 0, medianNumber: 0 };
  }
  const texts = present.map((v) => String(v).trim());
  const numbers = present.map((v) => toNumberOrNull(v).value).filter((v): v is number => v !== null);
  const isCode = (v: unknown, t: string) =>
    typeof v === "number" ? Number.isInteger(v) && v >= 0 && v < 1e6 : /^[A-Za-z]{0,4}[-.\s]?\d[\w.\-/]{0,11}$/.test(t);
  const sorted = [...numbers].sort((a, b) => a - b);
  return {
    n,
    numFrac: numbers.length / n,
    textFrac: texts.filter((t) => /[A-Za-z]/.test(t)).length / n,
    codeFrac: present.filter((v, i) => isCode(v, texts[i])).length / n,
    csiFrac: texts.filter((t) => /^\d{2}\s?\d{2}\s?\d{1,2}(\.\d+)?$/.test(t)).length / n,
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
      return p.codeFrac >= 0.6;
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
      } else if (data >= (DATA_ONLY_THRESHOLD[field] ?? Infinity)) {
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
  let score = 0;
  let headingBacked = 0;
  let exactAliases = 0;
  for (const c of candidates) {
    if (columnField.has(c.col) || taken.has(c.field)) continue;
    columnField.set(c.col, c.field);
    taken.add(c.field);
    score += c.total;
    if (c.heading > 0) headingBacked++;
    if (FIELD_ALIASES[c.field].includes(normalizeHeader(headerRow[c.col]))) exactAliases++;
  }
  return { columnField, score, headingBacked, exactAliases };
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

function findHeaderRow(
  grid: unknown[][]
): { index: number; columnField: Map<number, NormalizedField> } | null {
  let best: { index: number; columnField: Map<number, NormalizedField> } | null = null;
  let bestScore = 0;

  for (let i = 0; i < Math.min(grid.length, HEADER_SEARCH_ROW_LIMIT); i++) {
    const row = grid[i];
    if (isRowBlank(row)) continue;
    const cells = row.filter((cell) => toStringOrNull(cell) !== null);
    const textCells = cells.filter((cell) => typeof cell === "string" && /[A-Za-z]/.test(cell));
    if (textCells.length / cells.length < 0.6) continue;

    const sample: unknown[][] = [];
    for (let r = i + 1; r < grid.length && sample.length < HEADER_SAMPLE_ROWS; r++) {
      const candidate = grid[r];
      if (isRowBlank(candidate) || isSingleCellRow(candidate) || isTotalRow(candidate)) continue;
      sample.push(candidate);
    }

    const interpretation = interpretColumns(row, sample);
    const fields = new Set(interpretation.columnField.values());
    const hasCore =
      fields.has("description") ||
      (fields.has("department") && (fields.has("workItemNo") || fields.has("csiLineCode")));
    if (!hasCore) continue;
    const exactCore = [...interpretation.columnField].some(
      ([col, field]) =>
        (field === "description" || field === "department") && FIELD_ALIASES[field].includes(normalizeHeader(row[col]))
    );
    if (interpretation.headingBacked < 2 && !exactCore) continue;

    if (interpretation.score > bestScore) {
      bestScore = interpretation.score;
      best = { index: i, columnField: interpretation.columnField };
    }
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
  if (value === undefined || value === null || value === "") return { value: null, wasNegative: false };
  const n = typeof value === "number" ? value : Number(String(value).replace(/[,$\s]/g, ""));
  if (!Number.isFinite(n)) return { value: null, wasNegative: false };
  if (n < 0) return { value: null, wasNegative: true };
  return { value: n, wasNegative: false };
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
  headerRow: unknown[],
  columnField: Map<number, NormalizedField>,
  row: unknown[]
): Record<string, string | number> | null {
  let fields: Record<string, string | number> | null = null;
  headerRow.forEach((headerCell, colIndex) => {
    if (columnField.has(colIndex)) return;
    const headerText = toStringOrNull(headerCell);
    if (!headerText || EXPORT_LATEST_HEADER_SET.has(headerText)) return;
    const cell = row[colIndex];
    if (cell === undefined || cell === null || String(cell).trim() === "") return;
    fields ??= {};
    fields[headerText] = typeof cell === "number" ? cell : String(cell).trim();
  });
  return fields;
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
 * Parses every sheet of an uploaded workbook into normalized work-item
 * rows. Never throws for bad *data* (a row missing a required field
 * becomes an issue, not a thrown error). In practice SheetJS's `read()`
 * is also extremely lenient about bad *files* — verified live: plain
 * text, random binary bytes, and a zero-byte buffer all parse without
 * throwing, they just yield zero sheets/rows rather than an exception.
 * The real safety net for "this wasn't a usable project file" is
 * therefore the caller checking `rows.length === 0` (see
 * app/api/admin/projects/import/route.ts), not a try/catch around this
 * call — that try/catch is kept only as defense-in-depth for whatever
 * SheetJS input shape (if any) genuinely does throw.
 */
export function parseProjectWorkbook(buffer: ArrayBuffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });

  const rows: ParsedWorkItemRow[] = [];
  const issues: ParseIssue[] = [];
  const sheetsScanned: string[] = [];
  const columnMappings: ParseResult["columnMappings"] = [];
  const diagnostics: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
    });
    if (grid.length === 0) continue;

    // Header row = the best-matching row within the first
    // HEADER_SEARCH_ROW_LIMIT rows, not necessarily the first non-blank
    // one (real exports, e.g. AIA G703, have project/application-info
    // rows above the actual table header). A sheet with no row that
    // resolves any department/description column at all is treated as
    // "not a work-item sheet" (e.g. a cover page or notes tab) and
    // silently skipped, rather than flooding issues with "missing
    // department" for every row of an unrelated sheet.
    const headerMatch = findHeaderRow(grid);
    if (!headerMatch) {
      diagnostics.push(
        `Sheet "${sheetName}": no row could be read as a work-item table header (a row naming the columns, with a work description column underneath).`
      );
      continue;
    }
    const { index: headerRowIndex, columnField } = headerMatch;
    const headerCells = grid[headerRowIndex];
    const mappedFields = new Set(columnField.values());
    const hasDepartmentColumn = mappedFields.has("department");
    // A table that has item numbers/quantities/values: a line there with
    // ONLY description text (a note, a legend) is not a work item.
    const identifyingFields: NormalizedField[] = ["workItemNo", "csiLineCode", "plannedQuantity", "unitOfMeasure", "scheduledValue"];
    const tableHasIdentifiers = identifyingFields.some((f) => mappedFields.has(f));
    columnMappings.push({
      sheet: sheetName,
      headerRow: headerRowIndex + 1,
      columns: [...columnField]
        .sort(([a], [b]) => a - b)
        .map(([col, field]) => ({ header: String(headerCells[col] ?? "").replace(/\s+/g, " ").trim(), field: FIELD_LABELS[field] })),
    });
    let unassignedCount = 0;
    const rowsBefore = rows.length;

    sheetsScanned.push(sheetName);
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

    for (let r = headerRowIndex + 1; r < grid.length; r++) {
      const row = grid[r];
      if (isRowBlank(row)) continue;

      const divisionHeader = extractDivisionHeader(row);
      if (divisionHeader) {
        currentDivision = divisionHeader;
        continue;
      }
      // Any other single-cell line (a title, legend, note or GRAND TOTAL
      // label) is not a work item. In a sheet with no department column,
      // a short ALL-CAPS line is a category heading for the rows below
      // (e.g. "ELECTRICAL WORK"), the same way a DIVISION row is.
      if (isSingleCellRow(row)) {
        const text = row.map((cell) => toStringOrNull(cell)).find((cell) => cell !== null) ?? "";
        if (
          !hasDepartmentColumn &&
          text.length <= 60 &&
          /[A-Z]/.test(text) &&
          text === text.toUpperCase() &&
          !isTotalRowMarker(text)
        ) {
          currentDivision = text.trim();
        }
        continue;
      }
      // A repeated header row (multi-page sheets): two or more cells equal
      // their own column's heading.
      if (
        row.filter((cell, c) => toStringOrNull(cell) !== null && normalizeHeader(cell) === normalizeHeader(headerCells[c]))
          .length >= 2
      ) {
        continue;
      }

      const sourceRow = r + 1;
      const get = (field: NormalizedField): unknown => {
        for (const [colIndex, mappedField] of columnField) {
          if (mappedField === field) return row[colIndex];
        }
        return undefined;
      };

      // A department cell may itself read "DIVISION 03 — CONCRETE": keep
      // just the name, exactly as a DIVISION heading row does.
      const departmentCell = toStringOrNull(get("department"));
      const departmentFromCell = departmentCell
        ? (departmentCell.match(/^division\s*[\w.]*\s*[-–—:]\s*(.+)$/i)?.[1].trim() ?? departmentCell)
        : null;
      let department = departmentFromCell ?? currentDivision;
      const rawDescription = toStringOrNull(get("description"));
      const workItemNo = toStringOrNull(get("workItemNo"));
      const csiLineCode = toStringOrNull(get("csiLineCode"));

      // Multi-page continuation sheets repeat the column header row on
      // every page, and typically carry a subtotal/grand-total row per
      // division or at the sheet's end. Neither is a real work item, so
      // both are silently skipped rather than imported as bogus rows.
      // Checked against whichever of description/item-no/CSI-code the
      // marker text actually landed in — a sheet with no Department
      // column (e.g. G703) puts "SUBTOTAL"/"GRAND TOTAL" under ITEM NO.,
      // not Description, and it must be caught there too, BEFORE
      // synthesizeDescription below would otherwise turn it into a fake
      // "Item SUBTOTAL" work item.
      if (rawDescription && FIELD_ALIASES.description.includes(normalizeHeader(rawDescription))) {
        continue;
      }
      if (isTotalRowMarker(rawDescription) || isTotalRowMarker(workItemNo) || isTotalRowMarker(csiLineCode)) {
        continue;
      }

      if (tableHasIdentifiers && identifyingFields.every((f) => toStringOrNull(get(f)) === null)) {
        if (rawDescription) {
          issues.push({
            sourceRow,
            sourceSheet: sheetName,
            message: "No item number, CSI code, quantity, unit or value — read as a note, not a work item (skipped).",
          });
        }
        continue;
      }

      if (!department) {
        department = UNASSIGNED_DEPARTMENT;
        unassignedCount++;
      }

      // A row genuinely missing "Description of Work" isn't necessarily
      // a bad row — G703 structure means the item number or CSI code
      // often still uniquely identifies it (see synthesizeDescription).
      // Only a row with NEITHER a description NOR anything to infer one
      // from is truly unusable and skipped.
      const description = rawDescription ?? synthesizeDescription(workItemNo, csiLineCode);
      if (!description) {
        issues.push({ sourceRow, sourceSheet: sheetName, message: "Missing work item description — row skipped." });
        continue;
      }
      const descriptionInferred = !rawDescription;
      if (descriptionInferred) {
        issues.push({
          sourceRow,
          sourceSheet: sheetName,
          message: `No description column value — used "${description}" from the item/CSI code instead.`,
        });
      }

      const plannedQuantity = toNumberOrNull(get("plannedQuantity"));
      const scheduledValue = toNumberOrNull(get("scheduledValue"));

      if (plannedQuantity.wasNegative) {
        issues.push({
          sourceRow,
          sourceSheet: sheetName,
          message: "Planned quantity was negative — ignored, row still imported without it.",
        });
      }
      if (scheduledValue.wasNegative) {
        issues.push({
          sourceRow,
          sourceSheet: sheetName,
          message: "Scheduled value was negative — ignored, row still imported without it.",
        });
      }

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

      rows.push({
        sourceRow,
        sourceSheet: sheetName,
        department,
        workItemNo,
        description,
        descriptionInferred,
        plannedQuantity: plannedQuantity.value,
        unitOfMeasure: toStringOrNull(get("unitOfMeasure")),
        scheduledValue: scheduledValue.value,
        csiLineCode,
        startDate: toDateStringOrNull(get("startDate")),
        endDate: toDateStringOrNull(get("endDate")),
        additionalFields: collectAdditionalFields(grid[headerRowIndex], columnField, row),
      });
    }

    if (unassignedCount > 0) {
      issues.push({
        sourceRow: headerRowIndex + 1,
        sourceSheet: sheetName,
        message: `${unassignedCount} row(s) have no department column or DIVISION/category heading — they will be placed under "${UNASSIGNED_DEPARTMENT}" (existing work items keep their own department).`,
      });
    }
    if (rows.length === rowsBefore) {
      const read = columnMappings[columnMappings.length - 1].columns.map((c) => `${c.header} → ${c.field}`).join(", ");
      diagnostics.push(
        `Sheet "${sheetName}": header row ${headerRowIndex + 1} was read (${read}), but no row below it had a work description or item number.`
      );
    }
  }

  return { rows, issues, sheetsScanned, columnMappings, diagnostics };
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
