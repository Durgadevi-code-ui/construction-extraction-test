import "server-only";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getUserContext, isAdminUser, CONTRACTOR_ROLES } from "./authContext";
import { getActiveDelegationsForUser } from "./delegation";
import { listDepartments, normalizeLineItemNo } from "./admin";
import { getWorkItemCurrentStatus, parseWorkItemTasks, type ProgressData } from "./workflow";
import { calculateEstimatedAmount } from "./calculations";
import {
  EXPORT_LATEST_HEADERS,
  findSheetLayout,
  isDivisionHeaderRow,
  isTotalRow,
  parseProjectWorkbook,
  type ParsedWorkItemRow,
} from "./excelImport";
import { listProjectImportFiles } from "./projectDocuments";
import { patchOriginalWorkbook } from "./excelPreserve";
import { formatDateUS, formatPercent, formatTimeUS } from "./format";

/**
 * "Download updated Excel" — the project's workbook as of right now,
 * limited to what the caller may see.
 *
 * Structure: when an original uploaded workbook is on file (see
 * lib/projectDocuments.ts — stored on every import commit; the project's
 * working sheet is picked by chooseTemplate), THAT file is the template,
 * rebuilt at every download from the current approved data: same
 * sheets, header block, column headings, division rows and work item
 * rows; its typed "% Complete" / "Completed Qty" columns, if it has
 * them, show the current approved values (progressColumnsOf), every
 * other original cell keeps its uploaded value, and the latest data is
 * also given in clearly labelled "Latest …" columns appended to the
 * right of each work-item table. Otherwise (projects imported before
 * originals were kept) a workbook is rebuilt from the database in the
 * same G703 shape the importer reads (DIVISION headings, Item No,
 * Description of Work, Scheduled Value, Planned Quantity, Unit, plus
 * every imported extra column).
 *
 * Visibility (resolveExcelExportScope — same sources as every other
 * check in this app: isAdminUser, the caller's own Active role rows,
 * active delegations):
 *   - Admin: every department, amounts included.
 *   - Contractor (SUPERVISOR/MANAGER) / delegated Contractor: their
 *     own + delegated departments, amounts included there.
 *   - Subcontractor (FOREMAN): their own department(s) only; Amount
 *     columns are kept in place but left BLANK.
 *   - Worker: not authorized.
 * An optional departmentId (the Subcontractor's current department)
 * narrows any of the above to that one department — never widens it.
 * A work item row outside the caller's departments is emptied (the row
 * stays, so the sheet's shape is unchanged) — for a caller without full
 * access, so are other divisions' headings/subtotal labels and lines
 * that can't be tied to their departments — and unless the caller has
 * full access to every department with amounts, subtotal/total rows and
 * numbers outside the work-item tables (e.g. a G702 summary sheet's
 * contract sums) are blanked too — an aggregate would otherwise leak
 * other divisions' or financial data.
 *
 * Read-only: nothing here writes to the database or storage.
 */

export type ExcelExportResult = {
  buffer: Buffer;
  fileName: string;
  /** "original" = the stored uploaded workbook, refilled; "generated" =
   * rebuilt from the database (no original on file). */
  source: "original" | "generated";
};

/** Exported with the two pure workbook transforms below so they can be
 * verified without a database. */
export type ExportScope = {
  projectId: string;
  projectName: string;
  /** Departments whose work-item data the caller may receive. */
  departmentIds: Set<string>;
  /** Departments whose amounts the caller may receive (a subset). */
  amountDepartmentIds: Set<string>;
  /** Every department of the project, with amounts — the only case
   * where totals and summary figures are left as uploaded. */
  fullAccess: boolean;
};

