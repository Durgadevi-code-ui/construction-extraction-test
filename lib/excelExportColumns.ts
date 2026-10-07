/**
 * Headings of the columns "Download updated Excel" appends to the right
 * of the sheet's own (standard) columns — lib/excelExport.ts uses these
 * exact names, in this order. They hold figures computed from the app's
 * own approved progress, never source data, so when a downloaded file is
 * uploaded again they are not stored as work item fields (see
 * lib/excelImport.ts). Defined here, once, so the export, the importer
 * and the download dialog (ExcelDownloadButton) can't drift apart — and
 * free of server-only imports so the dialog can list them.
 */
export const EXPORT_LATEST_HEADERS = {
  progress: "Latest Approved %",
  approvedQuantity: "Latest Approved Qty",
  earned: "Latest Earned to Date",
  balance: "Latest Balance to Finish",
  status: "Latest Status",
  lastApprovedAt: "Last Approved On",
  latestUpdate: "Latest Approved Update",
  tasks: "Task Updates",
} as const;

export type ExportLatestColumnKey = keyof typeof EXPORT_LATEST_HEADERS;
