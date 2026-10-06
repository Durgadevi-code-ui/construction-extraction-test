import "server-only";
import * as XLSX from "xlsx";

/**
 * Writes the "Download updated Excel" result back INTO the original
 * uploaded .xlsx, instead of re-serializing it with SheetJS (whose free
 * edition writes values only — every font, fill, border and comment of
 * the uploaded workbook would be lost).
 *
 * lib/excelExport.ts refillOriginalWorkbook still makes every decision
 * (scope, blanking, "Latest …" columns) on a SheetJS copy; this module
 * only compares that result with the untouched original, cell by cell,
 * and patches exactly the cells that differ into the original sheet XML:
 *   - a removed cell is emptied in place (its own style kept, so the
 *     table's look is unchanged; the value is gone);
 *   - a changed/new cell gets the new value — keeping its own style, or,
 *     for an appended cell, the style of the row's last original cell
 *     with only the number format set (%, $, General);
 *   - a removed formula keeps its last value as plain data.
 * Everything else — sheets, order, merges, widths, formulas, comments,
 * print setup, theme — is the uploaded file byte for byte.
 *
 * For a caller without full access, content that would still carry
 * blanked data is removed too: shared strings no longer used by any cell
 * are emptied, and comments on blanked/unknown cells are dropped. A file
 * with parts holding their own copies of cell data (charts, pivot
 * caches, external links, embedded objects) can't be cleaned that way,
 * so for such a caller this returns null and the export falls back to
 * the plain values-only workbook.
 *
 * Returns null whenever the file isn't an .xlsx this can safely patch;
 * the caller then writes the SheetJS workbook as before.
 */

type Zip = ReturnType<typeof XLSX.CFB.read>;
type RawCell = { attrs: string; inner: string | null };
type RawRow = { attrs: string; cells: Map<number, RawCell> };

const DATA_COPY_PARTS = /^xl\/(charts|pivotCache|pivotTables|externalLinks|embeddings|queryTables)\/|^xl\/connections\.xml$|^customXml\//;

function zipPaths(zip: Zip): string[] {
  return zip.FullPaths.map((p: string) => p.replace(/^[^/]*\//, ""));
}

function zipIndex(zip: Zip, path: string): number {
  return zipPaths(zip).findIndex((p) => p === path);
}

function readText(zip: Zip, path: string): string | null {
  const i = zipIndex(zip, path);
  if (i < 0) return null;
  return Buffer.from(zip.FileIndex[i].content as Uint8Array).toString("utf8");
}

function writeText(zip: Zip, path: string, text: string) {
  const i = zipIndex(zip, path);
  if (i < 0) throw new Error(`${path} not in workbook`);
  const content = Buffer.from(text, "utf8");
  zip.FileIndex[i].content = content;
  zip.FileIndex[i].size = content.length;
}

function removePart(zip: Zip, path: string) {
  const i = zipIndex(zip, path);
  if (i < 0) return;
  zip.FileIndex.splice(i, 1);
  zip.FullPaths.splice(i, 1);
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const attr = (attrs: string, name: string) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];

/** Resolves a relationship target (relative to `baseDir`) to a zip path. */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${baseDir}/${target}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

function relationships(zip: Zip, relsPath: string, baseDir: string) {
  const xml = readText(zip, relsPath) ?? "";
  return [...xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)].map((m) => ({
    id: attr(m[1], "Id") ?? "",
    type: attr(m[1], "Type") ?? "",
    target: resolveTarget(baseDir, unescapeXml(attr(m[1], "Target") ?? "")),
  }));
}

/** Sheet name -> worksheet XML path, from workbook.xml + its rels. */
function sheetPaths(zip: Zip): Map<string, string> {
  const workbook = readText(zip, "xl/workbook.xml") ?? "";
  const rels = relationships(zip, "xl/_rels/workbook.xml.rels", "xl");
  const out = new Map<string, string>();
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = attr(m[1], "name");
    const rid = m[1].match(/\s[\w]+:id="([^"]*)"/)?.[1];
    const rel = rels.find((r) => r.id === rid);
    if (name && rel && /\/worksheet$/.test(rel.type)) out.set(unescapeXml(name), rel.target);
  }
  return out;
}

