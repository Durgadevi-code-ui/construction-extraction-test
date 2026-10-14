import * as XLSX from "xlsx";

/**
 * XLSX.read with a guard against prototype pollution while parsing.
 *
 * SheetJS is installed from the official SheetJS CDN (0.20.3, see
 * package.json), not the npm registry, whose newest `xlsx` is the
 * outdated 0.18.5. 0.20.3 fixes both known advisories: prototype
 * pollution (GHSA-4r6h-8v6p-xvw6, fixed in 0.19.3) and ReDoS
 * (GHSA-5pgg-2g8v-p4x9, fixed in 0.20.2). This guard is kept as defense
 * in depth: a crafted workbook that added or overwrote properties on
 * Object.prototype / Array.prototype would, in a long-lived server, leak
 * into every later request. This snapshots both prototypes, parses, and
 * if the parse changed either one, restores them and throws — both
 * callers already treat a throw as an unreadable file
 * (lib/excelImport.ts -> 400 "Could not read this file";
 * lib/excelExport.ts -> falls back to the generated workbook). A normal
 * workbook never touches either prototype, so parsing is unchanged.
 *
 * Parser exposure is also bounded by the 10MB upload cap, the
 * decompressed-size check below (a small .xlsx can't expand into
 * gigabytes of XML for the parser), per-user rate limits on import and
 * export (lib/rateLimit.ts), and only Admins / PROJECT_MANAGEMENT
 * delegates being able to upload a workbook at all.
 */
export function readWorkbookGuarded(data: ArrayBuffer | Uint8Array, opts: XLSX.ParsingOptions): XLSX.WorkBook {
  const zipProblem = zipExpansionProblem(data instanceof Uint8Array ? data : new Uint8Array(data));
  if (zipProblem) {
    console.error("Workbook rejected before parsing:", zipProblem);
    throw new Error("This workbook could not be read safely.");
  }

  const snapshots = [Object.prototype, Array.prototype].map((proto) => ({
    proto: proto as unknown as Record<string, unknown>,
    descriptors: Object.getOwnPropertyDescriptors(proto),
  }));

  let tampered = false;
  try {
    return XLSX.read(data, opts);
  } finally {
    for (const { proto, descriptors } of snapshots) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        // Own-property check: `key in descriptors` would see a key just
        // added to Object.prototype through descriptors' own prototype.
        if (!Object.hasOwn(descriptors, key)) {
          tampered = true;
          delete proto[key];
        }
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        const now = Object.getOwnPropertyDescriptor(proto, key);
        if (!now || now.value !== descriptor.value || now.get !== descriptor.get || now.set !== descriptor.set) {
          tampered = true;
          Object.defineProperty(proto, key, descriptor);
        }
      }
    }
    if (tampered) {
      // Deliberately replaces the parse result.
      throw new Error("This workbook could not be read safely.");
    }
  }
}

/** Total decompressed size an .xlsx (ZIP) may declare. Real project
 * workbooks under the 10MB upload cap expand to a few tens of MB of XML;
 * this leaves ample headroom while stopping a "ZIP bomb". */
export const MAX_WORKBOOK_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
export const MAX_WORKBOOK_ZIP_ENTRIES = 10_000;

/**
 * For a ZIP (.xlsx) workbook, reads the central directory — sizes as
 * declared, nothing is inflated — and returns why it must not be parsed
 * (too large when expanded, too many entries, ZIP64, or a structure no
 * real workbook has), or null when it is fine. Anything that isn't a ZIP
 * (.xls OLE2 files, CSV, HTML/XML exports) is not compressed, so its size
 * is already bounded by the upload cap and null is returned.
 */
export function zipExpansionProblem(bytes: Uint8Array): string | null {
  const u32 = (o: number) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  const u16 = (o: number) => bytes[o] | (bytes[o + 1] << 8);
  if (bytes.length < 4 || u32(0) !== 0x04034b50) return null; // not a ZIP

  // End-of-central-directory record: within the last 22 + 65535 bytes.
  let eocd = -1;
  for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 22 - 0xffff); o--) {
    if (u32(o) === 0x06054b50) {
      eocd = o;
      break;
    }
  }
  if (eocd < 0) return "no end-of-central-directory record";

  const entries = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return "ZIP64 archive";
  if (entries > MAX_WORKBOOK_ZIP_ENTRIES) return `${entries} entries`;
  if (cdOffset + cdSize > eocd) return "central directory out of range";

  let total = 0;
  let o = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (o + 46 > eocd || u32(o) !== 0x02014b50) return "malformed central directory";
    const uncompressed = u32(o + 24);
    if (uncompressed === 0xffffffff) return "ZIP64 entry";
    total += uncompressed;
    if (total > MAX_WORKBOOK_UNCOMPRESSED_BYTES) return `expands to more than ${MAX_WORKBOOK_UNCOMPRESSED_BYTES} bytes`;
    o += 46 + u16(o + 28) + u16(o + 30) + u16(o + 32);
  }
  return null;
}
