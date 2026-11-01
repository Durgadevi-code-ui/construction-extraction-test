/**
 * Size limit for imported workbooks: populated cells across ALL sheets
 * combined. Every populated cell becomes one workbook_cells row
 * (supabase/migrations/00000000000024_workbook_extractions.sql) at about
 * 580 bytes including indexes, so the default of 100,000 cells is roughly
 * 55 MB per import — sized for the Supabase Free plan's 500 MB database.
 *
 * A workbook over the limit is refused as a whole, before anything is
 * written (no partial import, no truncation): lib/excelImport.ts checks it
 * right after reading the cells, and lib/projectDocuments.ts again before
 * storing anything.
 *
 * Override with WORKBOOK_MAX_CELLS (a positive whole number). An invalid
 * value is ignored in favour of the default, with a warning.
 */
export const DEFAULT_WORKBOOK_MAX_CELLS = 100_000;

export function workbookMaxCells(): number {
  const raw = process.env.WORKBOOK_MAX_CELLS?.trim();
  if (!raw) return DEFAULT_WORKBOOK_MAX_CELLS;
  const n = Number(raw);
  if (Number.isSafeInteger(n) && n > 0) return n;
  console.warn(`WORKBOOK_MAX_CELLS is not a positive whole number; using the default of ${DEFAULT_WORKBOOK_MAX_CELLS}.`);
  return DEFAULT_WORKBOOK_MAX_CELLS;
}

export class WorkbookTooLargeError extends Error {
  readonly cellCount: number;
  readonly cellLimit: number;

  constructor(cellCount: number, cellLimit: number, sheets: { name: string; populatedCells: number }[]) {
    const largest = [...sheets]
      .filter((s) => s.populatedCells > 0)
      .sort((a, b) => b.populatedCells - a.populatedCells)
      .slice(0, 5)
      .map((s) => `"${s.name}" ${s.populatedCells.toLocaleString("en-US")}`)
      .join(", ");
    super(
      `This workbook has ${cellCount.toLocaleString("en-US")} populated cells across ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}` +
        `${largest ? ` (${largest})` : ""}, more than the import limit of ${cellLimit.toLocaleString("en-US")} cells for a whole workbook. ` +
        "Nothing was imported. Split it into smaller workbooks, or remove sheets or rows that aren't needed, and upload again."
    );
    this.name = "WorkbookTooLargeError";
    this.cellCount = cellCount;
    this.cellLimit = cellLimit;
  }
}

/** Throws WorkbookTooLargeError when the sheets' populated cells, added
 * together, exceed the limit. Exactly at the limit is allowed. */
export function assertWithinCellLimit(sheets: { name: string; populatedCells: number }[], limit = workbookMaxCells()): void {
  const cellCount = sheets.reduce((n, s) => n + s.populatedCells, 0);
  if (cellCount > limit) throw new WorkbookTooLargeError(cellCount, limit, sheets);
}
