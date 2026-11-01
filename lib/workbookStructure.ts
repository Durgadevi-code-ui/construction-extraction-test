import "server-only";
import type { RawCell, RawRow, RawSheet, RawWorkbook } from "./workbookExtract";

/**
 * Layer 1 — complete, dynamic workbook extraction.
 *
 * Builds on the raw cell read (lib/workbookExtract.ts) and works out each
 * worksheet's own structure WITHOUT any predefined column names: where
 * its tables are (any number per sheet, header rows anywhere), what each
 * table's columns are called (taken from the sheet itself, including
 * multi-row and merged headers), and what every other populated row is
 * (title, metadata, note). Every populated cell of every worksheet is
 * placed exactly once — with its sheet, row, column, header label, row
 * role and table — and `assertComplete` refuses a result where any cell
 * is missing or counted twice.
 *
 * This is the data of record for an import: it is stored as-is (see
 * lib/projectDocuments.ts saveProjectImport) and is what AI analysis and
 * reporting read. The construction work-item mapping (lib/excelImport.ts,
 * Layer 2) is derived from the same workbook and never removes anything
 * from this layer.
 *
 * Pure — no I/O.
 */

export const EXTRACTION_SCHEMA_VERSION = 1;

/** What a populated row is. Only rows inside a table get a header label
 * per cell; every other row keeps its cells with their column letters. */
export type RowRole =
  | "title" // a single text line outside any table (sheet title, caption)
  | "metadata" // a "Label: value" style line outside any table
  | "note" // any other line outside a table
  | "header" // a table's column-header row
  | "header-band" // extra header rows under it (group/sub-headers, column letters)
  | "repeated-header" // the same header row again (multi-page sheets)
  | "data" // a table row
  | "section" // a single-cell line inside a table (e.g. a division heading)
  | "total"; // a total/subtotal line inside a table

export type ExtractedCell = RawCell & {
  /** Column letter, e.g. "C". */
  column: string;
  /** The column's header label for cells in a table's data/total rows
   * (from the sheet's own header, or "Column C" when that column has no
   * header). Absent outside tables, on header rows and on single-line
   * section/note rows inside a table. */
  header?: string;
};

export type ExtractedRow = {
  /** 1-based sheet row. */
  row: number;
  /** 1-based position among the sheet's populated rows (original order). */
  order: number;
  role: RowRole;
  /** 1-based table index on the sheet, for rows that belong to a table. */
  table?: number;
  cells: ExtractedCell[];
};

export type ExtractedTableColumn = { col: number; column: string; header: string };

export type ExtractedTable = {
  /** 1-based index on the sheet. */
  index: number;
  /** Sheet rows of the header (first) and its band rows. */
  headerRows: number[];
  firstRow: number;
  lastRow: number;
  columns: ExtractedTableColumn[];
  /** Data rows (role "data"), sections and totals in this table. */
  dataRows: number;
  sectionRows: number;
  totalRows: number;
};

export type ExtractedSheet = {
  name: string;
  index: number;
  visibility: RawSheet["visibility"];
  status: RawSheet["status"];
  message?: string;
  usedRange: string | null;
  merges: string[];
  populatedRows: number;
  populatedCells: number;
  formulaCells: number;
  tables: ExtractedTable[];
  rows: ExtractedRow[];
};

export type WorkbookExtraction = {
  schemaVersion: number;
  source: { fileName: string; bytes: number; sha256: string };
  extractedAt: string;
  sheets: ExtractedSheet[];
  totals: { sheets: number; tables: number; rows: number; cells: number; formulaCells: number };
};

// ---------------------------------------------------------------- helpers

const TOTAL_MARKER = /^(sub\s*-?\s*total|grand\s*total|total\b|totals\b)/i;

