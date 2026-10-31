// Reads the account file used by verify-auth-accounts.mjs and
// manage-auth-accounts.mjs: [{ "email": "...", "password": "...", "role"? }].
//   - Refuses a file inside the repository, so it can never be committed.
//   - Accepts UTF-8 with a byte-order mark (what Windows PowerShell 5.1's
//     `-Encoding utf8` and some editors write).
//   - Never puts file content in an error message: Node's JSON errors quote
//     the start of the input, which could be part of a password.
import fs from "node:fs";
import path from "node:path";

/** { items } on success, { error } (safe to print) otherwise. */
export function loadAccountFile(file, repoRoot) {
  const resolved = path.resolve(file);
  const rel = path.relative(path.resolve(repoRoot), resolved);
  const outside = path.isAbsolute(rel) || rel.split(path.sep)[0] === "..";
  if (!outside) return { error: "the file is inside the repository — move it outside so it can never be committed" };

  let text;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (err) {
    return { error: `could not read ${path.basename(resolved)} (${err.code ?? "read error"})` };
  }
  let items;
  try {
    items = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { error: `${path.basename(resolved)} is not valid JSON — check quotes, commas and brackets` };
  }
  if (!Array.isArray(items) || items.length === 0) return { error: "the file must be a non-empty JSON array of { email, password }" };
  if (items.some((i) => !i || typeof i !== "object" || typeof i.email !== "string")) {
    return { error: "every entry needs an \"email\" string" };
  }
  return { items };
}
