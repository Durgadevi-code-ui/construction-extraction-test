/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: run by `node --test` through tests/register-ts.cjs, which loads CommonJS packages such as xlsx. */
// Security validation helpers — input limits, upload signatures, safe
// redirects, API error messages and the guarded workbook reader.
// Run with `npm test`.
const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");

const { tooLongError, MAX_DESCRIPTION_LENGTH, MAX_COMMENT_LENGTH, MAX_CAPTION_LENGTH } = require("../lib/inputLimits.ts");
const { detectImageKind, looksLikeAudio, looksLikeWorkbook, hasWorkbookExtension, storageExtension } = require("../lib/fileSignature.ts");
const { safeNextPath } = require("../lib/safeRedirect.ts");
const { publicErrorMessage, jsonError } = require("../lib/apiErrors.ts");

const bytes = (...parts) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : p)));

// ---------------------------------------------------------------- limits
test("input limits: exactly the maximum is accepted, one more is rejected", () => {
  for (const [max, label] of [
    [MAX_DESCRIPTION_LENGTH, "Description"],
    [MAX_COMMENT_LENGTH, "Comment"],
    [MAX_CAPTION_LENGTH, "Caption"],
  ]) {
    assert.equal(tooLongError("x".repeat(max), max, label), null);
    assert.match(tooLongError("x".repeat(max + 1), max, label), new RegExp(`^${label} is too long \\(max [\\d,]+ characters\\)\\.$`));
  }
});

test("input limits: non-strings and short text are left to the route's own checks", () => {
  assert.equal(tooLongError(undefined, 10, "X"), null);
  assert.equal(tooLongError(null, 10, "X"), null);
  assert.equal(tooLongError(12345678901, 10, "X"), null);
  assert.equal(tooLongError("Poured 20 m3 of concrete on level 2", MAX_DESCRIPTION_LENGTH, "Description"), null);
});

test("input limits are generous enough for a long voice transcript", () => {
  // ~1 hour of speech at ~150 words/min, ~5.5 chars/word.
  assert.ok(MAX_DESCRIPTION_LENGTH >= 60 * 150 * 5.5);
});

// ---------------------------------------------------------------- images
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13]);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], "JFIF");
const WEBP = bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ");
const HEIC = bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0], "mif1heic");
const HTML = bytes("<!doctype html><script>alert(1)</script>");
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PDF = bytes("%PDF-1.7\n");
const EXE = bytes("MZ", [0x90, 0, 3, 0]);

test("images: every format the app accepts is recognised", () => {
  assert.equal(detectImageKind(PNG), "png");
  assert.equal(detectImageKind(JPEG), "jpeg");
  assert.equal(detectImageKind(WEBP), "webp");
  assert.equal(detectImageKind(HEIC), "heic");
});

test("images: non-image content is rejected whatever its declared type", () => {
  for (const b of [HTML, SVG, PDF, EXE, bytes(""), bytes([0xff])]) assert.equal(detectImageKind(b), null);
  // An MP4/AVIF container is not one of the accepted image formats.
  assert.equal(detectImageKind(bytes([0, 0, 0, 0x18], "ftypavif")), null);
});

// ---------------------------------------------------------------- audio
function wav() {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36, 4);
  b.write("WAVEfmt ", 8);
  return new Uint8Array(b);
}

test("audio: browser recordings and common audio files are recognised", () => {
  const samples = {
    "WebM (Chrome/Firefox recorder)": bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]),
    "MP4 (Safari/iOS recorder, labelled audio/webm by the app)": bytes([0, 0, 0, 0x1c], "ftypiso5"),
    "M4A": bytes([0, 0, 0, 0x20], "ftypM4A "),
    "3GP": bytes([0, 0, 0, 0x14], "ftyp3gp4"),
    "Ogg/Opus": bytes("OggS", [0, 2]),
    "WAV": wav(),
    "MP3 with ID3": bytes("ID3", [4, 0, 0]),
    "MP3 frame": bytes([0xff, 0xfb, 0x90, 0x64]),
    "AAC ADTS": bytes([0xff, 0xf1, 0x50, 0x80]),
    "FLAC": bytes("fLaC"),
    "AIFF": bytes("FORM", [0, 0, 0, 0], "AIFF"),
    "AMR": bytes("#!AMR\n"),
    "CAF": bytes("caff"),
    "WMA/ASF": bytes([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]),
  };
  for (const [name, b] of Object.entries(samples)) assert.ok(looksLikeAudio(b), name);
});

test("audio: non-audio content is rejected", () => {
  for (const b of [HTML, SVG, PDF, EXE, PNG, JPEG, bytes(""), bytes("hello world")]) assert.equal(looksLikeAudio(b), false);
});