/** cellXfs editing: a copy of an existing style with another number
 * format — the only style change this module ever makes. */
function styleEditor(stylesXml: string) {
  let xml = stylesXml;
  const xfBlock = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!xfBlock) throw new Error("styles.xml has no cellXfs");
  const xfs = xfBlock[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) ?? [];
  const added: string[] = [];
  const builtIn: Record<string, number> = { General: 0, "0": 1, "0.00": 2, "0%": 9, "0.00%": 10 };
  const customFormats = new Map<string, number>();
  for (const m of xml.matchAll(/<numFmt\b([^>]*?)\/>/g)) {
    const id = Number(attr(m[1], "numFmtId"));
    const code = attr(m[1], "formatCode");
    if (code !== undefined && Number.isFinite(id)) customFormats.set(unescapeXml(code), id);
  }
  const newFormats: string[] = [];
  let nextFormatId = Math.max(163, ...customFormats.values()) + 1;
  const memo = new Map<string, number>();

  function formatId(code: string): number {
    if (code in builtIn) return builtIn[code];
    const known = customFormats.get(code);
    if (known !== undefined) return known;
    const id = nextFormatId++;
    customFormats.set(code, id);
    newFormats.push(`<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`);
    return id;
  }

  function withFormat(styleIndex: number, code: string | undefined): number {
    if (code === undefined) return styleIndex;
    const base = xfs[styleIndex] ?? xfs[0] ?? `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`;
    const id = formatId(code);
    if (Number(base.match(/numFmtId="(\d+)"/)?.[1] ?? 0) === id) return styleIndex;
    const key = `${styleIndex}:${id}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let copy = /numFmtId="\d+"/.test(base) ? base.replace(/numFmtId="\d+"/, `numFmtId="${id}"`) : base.replace(/^<xf\b/, `<xf numFmtId="${id}"`);
    copy = /applyNumberFormat="[^"]*"/.test(copy)
      ? copy.replace(/applyNumberFormat="[^"]*"/, 'applyNumberFormat="1"')
      : copy.replace(/^<xf\b/, '<xf applyNumberFormat="1"');
    added.push(copy);
    const index = xfs.length + added.length - 1;
    memo.set(key, index);
    return index;
  }

  function finish(): string {
    if (added.length > 0) {
      xml = xml.replace(
        /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/,
        (_m, inner: string) => `<cellXfs count="${xfs.length + added.length}">${inner}${added.join("")}</cellXfs>`
      );
    }
    if (newFormats.length > 0) {
      if (/<numFmts\b[^>]*>[\s\S]*?<\/numFmts>/.test(xml)) {
        xml = xml.replace(/<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/, (_m, inner: string) => {
          const all = `${inner}${newFormats.join("")}`;
          return `<numFmts count="${(all.match(/<numFmt\b/g) ?? []).length}">${all}</numFmts>`;
        });
      } else {
        xml = xml.replace(/(<styleSheet\b[^>]*>)/, `$1<numFmts count="${newFormats.length}">${newFormats.join("")}</numFmts>`);
      }
    }
    return xml;
  }

  return { withFormat, finish, changed: () => added.length > 0 || newFormats.length > 0 };
}

function parseSheetData(sheetXml: string): Map<number, RawRow> | null {
  const block = sheetXml.match(/<sheetData\s*\/>|<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/);
  if (!block) return null;
  const rows = new Map<number, RawRow>();
  for (const rm of (block[1] ?? "").matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(rm[1], "r"));
    if (!Number.isInteger(r) || r < 1) return null; // implicit row numbers: not patchable safely
    const cells = new Map<number, RawCell>();
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], "r");
      if (!ref) return null;
      cells.set(XLSX.utils.decode_cell(ref).c, { attrs: cm[1], inner: cm[2] ?? null });
    }
    rows.set(r - 1, { attrs: rm[1], cells });
  }
  return rows;
}

function sameCell(a: XLSX.CellObject | undefined, b: XLSX.CellObject | undefined): boolean {
  if (!a || !b) return a === b;
  return a.t === b.t && a.v === b.v && (a.f ?? null) === (b.f ?? null);
}

/** The new value of a changed cell, as sheet XML (no formula unless the
 * edited cell kept one). */
function cellXml(ref: string, style: number, cell: XLSX.CellObject): string {
  const s = style > 0 ? ` s="${style}"` : "";
  const f = cell.f ? `<f>${escapeXml(cell.f)}</f>` : "";
  switch (cell.t) {
    case "n":
      return typeof cell.v === "number" && Number.isFinite(cell.v) ? `<c r="${ref}"${s}>${f}<v>${cell.v}</v></c>` : `<c r="${ref}"${s}/>`;
    case "b":
      return `<c r="${ref}"${s} t="b">${f}<v>${cell.v ? 1 : 0}</v></c>`;
    case "s":
      if (f) return `<c r="${ref}"${s} t="str">${f}<v>${escapeXml(String(cell.v ?? ""))}</v></c>`;
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell.v ?? ""))}</t></is></c>`;
    case "d":
      return `<c r="${ref}"${s} t="inlineStr"><is><t>${escapeXml(String(cell.v ?? ""))}</t></is></c>`;
    default:
      return `<c r="${ref}"${s}/>`;
  }
}

