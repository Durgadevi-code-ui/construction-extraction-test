/**
 * Checks an upload's actual leading bytes, not just the browser-supplied
 * MIME type (which the client fully controls). Each check accepts every
 * format the existing upload flows legitimately send:
 *   - images: PNG, JPEG, WebP, HEIC/HEIF — the routes' existing allowlist
 *     (the in-app camera always produces JPEG);
 *   - audio: any common container. The recorder (components/VoiceUpload.tsx)
 *     labels every recording "audio/webm" whatever the browser actually
 *     produced (Safari/iOS records MP4), and the file picker accepts any
 *     audio/*, so the content is checked against the whole audio family,
 *     never against the declared type;
 *   - workbooks: .xlsx (ZIP), .xls (OLE2) or text (.csv, and the
 *     HTML/XML ".xls" files other software exports, which the importer
 *     can also read).
 * They only reject content that is clearly not of that family.
 */

type Bytes = Uint8Array;

function ascii(bytes: Bytes, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function startsWith(bytes: Bytes, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

/** ISO-BMFF ("ftyp") major brand, e.g. "heic", "M4A ", "isom" — or null. */
function ftypBrand(bytes: Bytes): string | null {
  return ascii(bytes, 4, 4) === "ftyp" ? ascii(bytes, 8, 4) : null;
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "mif2"]);

export type ImageKind = "png" | "jpeg" | "webp" | "heic";

/** The image format these bytes actually are (of the formats the app
 * accepts), or null. */
export function detectImageKind(bytes: Bytes): ImageKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  const brand = ftypBrand(bytes);
  if (brand && HEIF_BRANDS.has(brand)) return "heic";
  return null;
}

/** Whether these bytes start like a known audio (or audio-in-video)
 * container. */
export function looksLikeAudio(bytes: Bytes): boolean {
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return true; // WebM / Matroska
  if (ascii(bytes, 0, 4) === "OggS") return true; // Ogg (Opus/Vorbis)
  if (ftypBrand(bytes) !== null) return true; // MP4 / M4A / 3GP / MOV
  if (["moov", "mdat", "free", "wide", "skip"].includes(ascii(bytes, 4, 4))) return true; // QuickTime w/o ftyp
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return true; // WAV
  if (ascii(bytes, 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(bytes, 8, 4))) return true; // AIFF
  if (ascii(bytes, 0, 4) === "fLaC") return true; // FLAC
  if (ascii(bytes, 0, 3) === "ID3") return true; // MP3 with ID3 tag
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true; // MP3 / AAC (ADTS) frame
  if (ascii(bytes, 0, 5) === "#!AMR") return true; // AMR
  if (ascii(bytes, 0, 4) === "caff") return true; // Core Audio
  if (startsWith(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return true; // ASF / WMA
  return false;
}

const WORKBOOK_EXTENSIONS = [".xlsx", ".xls", ".csv"];

/** Whether `fileName` has one of the extensions the import picker offers
 * (components/admin/ExcelImportPanel.tsx: ".xlsx,.xls,.csv"). */
export function hasWorkbookExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return WORKBOOK_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Whether these bytes are a ZIP (.xlsx), an OLE2 compound file (.xls),
 * or text (CSV / HTML / XML spreadsheet) — i.e. not some other binary. */
export function looksLikeWorkbook(bytes: Bytes): boolean {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return true; // ZIP (OOXML)
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return true; // OLE2
  const head = bytes.subarray(0, 8192);
  if (head.length === 0) return false;
  // Text: no NUL bytes (allowing a UTF-16 BOM'd CSV, which has many).
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true;
  return !head.includes(0);
}