// ---------------------------------------------------------------- workbooks
function realXlsx() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Item", "Qty"], ["Slab", 20]]), "Work Items");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
function realXls() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Item"], ["Slab"]]), "Sheet1");
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "biff8" }));
}

test("workbooks: .xlsx, .xls, CSV and HTML/XML spreadsheets are accepted", () => {
  assert.ok(looksLikeWorkbook(realXlsx()), "xlsx");
  assert.ok(looksLikeWorkbook(realXls()), "xls");
  assert.ok(looksLikeWorkbook(bytes("Item No,Description,Scheduled Value\n1,Slab,1000\n")), "csv");
  assert.ok(looksLikeWorkbook(bytes([0xff, 0xfe], "I\0t\0e\0m\0")), "UTF-16 csv");
  assert.ok(looksLikeWorkbook(bytes("<html><table><tr><td>1</td></tr></table></html>")), "html .xls");
});

test("workbooks: other binary files are rejected", () => {
  for (const b of [PNG, JPEG, EXE, bytes("")]) assert.equal(looksLikeWorkbook(b), false);
});

test("workbooks: extension must match the picker (.xlsx/.xls/.csv)", () => {
  for (const n of ["G703.xlsx", "old.XLS", "items.csv"]) assert.ok(hasWorkbookExtension(n), n);
  for (const n of ["evil.exe", "photo.png", "book.xlsx.exe", "noext"]) assert.equal(hasWorkbookExtension(n), false, n);
});

// ---------------------------------------------------------------- redirects
test("safeNextPath: off-site destinations fall back", () => {
  for (const v of ["//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "@evil.example",
    ".evil.example", "https://evil.example", "javascript:alert(1)", "", null, undefined, "evil.example/x"]) {
    assert.equal(safeNextPath(v, "/fallback"), "/fallback", JSON.stringify(v));
  }
});

test("safeNextPath: in-app paths are kept", () => {
  for (const v of ["/workflow", "/workflow/worker?tab=history", "/auth/update-password", "/account#x", "/admin/setup"]) {
    assert.equal(safeNextPath(v, "/fallback"), v);
  }
});

// ---------------------------------------------------------------- errors
test("publicErrorMessage: 4xx messages are returned unchanged", () => {
  for (const [m, s] of [
    ["Not authenticated.", 401],
    ["FOREMAN 1234 is not authorized to configure tasks", 403],
    ["Description is too long (max 50,000 characters).", 400],
    ["Failed to load X: should stay for a 4xx", 400],
  ]) assert.equal(publicErrorMessage(m, s), m);
});

test("publicErrorMessage: 5xx database detail is withheld, matching what the UI already showed", () => {
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(
      publicErrorMessage('Failed to submit progress: duplicate key value violates unique constraint "x"', 500),
      "Failed to submit progress. Please try again."
    );
    assert.equal(publicErrorMessage("Submission not found: JSON object requested, multiple (or no) rows returned", 500), "Submission not found.");
    // Storage / insert failures in /api/text|voice|handwritten and live-updates.
    assert.equal(publicErrorMessage("Failed to upload the file: Bucket not found", 500), "Failed to upload the file. Please try again.");
    assert.equal(publicErrorMessage('Failed to save submission: new row violates row-level security policy for table "extraction_submissions"', 500),
      "Failed to save submission. Please try again.");
    assert.equal(publicErrorMessage("Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY", 500),
      "Something went wrong on the server. Please try again.");
    assert.equal(publicErrorMessage("TypeError: fetch failed", 500), "Something went wrong on the server. Please try again.");
    // Plain business messages are unchanged.
    assert.equal(publicErrorMessage("This work item is inactive — activate it before assigning workers.", 500),
      "This work item is inactive — activate it before assigning workers.");
  } finally {
    console.error = original;
  }
});

// ---------------------------------------------------------------- xlsx guard
test("readWorkbookGuarded: a normal workbook and CSV parse exactly as before", () => {
  const { readWorkbookGuarded } = require("../lib/safeWorkbookRead.ts");
  const wb = readWorkbookGuarded(realXlsx(), { type: "array" });
  assert.deepEqual(XLSX.utils.sheet_to_json(wb.Sheets["Work Items"], { header: 1 }), [["Item", "Qty"], ["Slab", 20]]);
  const csv = readWorkbookGuarded(bytes("a,b\n1,2\n"), { type: "array" });
  assert.deepEqual(XLSX.utils.sheet_to_json(csv.Sheets[csv.SheetNames[0]], { header: 1 }), [["a", "b"], [1, 2]]);
});