type SheetResult = { xml: string; removedFormula: boolean; changedRefs: Set<string> };

function patchSheet(
  sheetXml: string,
  before: XLSX.WorkSheet,
  after: XLSX.WorkSheet,
  styles: ReturnType<typeof styleEditor>
): SheetResult | null {
  const rows = parseSheetData(sheetXml);
  if (!rows) return null;
  const refs = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => !k.startsWith("!")));
  const changedRefs = new Set<string>();
  let removedFormula = false;
  const sharedFormulaMaster = /<f\b[^>]*\bt="shared"[^>]*\bref="/;

  // Style of the row's last ORIGINAL cell left of an appended cell — read
  // from the uploaded row only (never from cells added below), so every
  // appended cell in a row carries the same table style.
  const originalRows = new Map([...rows].map(([r, row]) => [r, new Map(row.cells)]));
  const lastStyle = (r: number, beforeCol: number) => {
    let best = -1;
    let style = 0;
    for (const [c, cell] of originalRows.get(r) ?? []) {
      if (c < beforeCol && c > best) {
        best = c;
        style = Number(attr(cell.attrs, "s") ?? 0);
      }
    }
    return style;
  };

  for (const ref of refs) {
    const was = before[ref] as XLSX.CellObject | undefined;
    const now = after[ref] as XLSX.CellObject | undefined;
    if (sameCell(was, now)) continue;
    changedRefs.add(ref);
    const { r, c } = XLSX.utils.decode_cell(ref);
    let row = rows.get(r);
    if (!row) {
      row = { attrs: ` r="${r + 1}"`, cells: new Map() };
      rows.set(r, row);
    }
    const existing = row.cells.get(c);
    if (existing?.inner && /<f\b/.test(existing.inner) && !now?.f) removedFormula = true;
    if (existing?.inner && sharedFormulaMaster.test(existing.inner)) removedFormula = true;
    const ownStyle = existing ? Number(attr(existing.attrs, "s") ?? 0) : null;
    if (!now || now.t === "z") {
      // Emptied cell: keeps its own style. A new empty cell (part of an
      // appended block) takes the row's table style, without a value.
      const style = ownStyle ?? (now ? lastStyle(r, c) : 0);
      row.cells.set(c, { attrs: ` r="${ref}"${style ? ` s="${style}"` : ""}`, inner: null });
      continue;
    }
    const style =
      ownStyle !== null
        ? styles.withFormat(ownStyle, typeof now.z === "string" ? now.z : undefined)
        : styles.withFormat(lastStyle(r, c), typeof now.z === "string" ? now.z : "General");
    const xml = cellXml(ref, style, now);
    const m = xml.match(/^<c\b([^>]*?)(?:\/>|>([\s\S]*)<\/c>)$/)!;
    row.cells.set(c, { attrs: m[1], inner: m[2] ?? null });
    // Row span hints no longer cover an appended cell — drop them.
    row.attrs = row.attrs.replace(/\sspans="[^"]*"/, "");
  }
  // Rows the export hid (a restricted caller's emptied rows) — only the
  // row's hidden flag is added; nothing else about the row changes.
  let hidRows = false;
  (after["!rows"] ?? []).forEach((info, r) => {
    if (!info?.hidden) return;
    const row = rows.get(r) ?? { attrs: ` r="${r + 1}"`, cells: new Map<number, RawCell>() };
    if (/\shidden="(1|true)"/.test(row.attrs)) return;
    row.attrs = `${row.attrs.replace(/\shidden="[^"]*"/, "")} hidden="1"`;
    rows.set(r, row);
    hidRows = true;
  });
  if (changedRefs.size === 0 && !hidRows) return { xml: sheetXml, removedFormula, changedRefs };

  // A shared formula's dependents only hold a reference to their master;
  // once any formula here changed, every shared formula in the sheet is
  // written out in full (SheetJS already expanded each cell's own text).
  if (removedFormula) {
    for (const [r, row] of rows) {
      for (const [c, cell] of row.cells) {
        if (!cell.inner || !/<f\b[^>]*\bt="shared"/.test(cell.inner)) continue;
        const ref = XLSX.utils.encode_cell({ r, c });
        const formula = (after[ref] as XLSX.CellObject | undefined)?.f;
        cell.inner = formula
          ? cell.inner.replace(/<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/, `<f>${escapeXml(formula)}</f>`)
          : cell.inner.replace(/<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/, "");
      }
    }
  }

  const body = [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => {
      const cells = [...row.cells.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, cell]) => (cell.inner === null ? `<c${cell.attrs}/>` : `<c${cell.attrs}>${cell.inner}</c>`))
        .join("");
      return cells ? `<row${row.attrs}>${cells}</row>` : `<row${row.attrs}/>`;
    })
    .join("");
  let xml = sheetXml.replace(/<sheetData\s*\/>|<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/, `<sheetData>${body}</sheetData>`);

  if (after["!ref"]) {
    xml = /<dimension\b[^>]*\/>/.test(xml)
      ? xml.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${after["!ref"]}"/>`)
      : xml;
  }

  // Widths for appended columns only; the file's own <col> entries stay.
  const existingCols = [...(xml.match(/<cols>([\s\S]*?)<\/cols>/)?.[1] ?? "").matchAll(/<col\b([^>]*?)\/>/g)].map((m) => ({
    raw: m[0],
    min: Number(attr(m[1], "min")),
    max: Number(attr(m[1], "max")),
  }));
  const covered = (c: number) => existingCols.some((col) => c + 1 >= col.min && c + 1 <= col.max);
  const extra: { raw: string; min: number }[] = [];
  (after["!cols"] ?? []).forEach((col, c) => {
    if (!col?.wch || covered(c)) return;
    if (!Object.keys(after).some((k) => !k.startsWith("!") && XLSX.utils.decode_cell(k).c === c && !before[k])) return;
    extra.push({ raw: `<col min="${c + 1}" max="${c + 1}" width="${(col.wch + 0.71).toFixed(2)}" customWidth="1"/>`, min: c + 1 });
  });
  if (extra.length > 0) {
    const all = [...existingCols.map((col) => ({ raw: col.raw, min: col.min })), ...extra].sort((a, b) => a.min - b.min);
    const colsXml = `<cols>${all.map((col) => col.raw).join("")}</cols>`;
    xml = /<cols>[\s\S]*?<\/cols>/.test(xml) ? xml.replace(/<cols>[\s\S]*?<\/cols>/, colsXml) : xml.replace(/<sheetData>/, `${colsXml}<sheetData>`);
  }
  return { xml, removedFormula, changedRefs };
}

