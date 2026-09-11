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
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  scheduledValue: number | null;
  csiLineCode: string | null;
  startDate: string | null;
  endDate: string | null;
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
    "workitemno", "lineitemno", "itemno", "wbs", "lineitem", "item", "linenumber",
    "linen", "csicode", "code",
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
    "scheduledvalue", "amount", "value", "budget", "contractvalue", "estimatedamount", "cost",
  ],
  csiLineCode: ["csilinecode", "csi", "specsection", "csicoderef"],
  startDate: ["startdate", "start", "begindate"],
  endDate: ["enddate", "finish", "finishdate", "completiondate", "duedate"],
};

// workItemNo and csiLineCode share "code"-ish aliases on purpose (real
// files often only have one "Code" column that means line-item number).
// csiLineCode is matched second so workItemNo wins that ambiguity.
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

    // Header row = first non-blank row in the sheet.
    const headerRowIndex = grid.findIndex((row) => !isRowBlank(row));
    if (headerRowIndex === -1) continue;
    const headerRow = grid[headerRowIndex];
    const columnField = matchColumns(headerRow);

    // A sheet with no recognizable department/description columns at
    // all is treated as "not a work-item sheet" (e.g. a cover page or
    // notes tab) and silently skipped, rather than flooding issues
    // with "missing department" for every row of an unrelated sheet.
    const fieldsFound = new Set(columnField.values());
    if (!fieldsFound.has("department") && !fieldsFound.has("description")) {
      continue;
    }

    sheetsScanned.push(sheetName);
    // (department, workItemNo) pairs already seen ON THIS SHEET — the
    // upsert key upsertWorkItemFromImport commits with. Surfaced as a
    // visible issue rather than silently letting the later row's
    // values overwrite the earlier one's with no record of it having
    // happened (both rows are still imported; upsert intentionally
    // collapses them to one work item, same as a genuine re-upload
    // would — this is only about the operator being told).
    const seenKeys = new Set<string>();

    for (let r = headerRowIndex + 1; r < grid.length; r++) {
      const row = grid[r];
      if (isRowBlank(row)) continue;

      const sourceRow = r + 1;
      const get = (field: NormalizedField): unknown => {
        for (const [colIndex, mappedField] of columnField) {
          if (mappedField === field) return row[colIndex];
        }
        return undefined;
      };

      const department = toStringOrNull(get("department"));
      const description = toStringOrNull(get("description"));

      if (!department) {
        issues.push({ sourceRow, sourceSheet: sheetName, message: "Missing department — row skipped." });
        continue;
      }
      if (!description) {
        issues.push({ sourceRow, sourceSheet: sheetName, message: "Missing work item description — row skipped." });
        continue;
      }

      const workItemNo = toStringOrNull(get("workItemNo"));
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
        plannedQuantity: plannedQuantity.value,
        unitOfMeasure: toStringOrNull(get("unitOfMeasure")),
        scheduledValue: scheduledValue.value,
        csiLineCode: toStringOrNull(get("csiLineCode")),
        startDate: toDateStringOrNull(get("startDate")),
        endDate: toDateStringOrNull(get("endDate")),
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