const columnLetter = (col: number): string => {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const cellText = (c: RawCell): string => (c.text ?? (c.value === null ? "" : String(c.value))).replace(/\s+/g, " ").trim();

/** A label-like cell: text with a letter, not a number/date/boolean. */
const isLabel = (c: RawCell): boolean => c.type === "string" && /[A-Za-z]/.test(String(c.value ?? ""));
const isValue = (c: RawCell): boolean => c.type === "number" || c.type === "date" || c.type === "boolean";

const isColumnLetterRow = (row: RawRow): boolean =>
  row.cells.length >= 2 && row.cells.every((c) => c.type === "string" && /^\(?[A-Z]{1,2}(\s*[-+/÷×*]\s*[A-Z]{1,2})*\)?$/.test(cellText(c)));

const isTotalRow = (row: RawRow): boolean => row.cells.some((c) => c.type === "string" && TOTAL_MARKER.test(cellText(c)));

/** Header-like: two or more cells, at least 60% labels, no long prose. */
function isHeaderLike(row: RawRow): boolean {
  if (row.cells.length < 2 || isTotalRow(row)) return false;
  const labels = row.cells.filter(isLabel);
  return labels.length >= 2 && labels.length / row.cells.length >= 0.6 && labels.every((c) => cellText(c).length <= 80);
}

const colsOf = (row: RawRow) => new Set(row.cells.map((c) => c.col));

const sameLabels = (a: RawRow, b: RawRow): boolean => {
  const key = (r: RawRow) => r.cells.map((c) => `${c.col}:${cellText(c).toLowerCase()}`).join("|");
  return key(a) === key(b);
};

/**
 * Whether `row` starts a table: it is header-like and the next populated
 * row (within a one-blank-row gap) has values under at least one of its
 * columns. When `strict`, at least one of the rows below must hold a
 * number/date/boolean under the candidate's columns while the candidate
 * holds a label there — the "label over values" shape that tells a real
 * header from a text-only data row that merely follows a blank line.
 */
function startsTable(rows: RawRow[], i: number, strict: boolean): boolean {
  const row = rows[i];
  if (!isHeaderLike(row)) return false;
  const next = rows[i + 1];
  if (!next || next.row - row.row > 2) return false;
  const cols = colsOf(row);
  const below = rows.slice(i + 1, i + 6).filter((r) => r.row - row.row <= 12);
  // "Label | value" lines (a cover page or form header) are metadata, not
  // a two-column table whose first line happens to be text.
  const block: RawRow[] = [row];
  for (let j = i + 1; j < rows.length && rows[j].row - block[block.length - 1].row === 1; j++) block.push(rows[j]);
  const firstCol = row.cells[0].col;
  if (row.cells.length === 2 && block.every((r) => r.cells.length <= 2 && r.cells[0].col === firstCol && isLabel(r.cells[0]))) return false;
  const overlaps = below.some((r) => r.cells.filter((c) => cols.has(c.col)).length >= 1);
  if (!overlaps) return false;
  if (!strict) return true;
  return below.some((r) => r.cells.some((c) => cols.has(c.col) && isValue(c)));
}

/** Header-band rows directly under a header: column-letter rows, or
 * text-only rows that put a label under a header cell that is blank (the
 * continuation of a merged group heading). At most two. */
function bandLength(rows: RawRow[], headerIdx: number): number {
  const header = rows[headerIdx];
  const headerCols = colsOf(header);
  let n = 0;
  while (n < 2) {
    const row = rows[headerIdx + 1 + n];
    if (!row || row.row - (rows[headerIdx + n].row) > 1) break;
    const textOnly = row.cells.every((c) => c.type === "string");
    const underBlank = row.cells.some((c) => !headerCols.has(c.col));
    if (!(isColumnLetterRow(row) || (textOnly && underBlank && !isTotalRow(row) && row.cells.length >= 2))) break;
    // A band row must be followed by something that is not itself a band.
    n++;
  }
  return n;
}

/** Column labels for a table from its header row and band rows, with
 * merged group headings spread over the columns they cover. */
function tableColumns(header: RawRow, band: RawRow[], allRows: RawRow[], merges: string[]): ExtractedTableColumn[] {
  const groupAt = new Map<number, string>();
  for (const cell of header.cells) {
    const label = cellText(cell);
    groupAt.set(cell.col, label);
    const merge = cell.merge ?? merges.find((m) => m.startsWith(`${cell.ref}:`));
    if (merge) {
      const [, end] = merge.split(":");
      const endCol = decodeCol(end);
      for (let c = cell.col + 1; c <= endCol; c++) if (!groupAt.has(c)) groupAt.set(c, label);
    }
  }
  const letterBand = band.find(isColumnLetterRow);
  const subRows = band.filter((r) => r !== letterBand);
  const cols = new Set<number>([...groupAt.keys(), ...band.flatMap((r) => r.cells.map((c) => c.col))]);
  for (const r of allRows) for (const c of r.cells) cols.add(c.col);
  const used = new Map<string, number>();
  return [...cols]
    .sort((a, b) => a - b)
    .map((col) => {
      const parts = [groupAt.get(col), ...subRows.map((r) => r.cells.find((c) => c.col === col)).map((c) => (c ? cellText(c) : undefined))]
        .filter((p): p is string => !!p);
      const unique = [...new Set(parts)];
      let header = unique.length ? unique.join(" / ") : `Column ${columnLetter(col)}`;
      const seen = used.get(header.toLowerCase()) ?? 0;
      used.set(header.toLowerCase(), seen + 1);
      if (seen > 0) header = `${header} (${seen + 1})`;
      return { col, column: columnLetter(col), header };
    });
}

function decodeCol(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function outsideRole(row: RawRow): RowRole {
  if (row.cells.length === 1) return row.cells[0].type === "string" ? "title" : "note";
  if (row.cells.length === 2 && isLabel(row.cells[0])) return "metadata";
  return "note";
}

// ---------------------------------------------------------------- sheets

/** Structure of one raw sheet: tables, row roles and labelled cells. */
export function structureSheet(raw: RawSheet): ExtractedSheet {
  const rows = raw.rows;
  const roles: { role: RowRole; table?: number }[] = rows.map(() => ({ role: "note" as RowRole }));
  const tables: { index: number; headerIdx: number; band: number; lastIdx: number }[] = [];

  let current: (typeof tables)[number] | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (current) {
      const header = rows[current.headerIdx];
      const gapBefore = row.row - rows[i - 1].row > 1;
      if (sameLabels(row, header)) {
        roles[i] = { role: "repeated-header", table: current.index };
        current.lastIdx = i;
        continue;
      }
      // A new table: header-like, after a blank row, different columns or
      // labels from the current header, with values below it.
      const differs = [...colsOf(row)].some((c) => !colsOf(header).has(c)) || !sameLabels(row, header);
      if (gapBefore && differs && startsTable(rows, i, true)) {
        current = null;
      } else {
        const single = row.cells.length === 1;
        const role: RowRole = isTotalRow(row)
          ? "total"
          : single && /^(note\b|notes\b|\*|\()/i.test(cellText(row.cells[0]))
            ? "note"
            : single
              ? "section"
              : "data";
        roles[i] = { role, table: current.index };
        current.lastIdx = i;
        continue;
      }
    }
    if (startsTable(rows, i, tables.length > 0)) {
      const band = bandLength(rows, i);
      current = { index: tables.length + 1, headerIdx: i, band, lastIdx: i + band };
      tables.push(current);
      roles[i] = { role: "header", table: current.index };
      for (let b = 1; b <= band; b++) roles[i + b] = { role: "header-band", table: current.index };
      i += band;
      continue;
    }
    roles[i] = { role: outsideRole(row) };
  }

  // Trailing single-line rows after a table's last multi-cell row read as
  // notes/titles rather than table sections when separated by a blank row.
  for (const t of tables) {
    let i = t.lastIdx;
    while (i > t.headerIdx + t.band && rows[i].cells.length === 1 && roles[i].role === "section" && rows[i].row - rows[i - 1].row > 1) {
      roles[i] = { role: outsideRole(rows[i]) };
      i--;
    }
    t.lastIdx = i;
  }

  const extractedTables: ExtractedTable[] = tables.map((t) => {
    const header = rows[t.headerIdx];
    const band = rows.slice(t.headerIdx + 1, t.headerIdx + 1 + t.band);
    const body: RawRow[] = [];
    const count = { data: 0, section: 0, total: 0 };
    rows.forEach((r, i) => {
      const { role, table } = roles[i];
      if (table !== t.index || !(role === "data" || role === "section" || role === "total")) return;
      body.push(r);
      count[role]++;
    });
    return {
      index: t.index,
      headerRows: [header.row, ...band.map((r) => r.row)],
      firstRow: header.row,
      lastRow: rows[t.lastIdx].row,
      columns: tableColumns(header, band, body, raw.merges),
      dataRows: count.data,
      sectionRows: count.section,
      totalRows: count.total,
    };
  });
  const columnsByTable = new Map(extractedTables.map((t) => [t.index, new Map(t.columns.map((c) => [c.col, c.header]))]));

  const outRows: ExtractedRow[] = rows.map((row, i) => {
    const { role, table } = roles[i];
    // Single-line sections/notes inside a table are not values of a column.
    const labelled = table !== undefined && (role === "data" || role === "total");
    const labels = table !== undefined ? columnsByTable.get(table) : undefined;
    return {
      row: row.row,
      order: i + 1,
      role,
      ...(table !== undefined ? { table } : {}),
      cells: row.cells.map((cell) => ({
        ...cell,
        column: columnLetter(cell.col),
        ...(labelled ? { header: labels?.get(cell.col) ?? `Column ${columnLetter(cell.col)}` } : {}),
      })),
    };
  });

  return {
    name: raw.name,
    index: raw.index,
    visibility: raw.visibility,
    status: raw.status,
    ...(raw.message ? { message: raw.message } : {}),
    usedRange: raw.usedRange,
    merges: raw.merges,
    populatedRows: raw.populatedRows,
    populatedCells: raw.populatedCells,
    formulaCells: raw.formulaCells,
    tables: extractedTables,
    rows: outRows,
  };
}

/**
 * Layer 1 for a whole workbook. Throws if any populated cell of the raw
 * read is missing from, or duplicated in, the result.
 */
export function buildWorkbookExtraction(
  raw: RawWorkbook,
  source: WorkbookExtraction["source"],
  extractedAt = new Date().toISOString()
): WorkbookExtraction {
  const sheets = raw.sheets.map(structureSheet);
  const extraction: WorkbookExtraction = {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    source,
    extractedAt,
    sheets,
    totals: {
      sheets: sheets.length,
      tables: sheets.reduce((n, s) => n + s.tables.length, 0),
      rows: sheets.reduce((n, s) => n + s.rows.length, 0),
      cells: sheets.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.cells.length, 0), 0),
      formulaCells: sheets.reduce((n, s) => n + s.formulaCells, 0),
    },
  };
  assertComplete(raw, extraction);
  return extraction;
}