async function resolveExcelExportScope(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  departmentId?: string | null
): Promise<ExportScope> {
  const { data: project, error } = await supabase
    .from("projects")
    .select("project_name")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load project: ${error.message}`);
  if (!project) throw new Error("Project not found.");

  const projectDepartmentIds = (await listDepartments(supabase))
    .filter((d) => d.projectId === projectId)
    .map((d) => d.departmentId);

  const departmentIds = new Set<string>();
  const amountDepartmentIds = new Set<string>();

  if (await isAdminUser(supabase, userId)) {
    projectDepartmentIds.forEach((id) => {
      departmentIds.add(id);
      amountDepartmentIds.add(id);
    });
  } else {
    const ctx = await getUserContext(supabase, userId, { projectId });
    for (const row of ctx.availableProjects) {
      if (row.projectId !== projectId || row.role === "WORKER") continue;
      departmentIds.add(row.departmentId);
      if (CONTRACTOR_ROLES.includes(row.role)) amountDepartmentIds.add(row.departmentId);
    }
    // A delegated Contractor also covers the delegation's departments —
    // the same expansion the Contractor dashboard uses (lib/dashboard.ts).
    if (ctx.availableProjects.some((row) => CONTRACTOR_ROLES.includes(row.role))) {
      const delegations = await getActiveDelegationsForUser(supabase, userId).catch(() => []);
      for (const delegation of delegations) {
        if (!delegation.projects.some((p) => p.projectId === projectId)) continue;
        const restricted = delegation.departments.filter((d) => d.projectId === projectId).map((d) => d.departmentId);
        for (const id of restricted.length > 0 ? restricted : projectDepartmentIds) {
          departmentIds.add(id);
          amountDepartmentIds.add(id);
        }
      }
    }
    if (departmentIds.size === 0) {
      throw new Error(`User ${userId} is not authorized to download this project's data`);
    }
  }

  // A department-scoped page (the Subcontractor's) asks for its current
  // department only: the scope above is narrowed to it, never widened —
  // a department outside the caller's own scope is refused.
  if (departmentId) {
    if (!departmentIds.has(departmentId)) {
      throw new Error(`User ${userId} is not authorized to download this department's data`);
    }
    const withAmounts = amountDepartmentIds.has(departmentId);
    departmentIds.clear();
    amountDepartmentIds.clear();
    departmentIds.add(departmentId);
    if (withAmounts) amountDepartmentIds.add(departmentId);
  }

  return {
    projectId,
    projectName: project.project_name as string,
    departmentIds,
    amountDepartmentIds,
    fullAccess: projectDepartmentIds.every((id) => departmentIds.has(id) && amountDepartmentIds.has(id)),
  };
}

export type ExportWorkItem = {
  workItemId: string;
  departmentId: string;
  departmentName: string;
  lineItemNo: string;
  description: string;
  csiLineCode: string | null;
  scheduledValue: number | null;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
  isActive: boolean;
  additionalFields: Record<string, unknown> | null;
};

export type LatestValues = {
  progress: number | null;
  approvedQuantity: number | null;
  earned: number | null;
  balance: number | null;
  status: string;
  lastApprovedAt: string | null;
  latestUpdate: string | null;
  tasks: string | null;
};

async function loadProjectWorkItems(supabase: SupabaseClient, projectId: string): Promise<ExportWorkItem[]> {
  const { data, error } = await supabase
    .from("work_items")
    .select(
      "work_item_id, department_id, line_item_no, csi_line_code, description_of_work, scheduled_value, planned_quantity, unit_of_measure, status, additional_fields, departments(department_name)"
    )
    .eq("project_id", projectId)
    .order("line_item_no", { ascending: true });
  if (error) throw new Error(`Failed to load work items: ${error.message}`);

  type DeptRef = { department_name: string };
  return (data ?? []).map((w) => {
    const dept = w.departments as DeptRef | DeptRef[] | null;
    return {
      workItemId: w.work_item_id as string,
      departmentId: w.department_id as string,
      departmentName: (Array.isArray(dept) ? dept[0]?.department_name : dept?.department_name) ?? "(unknown)",
      lineItemNo: w.line_item_no as string,
      description: w.description_of_work as string,
      csiLineCode: (w.csi_line_code as string | null) ?? null,
      scheduledValue: (w.scheduled_value as number | null) ?? null,
      plannedQuantity: (w.planned_quantity as number | null) ?? null,
      unitOfMeasure: (w.unit_of_measure as string | null) ?? null,
      isActive: w.status === "Active",
      additionalFields: (w.additional_fields as Record<string, unknown> | null) ?? null,
    };
  });
}

/** Latest approved figures for the in-scope work items only — the same
 * approved-progress calculation every screen uses
 * (getWorkItemCurrentStatus), never pending/unapproved values. */
