import "server-only";
import * as XLSX from "xlsx";

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
};

type NormalizedField =
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

/** Maps each column index in a header row to the normalized field it
 * represents, if any. A column that matches no known alias is simply
 * ignored (never an error — "extra columns" must be tolerated). */
function matchColumns(headerRow: unknown[]): Map<number, NormalizedField> {
  const columnField = new Map<number, NormalizedField>();
  const claimedFields = new Set<NormalizedField>();

  headerRow.forEach((cell, colIndex) => {
    const normalized = normalizeHeader(cell);
    if (!normalized) return;

    for (const field of FIELD_MATCH_ORDER) {
      if (claimedFields.has(field)) continue;
      if (FIELD_ALIASES[field].includes(normalized)) {
        columnField.set(colIndex, field);
        claimedFields.add(field);
        return;
      }
    }
  });

  return columnField;
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
// NO.", "PERIOD TO:", etc.) above the real table header. Instead of
// assuming the first non-blank row is the header, scan the first several
// rows and pick whichever one matches the most known field aliases (and
// includes at least a department or description column) — that's the
// real header row regardless of how much metadata sits above it.
const HEADER_SEARCH_ROW_LIMIT = 50;

function findHeaderRow(
  grid: unknown[][]
): { index: number; columnField: Map<number, NormalizedField> } | null {
  let best: { index: number; columnField: Map<number, NormalizedField> } | null = null;
  let bestScore = 0;

  for (let i = 0; i < Math.min(grid.length, HEADER_SEARCH_ROW_LIMIT); i++) {
    const row = grid[i];
    if (isRowBlank(row)) continue;

    const columnField = matchColumns(row);
    const fieldsFound = new Set(columnField.values());
    if (!fieldsFound.has("department") && !fieldsFound.has("description")) continue;

    if (columnField.size > bestScore) {
      bestScore = columnField.size;
      best = { index: i, columnField };
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
  return !!text && /^(grand\s+)?(sub)?\s*total\b/i.test(text.trim());
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
function collectAdditionalFields(
  headerRow: unknown[],
  columnField: Map<number, NormalizedField>,
  row: unknown[]
): Record<string, string | number> | null {
  let fields: Record<string, string | number> | null = null;
  headerRow.forEach((headerCell, colIndex) => {
    if (columnField.has(colIndex)) return;
    const headerText = toStringOrNull(headerCell);
    if (!headerText) return;
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
    if (!headerMatch) continue;
    const { index: headerRowIndex, columnField } = headerMatch;

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

      const sourceRow = r + 1;
      const get = (field: NormalizedField): unknown => {
        for (const [colIndex, mappedField] of columnField) {
          if (mappedField === field) return row[colIndex];
        }
        return undefined;
      };

      const department = toStringOrNull(get("department")) ?? currentDivision;
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

      if (!department) {
        issues.push({ sourceRow, sourceSheet: sheetName, message: "Missing department — row skipped." });
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
  }

  return { rows, issues, sheetsScanned };
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