/** Comments (and their note shapes) on cells that were changed to blank
 * or were never a known value — dropped for a restricted caller. */
function cleanComments(zip: Zip, sheetPath: string, keep: (ref: string) => boolean) {
  const dir = sheetPath.slice(0, sheetPath.lastIndexOf("/"));
  const relsPath = `${dir}/_rels/${sheetPath.slice(dir.length + 1)}.rels`;
  const rels = relationships(zip, relsPath, dir);
  const removed: { r: number; c: number }[] = [];
  for (const rel of rels.filter((x) => /\/comments$/.test(x.type))) {
    const xml = readText(zip, rel.target);
    if (!xml) continue;
    const next = xml.replace(/<comment\b([^>]*?)(?:\/>|>[\s\S]*?<\/comment>)/g, (whole, attrs: string) => {
      const ref = attr(attrs, "ref") ?? "";
      if (keep(ref)) return whole;
      removed.push(XLSX.utils.decode_cell(ref));
      return "";
    });
    if (next !== xml) writeText(zip, rel.target, next);
  }
  if (removed.length === 0) return;
  for (const rel of rels.filter((x) => /\/vmlDrawing$/.test(x.type))) {
    const xml = readText(zip, rel.target);
    if (!xml) continue;
    const next = xml.replace(/<v:shape\b[\s\S]*?<\/v:shape>/g, (shape) => {
      const r = Number(shape.match(/<x:Row>(\d+)<\/x:Row>/)?.[1]);
      const c = Number(shape.match(/<x:Column>(\d+)<\/x:Column>/)?.[1]);
      return removed.some((p) => p.r === r && p.c === c) ? "" : shape;
    });
    if (next !== xml) writeText(zip, rel.target, next);
  }
}