async function loadLatestValues(
  supabase: SupabaseClient,
  items: ExportWorkItem[]
): Promise<Map<string, LatestValues>> {
  const latestApproved = new Map<string, { at: string; note: string | null }>();
  if (items.length > 0) {
    const { data, error } = await supabase
      .from("unified_records")
      .select("work_item_id, accepted_at, accepted_data")
      .eq("status", "APPROVED")
      .in(
        "work_item_id",
        items.map((i) => i.workItemId)
      )
      .order("accepted_at", { ascending: false });
    if (error) throw new Error(`Failed to load approved progress: ${error.message}`);
    for (const row of data ?? []) {
      if (latestApproved.has(row.work_item_id as string) || !row.accepted_at) continue;
      latestApproved.set(row.work_item_id as string, {
        at: row.accepted_at as string,
        note: (row.accepted_data as ProgressData | null)?.description?.trim() || null,
      });
    }
  }

  const result = new Map<string, LatestValues>();
  await Promise.all(
    items.map(async (item) => {
      const status = await getWorkItemCurrentStatus(supabase, item.workItemId, item.plannedQuantity);
      const earned = calculateEstimatedAmount(item.scheduledValue, status.progressPercentage);
      const approved = latestApproved.get(item.workItemId);
      const tasks = parseWorkItemTasks(item.additionalFields)
        .filter((t) => t.status === "Active")
        .map(
          (t) =>
            `${t.label}: ${
              t.progress ? (t.progress.completed ? "Done" : formatPercent(t.progress.percent)) : "no update"
            }`
        );
      result.set(item.workItemId, {
        progress: status.progressPercentage,
        approvedQuantity: status.approvedQuantity,
        earned,
        balance:
          item.scheduledValue !== null ? Math.round((item.scheduledValue - (earned ?? 0)) * 100) / 100 : null,
        status: !item.isActive
          ? "Inactive"
          : status.isCompleted
            ? "Completed"
            : (status.progressPercentage ?? 0) > 0
              ? "In Progress"
              : "Not Started",
        lastApprovedAt: approved?.at ?? null,
        latestUpdate: approved?.note ?? null,
        tasks: tasks.length > 0 ? tasks.join("; ") : null,
      });
    })
  );
  return result;
}

/** The "Latest …" columns appended to every work-item table. `amount`
 * columns are blank wherever the caller may not see amounts. */
const LATEST_COLUMNS: { key: keyof LatestValues; header: string; amount: boolean; wch: number }[] = [
  { key: "progress", header: EXPORT_LATEST_HEADERS.progress, amount: false, wch: 12 },
  { key: "approvedQuantity", header: EXPORT_LATEST_HEADERS.approvedQuantity, amount: false, wch: 12 },
  { key: "earned", header: EXPORT_LATEST_HEADERS.earned, amount: true, wch: 16 },
  { key: "balance", header: EXPORT_LATEST_HEADERS.balance, amount: true, wch: 16 },
  { key: "status", header: EXPORT_LATEST_HEADERS.status, amount: false, wch: 13 },
  { key: "lastApprovedAt", header: EXPORT_LATEST_HEADERS.lastApprovedAt, amount: false, wch: 14 },
  { key: "latestUpdate", header: EXPORT_LATEST_HEADERS.latestUpdate, amount: false, wch: 40 },
  { key: "tasks", header: EXPORT_LATEST_HEADERS.tasks, amount: false, wch: 40 },
];
type LatestColumn = (typeof LATEST_COLUMNS)[number];

function latestCell(key: keyof LatestValues, values: LatestValues, amountsAllowed: boolean): XLSX.CellObject | null {
  const column = LATEST_COLUMNS.find((c) => c.key === key)!;
  if (column.amount && !amountsAllowed) return null;
  const v = values[key];
  if (v === null || v === undefined) return null;
  switch (key) {
    case "progress":
      return { t: "n", v: (v as number) / 100, z: "0.0%" };
    case "earned":
    case "balance":
      return { t: "n", v: v as number, z: "$#,##0.00" };
    case "approvedQuantity":
      return { t: "n", v: v as number };
    case "lastApprovedAt":
      return { t: "s", v: `${formatDateUS(v as string, "/")} ${formatTimeUS(v as string)}`.trim() };
    default:
      return { t: "s", v: String(v) };
  }
}

/** Header text that denotes money (G703: Scheduled Value, Work Completed
 * From Previous Application / This Period, Materials Stored, Total
 * Completed and Stored, Balance to Finish, Retainage …). Deliberately
 * broad: blanking a non-money column for a restricted role is safe;
 * missing a money column is not. */
function isAmountHeader(header: unknown): boolean {
  const raw = String(header ?? "");
  const n = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    raw.includes("$") ||
    /(value|amount|cost|budget|price|retainage|balance|completed|stored|previous|period|total|earned|billed|payment|sum|fee|rate|contract)/.test(
      n
    )
  );
}