test("readWorkbookGuarded: prototype pollution during a parse is undone and rejected", () => {
  const realRead = XLSX.read;
  const realToString = Object.prototype.toString;
  delete require.cache[require.resolve("../lib/safeWorkbookRead.ts")];
  XLSX.read = () => {
    // What a crafted workbook exploiting GHSA-4r6h-8v6p-xvw6 would do.
    Object.prototype.polluted = "yes";
    Array.prototype.pollutedArray = "yes";
    Object.prototype.toString = () => "hijacked";
    return {};
  };
  try {
    const { readWorkbookGuarded } = require("../lib/safeWorkbookRead.ts");
    assert.throws(() => readWorkbookGuarded(new Uint8Array([1]), { type: "array" }), /could not be read safely/);
    assert.equal({}.polluted, undefined);
    assert.equal([].pollutedArray, undefined);
    assert.equal(Object.prototype.toString, realToString);
  } finally {
    XLSX.read = realRead;
    delete Object.prototype.polluted;
    delete Array.prototype.pollutedArray;
    Object.prototype.toString = realToString;
    delete require.cache[require.resolve("../lib/safeWorkbookRead.ts")];
  }
});

// ---------------------------------------------------------------- workbook bounds
const { zipExpansionProblem, MAX_WORKBOOK_UNCOMPRESSED_BYTES } = require("../lib/safeWorkbookRead.ts");

/** A minimal one-entry ZIP whose central directory declares `declared`
 * uncompressed bytes (the data itself is tiny — a ZIP-bomb header). */
function zipDeclaring(declared, entries = 1) {
  const name = Buffer.from("xl/workbook.xml");
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  name.copy(local, 30);
  const cds = [];
  for (let i = 0; i < entries; i++) {
    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(declared, 24);
    cd.writeUInt16LE(name.length, 28);
    name.copy(cd, 46);
    cds.push(cd);
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries, 8);
  eocd.writeUInt16LE(entries, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return new Uint8Array(Buffer.concat([local, cdBuf, eocd]));
}

test("workbook bounds: real .xlsx/.xls/CSV pass; ZIP bombs, ZIP64 and broken archives are refused before parsing", () => {
  assert.equal(zipExpansionProblem(realXlsx()), null, "real xlsx");
  assert.equal(zipExpansionProblem(realXls()), null, "xls (OLE2) is not a ZIP");
  assert.equal(zipExpansionProblem(bytes("a,b\n1,2\n")), null, "csv");
  assert.equal(zipExpansionProblem(zipDeclaring(1000)), null, "small declared size");
  assert.match(zipExpansionProblem(zipDeclaring(MAX_WORKBOOK_UNCOMPRESSED_BYTES + 1)), /expands/);
  assert.match(zipExpansionProblem(zipDeclaring(200 * 1024 * 1024, 2)), /expands/, "sum across entries");
  assert.match(zipExpansionProblem(zipDeclaring(0xffffffff)), /ZIP64/);
  assert.match(zipExpansionProblem(zipDeclaring(10, 10_001)), /entries/);
  assert.ok(zipExpansionProblem(realXlsx().subarray(0, 200)), "truncated archive");

  const { readWorkbookGuarded } = require("../lib/safeWorkbookRead.ts");
  const original = console.error;
  console.error = () => {};
  try {
    assert.throws(() => readWorkbookGuarded(zipDeclaring(MAX_WORKBOOK_UNCOMPRESSED_BYTES + 1), { type: "array" }), /could not be read safely/);
  } finally {
    console.error = original;
  }
});

test("workbook import: .xlsx, .xls and CSV project files import identically through the guarded parser", () => {
  const { parseProjectWorkbook } = require("../lib/excelImport.ts");
  const aoa = [["Item No", "Description of Work", "Scheduled Value", "Department"], ["1", "Pour slab level 2", 1000, "Concrete"], ["2", "Rough-in conduit", 500, "Electrical"]];
  const results = ["xlsx", "biff8", "csv"].map((bookType) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Work Items");
    const out = XLSX.write(wb, { type: "buffer", bookType });
    const buf = new Uint8Array(typeof out === "string" ? Buffer.from(out) : out);
    assert.ok(looksLikeWorkbook(buf), bookType);
    const parsed = parseProjectWorkbook(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return parsed.rows.map((r) => [r.workItemNo, r.description, r.department]);
  });
  assert.deepEqual(results[0], [["1", "Pour slab level 2", "Concrete"], ["2", "Rough-in conduit", "Electrical"]]);
  assert.deepEqual(results[1], results[0], ".xls");
  assert.deepEqual(results[2], results[0], "csv");
});

test("workbook export: the stored .xlsx is still patched in place through the guarded reader", () => {
  const { patchOriginalWorkbook } = require("../lib/excelPreserve.ts");
  const original = realXlsx();
  const edited = XLSX.read(original, { type: "array", cellFormula: true, cellNF: true, cellStyles: true });
  edited.Sheets["Work Items"].B2 = { t: "n", v: 35 };
  const out = patchOriginalWorkbook(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength), edited, true);
  assert.ok(out, "patched in place (not the values-only fallback)");
  const reread = XLSX.read(out, { type: "buffer" });
  assert.equal(reread.Sheets["Work Items"].B2.v, 35);
});