/** Empties shared strings no cell uses any more (indexes stay stable). */
function cleanSharedStrings(zip: Zip, worksheetXml: string[]) {
  const rels = relationships(zip, "xl/_rels/workbook.xml.rels", "xl");
  const sstPath = rels.find((r) => /\/sharedStrings$/.test(r.type))?.target;
  const sst = sstPath ? readText(zip, sstPath) : null;
  if (!sstPath || !sst) return;
  const used = new Set<number>();
  for (const xml of worksheetXml) {
    for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (!m[2] || attr(m[1], "t") !== "s") continue;
      const v = Number(m[2].match(/<v>(\d+)<\/v>/)?.[1]);
      if (Number.isInteger(v)) used.add(v);
    }
  }
  let i = -1;
  const next = sst.replace(/<si\b[^>]*?(?:\/>|>[\s\S]*?<\/si>)/g, (si) => {
    i++;
    return used.has(i) ? si : "<si><t></t></si>";
  });
  if (next !== sst) writeText(zip, sstPath, next);
}

/** Makes `name` the tab the workbook opens on: workbook.xml's activeTab
 * (its position among the workbook's sheets) and the tabSelected flag of
 * each worksheet's view. Nothing else about any sheet changes. */
function openOnSheet(zip: Zip, sheets: Map<string, string>, name: string) {
  const workbook = readText(zip, "xl/workbook.xml");
  if (!workbook) return;
  const names = [...workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m) => unescapeXml(attr(m[1], "name") ?? ""));
  const index = names.indexOf(name);
  if (index < 0) return;
  writeText(
    zip,
    "xl/workbook.xml",
    workbook.replace(/<workbookView\b([^>]*?)(\/?)>/, (_m, attrs: string, close: string) => {
      const rest = attrs.replace(/\sactiveTab="[^"]*"/, "");
      return `<workbookView${rest} activeTab="${index}"${close}>`;
    })
  );
  for (const [sheetName, path] of sheets) {
    const xml = readText(zip, path);
    if (!xml) continue;
    const selected = sheetName === name ? "1" : "0";
    const next = xml.replace(/<sheetView\b([^>]*?)(\/?)>/, (_m, attrs: string, close: string) => {
      const rest = attrs.replace(/\stabSelected="[^"]*"/, "");
      return `<sheetView${rest} tabSelected="${selected}"${close}>`;
    });
    if (next !== xml) writeText(zip, path, next);
  }
}