function isDateCell(cell: XLSX.CellObject): boolean {
  return cell.t === "d" || (cell.t === "n" && typeof cell.z === "string" && XLSX.SSF.is_date(cell.z));
}

/** Removes a figure that could reveal amounts/aggregates: any formula,
 * any non-date number, and any "$1,234"-style text. Plain labels stay. */
function redactFigure(ws: XLSX.WorkSheet, address: string) {
  const cell = ws[address] as XLSX.CellObject | undefined;
  if (!cell) return;
  const moneyText = cell.t === "s" && /\$\s?\d/.test(String(cell.v ?? ""));
  if (cell.f || moneyText || (cell.t === "n" && !isDateCell(cell))) delete ws[address];
}

/** Matches one uploaded row to its work item exactly the way the import
 * did (lib/admin.ts upsertWorkItemFromImport): by item number across the
 * project, else by department + description. */
function matchWorkItem(row: ParsedWorkItemRow, items: ExportWorkItem[]): ExportWorkItem | null {
  if (row.workItemNo) {
    const key = normalizeLineItemNo(row.workItemNo);
    const matches = items.filter((w) => normalizeLineItemNo(w.lineItemNo) === key);
    if (matches.length === 1) return matches[0];
    const dept = row.department.trim().toLowerCase();
    return matches.find((w) => w.departmentName.trim().toLowerCase() === dept) ?? null;
  }
  const description = row.description.trim().toLowerCase();
  const matches = items.filter((w) => w.description.trim().toLowerCase() === description);
  return matches.length === 1 ? matches[0] : null;
}

/** Headings of ORIGINAL columns that mean exactly what the app stores
 * per work item — approved % complete, and cumulative approved
 * (completed/installed) quantity — compared with case, spaces and
 * punctuation removed. Deliberately exact: G703's "% (H/D)", "Total
 * Completed & Stored", "This Period", "From Previous Application" and
 * "Materials Stored" are formulas or billing-period figures the app has
 * no data for, so they never match and keep their uploaded values. */
const PERCENT_COMPLETE_HEADINGS = new Set([
  "%complete", "%completed", "percentcomplete", "percentcompleted", "pctcomplete", "complete%",
  "completepercent", "%progress", "progress%", "progresspercent", "percentprogress",
]);
const COMPLETED_QUANTITY_HEADINGS = new Set([
  "completedqty", "completedquantity", "qtycompleted", "quantitycompleted", "installedqty",
  "installedquantity", "qtyinstalled", "quantityinstalled", "completedqtytodate", "qtycompletedtodate",
  "quantitycompletedtodate", "completedquantitytodate",
]);

/** The table's typed % complete / completed quantity columns, if any.
 * A heading found twice, or a column holding text (not numbers), is
 * ambiguous and skipped. The % column keeps the file's own scale:
 * 0–1 fractions, or 0–100 when any uploaded value is above 1. */
function progressColumnsOf(
  grid: unknown[][],
  headerRowIndex: number,
  width: number
): { percent: { col: number; scale: 1 | 100 } | null; quantity: number | null } {
  const headerRow = grid[headerRowIndex] ?? [];
  const key = (h: unknown) => String(h ?? "").toLowerCase().replace(/[^a-z%]/g, "");
  const body = grid.slice(headerRowIndex + 1);
  const find = (headings: Set<string>) => {
    const cols: number[] = [];
    for (let c = 0; c < width; c++) if (headings.has(key(headerRow[c]))) cols.push(c);
    if (cols.length !== 1) return null;
    const numeric = body.every((row) => {
      const v = row?.[cols[0]];
      return v === null || v === undefined || v === "" || typeof v === "number";
    });
    return numeric ? cols[0] : null;
  };
  const percentCol = find(PERCENT_COMPLETE_HEADINGS);
  const scale = percentCol !== null && body.some((row) => typeof row?.[percentCol] === "number" && (row[percentCol] as number) > 1)
    ? 100
    : 1;
  return {
    percent: percentCol === null ? null : { col: percentCol, scale },
    quantity: find(COMPLETED_QUANTITY_HEADINGS),
  };
}