/** Every raw populated cell appears exactly once, at the same place with
 * the same value. */
export function assertComplete(raw: RawWorkbook, extraction: WorkbookExtraction): void {
  if (raw.sheets.length !== extraction.sheets.length) throw new Error("Extraction lost a worksheet.");
  raw.sheets.forEach((sheet, s) => {
    const out = extraction.sheets[s];
    if (out.name !== sheet.name) throw new Error(`Extraction changed worksheet order at "${sheet.name}".`);
    const seen = new Map<string, ExtractedCell>();
    for (const row of out.rows) {
      for (const cell of row.cells) {
        if (seen.has(cell.ref)) throw new Error(`Cell ${sheet.name}!${cell.ref} extracted twice.`);
        seen.set(cell.ref, cell);
      }
    }
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        const got = seen.get(cell.ref);
        if (!got || got.value !== cell.value || got.formula !== cell.formula) {
          throw new Error(`Cell ${sheet.name}!${cell.ref} missing or changed in the extraction.`);
        }
        seen.delete(cell.ref);
      }
    }
    if (seen.size > 0) throw new Error(`Extraction invented ${seen.size} cell(s) on "${sheet.name}".`);
  });
}

/**
 * A table's rows as records — `{ header: value }` per data row, in sheet
 * order — for AI analysis and reporting. Section and total rows are
 * included with their role so nothing is hidden.
 */