function dropCalcChain(zip: Zip) {
  const rels = readText(zip, "xl/_rels/workbook.xml.rels");
  if (rels) writeText(zip, "xl/_rels/workbook.xml.rels", rels.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/g, ""));
  const types = readText(zip, "[Content_Types].xml");
  if (types) writeText(zip, "[Content_Types].xml", types.replace(/<Override\b[^>]*calcChain[^>]*\/>/g, ""));
  removePart(zip, "xl/calcChain.xml");
}

/**
 * The original upload with `edited`'s values patched in, or null when it
 * can't be done safely (not an .xlsx, an unusual sheet layout, or — for
 * a caller without full access — parts holding copies of cell data).
 */
export function patchOriginalWorkbook(
  originalBytes: ArrayBuffer,
  edited: XLSX.WorkBook,
  fullAccess: boolean,
  /** Sheet the workbook should open on (only the selected tab changes;
   * sheet order is untouched). Omitted: opens as uploaded. */
  activeSheet?: string
): Buffer | null {
  let zip: Zip;
  try {
    zip = XLSX.CFB.read(Buffer.from(originalBytes), { type: "buffer" });
  } catch {
    return null;
  }
  const paths = zipPaths(zip);
  if (!paths.includes("xl/workbook.xml") || !paths.includes("xl/styles.xml")) return null;
  if (!fullAccess && paths.some((p) => DATA_COPY_PARTS.test(p))) return null;

  const before = XLSX.read(originalBytes, { type: "array", cellFormula: true, cellNF: true, cellStyles: true });
  const sheets = sheetPaths(zip);
  const styles = styleEditor(readText(zip, "xl/styles.xml")!);
  let removedFormula = false;
  const finalSheets: string[] = [];

  for (const name of edited.SheetNames) {
    const path = sheets.get(name);
    const beforeWs = before.Sheets[name];
    const afterWs = edited.Sheets[name];
    if (!path || !beforeWs || !afterWs) {
      if (afterWs && Object.keys(afterWs).some((k) => !k.startsWith("!"))) return null;
      continue;
    }
    const xml = readText(zip, path);
    if (!xml) return null;
    const result = patchSheet(xml, beforeWs, afterWs, styles);
    if (!result) return null;
    removedFormula ||= result.removedFormula;
    if (result.xml !== xml) writeText(zip, path, result.xml);
    finalSheets.push(result.xml);
    if (!fullAccess) {
      cleanComments(zip, path, (ref) => !!beforeWs[ref] && !result.changedRefs.has(ref));
    }
  }
  // Worksheets the edited workbook didn't list still count as string users.
  for (const [name, path] of sheets) {
    if (!edited.SheetNames.includes(name)) finalSheets.push(readText(zip, path) ?? "");
  }

  if (styles.changed()) writeText(zip, "xl/styles.xml", styles.finish());
  if (removedFormula) dropCalcChain(zip);
  if (activeSheet && sheets.has(activeSheet)) openOnSheet(zip, sheets, activeSheet);
  if (!fullAccess) cleanSharedStrings(zip, finalSheets);

  return XLSX.CFB.write(zip, { type: "buffer", fileType: "zip", compression: true }) as Buffer;
}