export function refillOriginalWorkbook(
  bytes: ArrayBuffer,
  scope: ExportScope,
  items: ExportWorkItem[],
  latest: Map<string, LatestValues>,
  /** Filled with the names of the sheets holding the caller's own work
   * item rows, in workbook order (the sheet a restricted download opens
   * on — see buildProjectExcelExport). */
  dataSheets?: string[],
  /** The "Latest …" columns to append, in LATEST_COLUMNS order — all of
   * them unless the caller chose fewer (see buildProjectExcelExport). */
  latestColumns: LatestColumn[] = LATEST_COLUMNS
): XLSX.WorkBook {
  const wb = XLSX.read(bytes, { type: "array", cellFormula: true, cellNF: true, cellStyles: true });
  // The importer's own row positions (sheet + 1-based row within the
  // sheet's used range) — so every row here is the row it imported.
  const parsedByPosition = new Map(
    parseProjectWorkbook(bytes).rows.map((r) => [`${r.sourceSheet}\u0000${r.sourceRow}`, r])
  );

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    // Same grid the importer read (header: 1 keeps blank rows), so grid
    // row r / column c is sheet cell (range.s.r + r, range.s.c + c).
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
    const addr = (r: number, c: number) => XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c });
    const width = range.e.c - range.s.c + 1;
    const redactRowFigures = (r: number) => {
      for (let c = 0; c < width; c++) redactFigure(ws, addr(r, c));
    };

    const layout = findSheetLayout(grid);
    if (!layout) {
      // Not a work-item table (cover page, G702 summary, notes): kept as
      // uploaded, except its figures for anyone without full access.
      if (!scope.fullAccess) grid.forEach((_, r) => redactRowFigures(r));
      continue;
    }

    const { headerRowIndex, columnField } = layout;
    const headerRow = grid[headerRowIndex] ?? [];
    const amountColumns = new Set<number>();
    for (let c = 0; c < width; c++) {
      const field = columnField.get(c);
      if (field === "scheduledValue" || (!field && isAmountHeader(headerRow[c]))) amountColumns.add(c);
    }
    if (!scope.fullAccess) {
      for (let r = 0; r < headerRowIndex; r++) redactRowFigures(r);
    }
    const progressColumns = progressColumnsOf(grid, headerRowIndex, width);
    // Those two hold physical progress (approved % / cumulative approved
    // quantity in work units — the same figures as "Latest Approved %/
    // Qty", which every role sees), not money: the broad money-heading
    // check above ("completed" …) must not blank them.
    if (progressColumns.percent) amountColumns.delete(progressColumns.percent.col);
    if (progressColumns.quantity !== null) amountColumns.delete(progressColumns.quantity);

    // Appended "Latest …" columns, right of everything already there —
    // or, when the stored original is itself a downloaded file that was
    // uploaded again, its existing "Latest …" block is refreshed in place
    // (cleared, then refilled below) instead of a second block appended.
    const existingLatestAt = headerRow.findIndex((h) => h === LATEST_COLUMNS[0].header);
    const reuseLatest =
      existingLatestAt >= 0 && LATEST_COLUMNS.every((col, i) => headerRow[existingLatestAt + i] === col.header);
    const firstNewCol = reuseLatest ? existingLatestAt : width;
    // The whole existing block (headings included) is cleared, so columns
    // the caller left out of this download don't linger from it.
    if (reuseLatest) {
      for (let r = headerRowIndex; r < grid.length; r++) {
        LATEST_COLUMNS.forEach((_, i) => delete ws[addr(r, firstNewCol + i)]);
      }
    }
    latestColumns.forEach((col, i) => {
      ws[addr(headerRowIndex, firstNewCol + i)] = { t: "s", v: col.header };
    });

    // Division sections — a DIVISION heading, the rows under it and its
    // subtotal. For a caller without full access, a section holding none
    // of their work items is another department's: its heading, subtotal
    // label and unmatched lines are emptied too (the name alone would
    // reveal it). The rows stay, so the sheet's shape is unchanged.
    const clearRow = (r: number) => {
      for (let c = 0; c < width; c++) delete ws[addr(r, c)];
    };
    // foreign: the section also holds lines that aren't the caller's;
    // allAmounts: every one of the caller's rows in it shows amounts.
    let section: { rows: number[]; inScope: boolean; foreign: boolean; allAmounts: boolean } | null = null;
    const closeSection = () => {
      if (section && !section.inScope && !scope.fullAccess) section.rows.forEach(clearRow);
      section = null;
    };

    for (let r = headerRowIndex + 1; r < grid.length; r++) {
      const row = grid[r] ?? [];
      if (row.every((cell) => cell === null || String(cell).trim() === "")) continue;
      if (isDivisionHeaderRow(row)) {
        closeSection();
        section = { rows: [r], inScope: false, foreign: false, allAmounts: true };
        continue;
      }
      if (isTotalRow(row)) {
        // The subtotal of a division that is entirely the caller's own,
        // amounts included, only adds up their own rows — kept. Every
        // other total (grand totals, mixed divisions) would reveal other
        // work, so its figures are removed.
        const ownSubtotal = !!section && section.inScope && !section.foreign && section.allAmounts;
        if (!scope.fullAccess && !ownSubtotal) redactRowFigures(r);
        if (section) {
          section.rows.push(r);
          closeSection();
        }
        continue;
      }
      const parsed = parsedByPosition.get(`${sheetName}\u0000${r + 1}`);
      const workItem = parsed ? matchWorkItem(parsed, items) : null;
      if (!workItem) {
        // A repeated header row / note line, or a row whose work item no
        // longer exists: kept for full access. Otherwise its figures are
        // removed, and the whole line goes with its section — or at once
        // when it's in no section (its department can't be known).
        if (section) section.foreign = true;
        if (!scope.fullAccess) {
          if (section) {
            redactRowFigures(r);
            section.rows.push(r);
          } else {
            clearRow(r);
          }
        }
        continue;
      }
      if (!scope.departmentIds.has(workItem.departmentId)) {
        // Another division's work item: the row stays, its data doesn't.
        if (section) section.foreign = true;
        clearRow(r);
        continue;
      }
      const amountsAllowed = scope.amountDepartmentIds.has(workItem.departmentId);
      if (section) {
        section.inScope = true;
        if (!amountsAllowed) section.allAmounts = false;
      }
      if (dataSheets && !dataSheets.includes(sheetName)) dataSheets.push(sheetName);
      // Read before formulas are stripped below: a progress cell the
      // uploaded file computes is never overwritten, for any caller.
      const isFormula = (c: number) => !!(ws[addr(r, c)] as XLSX.CellObject | undefined)?.f;
      const percentIsFormula = progressColumns.percent !== null && isFormula(progressColumns.percent.col);
      const quantityIsFormula = progressColumns.quantity !== null && isFormula(progressColumns.quantity);
      if (!amountsAllowed) {
        amountColumns.forEach((c) => delete ws[addr(r, c)]);
        // Remaining formulas (e.g. G703 "% = G / C") would recalculate
        // against the blanked amounts into #DIV/0! — keep their last
        // value as plain data instead.
        for (let c = 0; c < width; c++) {
          const cell = ws[addr(r, c)] as XLSX.CellObject | undefined;
          if (cell?.f) {
            delete cell.f;
            delete cell.F;
          }
        }
      }
      const values = latest.get(workItem.workItemId);
      if (!values) continue;
      // The original % complete / completed quantity cells now hold the
      // current approved state — only once the work item has an approved
      // update (lastApprovedAt; a quantity-tracked item with none still
      // reports 0, which is not data — the uploaded figure is the only
      // data there is) and never in a column this caller may not see.
      const approved = values.lastApprovedAt !== null;
      const visible = (c: number) => amountsAllowed || !amountColumns.has(c);
      if (progressColumns.percent && !percentIsFormula && approved && values.progress !== null && visible(progressColumns.percent.col)) {
        const { col, scale } = progressColumns.percent;
        const existing = ws[addr(r, col)] as XLSX.CellObject | undefined;
        ws[addr(r, col)] = {
          t: "n",
          v: scale === 100 ? values.progress : values.progress / 100,
          z: existing?.z ?? (scale === 1 ? "0%" : undefined),
        };
      }
      if (progressColumns.quantity !== null && !quantityIsFormula && approved && values.approvedQuantity !== null && visible(progressColumns.quantity)) {
        const existing = ws[addr(r, progressColumns.quantity)] as XLSX.CellObject | undefined;
        ws[addr(r, progressColumns.quantity)] = { t: "n", v: values.approvedQuantity, z: existing?.z };
      }
      // The whole "Latest …" block on every work item row — a value, or an
      // empty cell — so the row's own table style runs across all of it.
      latestColumns.forEach((col, i) => {
        ws[addr(r, firstNewCol + i)] = latestCell(col.key, values, amountsAllowed) ?? { t: "z" };
      });
    }
    closeSection();

    // For a caller without full access, the table rows left empty (other
    // departments' rows, headings and blank spacers) are HIDDEN, not
    // removed: their own rows sit directly under the column headings
    // instead of after a long empty band, while every row, merge, formula
    // and style stays where the original has it (unhiding shows the
    // original layout, with nothing in those rows).
    if (!scope.fullAccess) {
      const rowsMeta = [...(ws["!rows"] ?? [])];
      const lastCol = firstNewCol + latestColumns.length;
      for (let r = headerRowIndex + 1; r < grid.length; r++) {
        let empty = true;
        for (let c = 0; c < lastCol && empty; c++) {
          const cell = ws[addr(r, c)] as XLSX.CellObject | undefined;
          if (cell && (cell.f || (cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== ""))) empty = false;
        }
        if (empty) rowsMeta[range.s.r + r] = { ...(rowsMeta[range.s.r + r] ?? {}), hidden: true };
      }
      ws["!rows"] = rowsMeta;
    }

    ws["!ref"] = XLSX.utils.encode_range({
      s: range.s,
      e: { r: Math.max(range.e.r, range.s.r + grid.length - 1), c: Math.max(range.e.c, range.s.c + firstNewCol + latestColumns.length - 1) },
    });
    const cols = [...(ws["!cols"] ?? [])];
    while (cols.length < range.s.c + firstNewCol) cols.push({});
    latestColumns.forEach((col, i) => {
      cols[range.s.c + firstNewCol + i] = { wch: col.wch };
    });
    ws["!cols"] = cols;
  }
  return wb;
}