export function tableRecords(
  sheet: ExtractedSheet,
  tableIndex: number
): { row: number; role: RowRole; values: Record<string, string | number | boolean | null> }[] {
  return sheet.rows
    .filter((r) => r.table === tableIndex && (r.role === "data" || r.role === "section" || r.role === "total"))
    .map((r) => ({
      row: r.row,
      role: r.role,
      values: Object.fromEntries(r.cells.map((c) => [c.header ?? `Column ${c.column}`, c.date ?? c.value])),
    }));
}

/** Small summary for previews and API responses (no cell contents). */
export function extractionSummary(extraction: WorkbookExtraction) {
  return {
    schemaVersion: extraction.schemaVersion,
    totals: extraction.totals,
    sheets: extraction.sheets.map((s) => ({
      name: s.name,
      index: s.index,
      visibility: s.visibility,
      status: s.status,
      populatedRows: s.populatedRows,
      populatedCells: s.populatedCells,
      rowsByRole: s.rows.reduce<Partial<Record<RowRole, number>>>((m, r) => ((m[r.role] = (m[r.role] ?? 0) + 1), m), {}),
      tables: s.tables.map((t) => ({
        index: t.index,
        headerRow: t.headerRows[0],
        rows: `${t.firstRow}-${t.lastRow}`,
        columns: t.columns.map((c) => c.header),
        dataRows: t.dataRows,
        totalRows: t.totalRows,
      })),
    })),
  };
}