// ---------------------------------------------------------------- review tokens
test("review tokens: bound to submission, user and expiry; tamper-evident", () => {
  const { createReviewToken, verifyReviewToken, REVIEW_TOKEN_TTL_SECONDS } = require("../lib/submissionReviewToken.ts");
  const now = Date.UTC(2026, 9, 13);
  const t = createReviewToken("sub-1", "user-1", now);
  assert.ok(verifyReviewToken(t, "sub-1", "user-1", now));
  assert.ok(verifyReviewToken(t, "sub-1", "user-1", now + (REVIEW_TOKEN_TTL_SECONDS - 1) * 1000));
  assert.equal(verifyReviewToken(t, "sub-1", "user-1", now + (REVIEW_TOKEN_TTL_SECONDS + 1) * 1000), false, "expired");
  assert.equal(verifyReviewToken(t, "sub-1", "user-2", now), false, "other user");
  assert.equal(verifyReviewToken(t, "sub-2", "user-1", now), false, "other submission");
  const [exp, sig] = t.split(".");
  assert.equal(verifyReviewToken(`${Number(exp) + 3600}.${sig}`, "sub-1", "user-1", now), false, "extended expiry");
  for (const bad of [undefined, null, "", "abc", `${exp}.`, `${exp}.${sig}x`, { t }]) {
    assert.equal(verifyReviewToken(bad, "sub-1", "user-1", now), false, JSON.stringify(bad));
  }
});

test("storage extension: real MIME subtypes are kept, anything else becomes \"bin\"", () => {
  for (const [mime, ext] of [
    ["audio/webm;codecs=opus", "webm"],
    ["audio/ogg; codecs=opus", "ogg"],
    ["audio/x-m4a", "x-m4a"],
    ["audio/MP4", "mp4"],
    ["video/webm", "webm"],
    ["image/jpeg", "jpeg"],
    ["audio/..", "bin"],
    ["audio/a?b#c", "bin"],
    ["audio/x%2f..%2fy", "bin"],
    ["audio/", "bin"],
    ["audio", "bin"],
    ["audio/averyveryverylongsubtype", "bin"],
  ]) {
    assert.equal(storageExtension(mime), ext, mime);
  }
});

test("jsonError: an authorization refusal is a 403 with the generic message, whatever status the route passed", async () => {
  const original = console.warn;
  console.warn = () => {};
  try {
    for (const [message, status] of [
      ["User 11111111-1111-4111-8111-111111111111 is not authorized for this action (Admin required).", 500],
      ["SUPERVISOR 11111111-1111-4111-8111-111111111111 is not authorized for this action (requires Admin or an active USER_MANAGEMENT delegation).", 500],
      ["Role WORKER is not authorized for this action", 500],
      ["FOREMAN 1234 is not authorized to configure tasks", 403],
      // Ownership refusals: a worker outside their assignment/department,
      // or a caller with no Active role — previously sent with raw ids.
      ["Work item 22222222-2222-4222-8222-222222222222 is not assigned to worker 11111111-1111-4111-8111-111111111111", 403],
      ["Work item 22222222-2222-4222-8222-222222222222 does not belong to department 33333333-3333-4333-8333-333333333333", 500],
      ["No active project/department assignment found for user 11111111-1111-4111-8111-111111111111: no matching row", 500],
    ]) {
      const res = jsonError(message, status);
      assert.equal(res.status, 403, message);
      assert.deepEqual(await res.json(), { error: "You don't have permission to do this." }, message);
    }
    // Everything else keeps its status and the existing message handling.
    const notFound = jsonError("Department not found.", 500);
    assert.equal(notFound.status, 500);
    assert.deepEqual(await notFound.json(), { error: "Department not found." });
    const invalid = jsonError("projectId is required.", 400);
    assert.equal(invalid.status, 400);
    // A wrong task id for the right work item is a validation error, not a refusal.
    const wrongTask = jsonError("Task t9 does not belong to work item W1", 403);
    assert.deepEqual(await wrongTask.json(), { error: "Task t9 does not belong to work item W1" });
  } finally {
    console.warn = original;
  }
});