/** No original on file: the same G703 shape the importer reads —
 * DIVISION heading rows, Item No / CSI Code / Description of Work /
 * Scheduled Value / Planned Quantity / Unit, every imported extra column
 * (additional_fields), then the "Latest …" columns. In-scope departments
 * only. */
export function buildGeneratedWorkbook(
  scope: ExportScope,
  items: ExportWorkItem[],
  latest: Map<string, LatestValues>,
  /** As in refillOriginalWorkbook: the "Latest …" columns to append. */
  latestColumns: LatestColumn[] = LATEST_COLUMNS
): XLSX.WorkBook {
  const inScope = items.filter((w) => scope.departmentIds.has(w.departmentId));
  const extraHeaders = [
    ...new Set(
      inScope.flatMap((w) => Object.keys(w.additionalFields ?? {}).filter((k) => !k.startsWith("__")))
    ),
  ];
  const extraIsAmount = extraHeaders.map(isAmountHeader);
  const header = [
    "Item No",
    "CSI Code",
    "Description of Work",
    "Scheduled Value",
    "Planned Quantity",
    "Unit",
    ...extraHeaders,
    ...latestColumns.map((c) => c.header),
  ];
  const now = new Date();
  const aoa: unknown[][] = [
    [`${scope.projectName} — Work Item Progress`],
    [`Downloaded ${formatDateUS(now, "/")} ${formatTimeUS(now)}`],
    ["The original uploaded workbook is not on file for this project, so this sheet was rebuilt from the project's work items."],
    [],
    header,
  ];
  const cellOverrides: { r: number; c: number; cell: XLSX.CellObject }[] = [];

  const byDepartment = new Map<string, ExportWorkItem[]>();
  for (const w of inScope) {
    const list = byDepartment.get(w.departmentId) ?? [];
    list.push(w);
    byDepartment.set(w.departmentId, list);
  }
  for (const list of byDepartment.values()) {
    list.sort((a, b) => a.lineItemNo.localeCompare(b.lineItemNo, undefined, { numeric: true }));
    aoa.push([`DIVISION — ${list[0].departmentName}`]);
    const amountsAllowed = scope.amountDepartmentIds.has(list[0].departmentId);
    for (const w of list) {
      const r = aoa.length;
      aoa.push([
        w.lineItemNo,
        w.csiLineCode,
        w.description,
        amountsAllowed ? w.scheduledValue : null,
        w.plannedQuantity,
        w.unitOfMeasure,
        ...extraHeaders.map((h, i) => {
          if (extraIsAmount[i] && !amountsAllowed) return null;
          const v = w.additionalFields?.[h];
          return typeof v === "string" || typeof v === "number" ? v : null;
        }),
        ...latestColumns.map(() => null),
      ]);
      const values = latest.get(w.workItemId);
      if (values) {
        latestColumns.forEach((col, i) => {
          const cell = latestCell(col.key, values, amountsAllowed);
          if (cell) cellOverrides.push({ r, c: 6 + extraHeaders.length + i, cell });
        });
      }
      if (amountsAllowed && w.scheduledValue !== null) {
        cellOverrides.push({ r, c: 3, cell: { t: "n", v: w.scheduledValue, z: "$#,##0.00" } });
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (const { r, c, cell } of cellOverrides) ws[XLSX.utils.encode_cell({ r, c })] = cell;
  ws["!cols"] = [
    { wch: 10 },
    { wch: 12 },
    { wch: 44 },
    { wch: 16 },
    { wch: 14 },
    { wch: 8 },
    ...extraHeaders.map(() => ({ wch: 16 })),
    ...latestColumns.map((c) => ({ wch: c.wch })),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Work Items");
  return wb;
}

function exportFileName(projectName: string): string {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const base = projectName.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-") || "project";
  return `${base}-updated-${day}.xlsx`;
}

/**
 * Builds the updated workbook for `projectId` as `userId` may see it —
 * throws "not authorized" (route answers 403) for a Worker or anyone
 * with no non-Worker role in the project.
 */
/** Share of the project's work items an upload's rows must match to be
 * the project's working sheet (see chooseTemplate). */
const TEMPLATE_MIN_COVERAGE = 0.5;

/**
 * The stored upload that is the project's working sheet. Imports are
 * additive (each upserts its rows into the project), so the newest file
 * may only add a few items — or be a test file — rather than be the
 * project's sheet. The template is therefore the NEWEST upload whose rows
 * match at least half of the project's work items (matched exactly as
 * the import did, see matchWorkItem); with none, the newest upload. One
 * workbook only — rows from different uploads are never combined. The
 * stored file is only read, never changed.
 */
async function chooseTemplate(
  projectId: string,
  items: ExportWorkItem[]
): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  const files = await listProjectImportFiles(projectId);
  let newest: { name: string; bytes: ArrayBuffer } | null = null;
  for (const file of files) {
    const bytes = await file.read();
    if (!bytes) continue;
    newest ??= { name: file.name, bytes };
    let rows: ParsedWorkItemRow[];
    try {
      rows = parseProjectWorkbook(bytes).rows;
    } catch {
      continue;
    }
    const matched = new Set(rows.map((row) => matchWorkItem(row, items)?.workItemId).filter(Boolean));
    if (items.length > 0 && matched.size / items.length >= TEMPLATE_MIN_COVERAGE) return { name: file.name, bytes };
  }
  return newest;
}

export async function buildProjectExcelExport(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  /** Narrows the caller's scope to this one department (see
   * resolveExcelExportScope); omitted = their whole authorized scope. */
  departmentId?: string | null,
  /** Which "Latest …" columns to append after the sheet's own columns
   * (keys of LATEST_COLUMNS; unknown keys ignored, order and duplicates
   * don't matter). Omitted = all of them, as before. The sheet's own
   * columns are always included. */
  latestColumnKeys?: readonly string[] | null
): Promise<ExcelExportResult> {
  const latestColumns = latestColumnKeys
    ? LATEST_COLUMNS.filter((c) => latestColumnKeys.includes(c.key))
    : LATEST_COLUMNS;
  const scope = await resolveExcelExportScope(supabase, userId, projectId, departmentId);
  const items = await loadProjectWorkItems(supabase, projectId);
  // Figures are only ever computed for work items the caller may see.
  const latest = await loadLatestValues(
    supabase,
    items.filter((w) => scope.departmentIds.has(w.departmentId))
  );

  const original = await chooseTemplate(projectId, items);
  let wb: XLSX.WorkBook | null = null;
  const dataSheets: string[] = [];
  if (original) {
    try {
      wb = refillOriginalWorkbook(original.bytes, scope, items, latest, dataSheets, latestColumns);
    } catch (err) {
      console.error("Could not refill the stored workbook — rebuilding instead:", err);
    }
  }
  const source = wb ? "original" : "generated";
  wb ??= buildGeneratedWorkbook(scope, items, latest, latestColumns);

  // The original upload is returned as that file itself, with only the
  // changed cells patched in (formatting, comments, merges intact — see
  // lib/excelPreserve.ts); when it can't be patched safely, the values
  // are written by SheetJS as before.
  let buffer: Buffer | null = null;
  if (original && source === "original") {
    try {
      // A restricted download opens on the sheet with the caller's own
      // rows (its summary sheets have their figures removed); a full one
      // opens exactly as uploaded.
      buffer = patchOriginalWorkbook(original.bytes, wb, scope.fullAccess, scope.fullAccess ? undefined : dataSheets[0]);
    } catch (err) {
      console.error("Could not patch the stored workbook in place — writing values only:", err);
    }
  }
  buffer ??= XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return { buffer, fileName: exportFileName(scope.projectName), source };
}
