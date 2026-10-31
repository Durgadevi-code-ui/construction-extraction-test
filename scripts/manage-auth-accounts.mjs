// The supported way to create missing logins or set passwords — instead of
// editing accounts by hand in the Supabase dashboard, which is how 12 of 19
// accounts ended up unable to sign in. Every account is validated first,
// every change is read back / proven by signing in, and the report says
// per account what happened. Nothing is ever reported as done unless it
// was verified.
//
//   node scripts/manage-auth-accounts.mjs create-logins --file <file.json>
//       For EXISTING app users only (matched by exact email; app users
//       are never created here): creates the Supabase login and links it.
//   node scripts/manage-auth-accounts.mjs set-passwords --file <file.json>
//       Sets the password of existing, linked logins, proves it by signing
//       in, then revokes all of that user's sessions.
//
//   <file.json> = [{ "email": "...", "password": "..." }, ...], kept OUTSIDE
//   the repository. Every account needs its own password.
//
// Default is a DRY RUN: checks everything, writes nothing. To make the
// changes add both:  --apply --confirm <number of accounts in the file>
// (the count guards against running a bigger file than intended).
//
// Exit code 0 only when every listed account succeeded.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  batchProblems,
  emailProblem,
  extractionTestWorkerEmail,
  normalizeEmail,
  passwordProblem,
  provisionLogin,
  runAccountBatch,
  setPasswordVerified,
} from "../lib/authAccounts.ts";
import { loadAccountFile } from "./accountFile.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const file = arg("--file");
const apply = process.argv.includes("--apply");
const confirm = Number(arg("--confirm"));

const mask = (email) => {
  const [user = "", domain = ""] = String(email ?? "").split("@");
  return `${user.slice(0, 2)}***${user.length > 3 ? user.slice(-1) : ""}@${domain}`;
};
const stop = (message) => {
  console.error(`STOPPED: ${message}`);
  process.exit(1);
};

if (!["create-logins", "set-passwords"].includes(command)) stop("first argument must be create-logins or set-passwords");
if (!file) stop("--file <file.json> is required");
const loaded = loadAccountFile(file, REPO_ROOT);
if (loaded.error) stop(loaded.error);
const { items } = loaded;
if (apply && confirm !== items.length) stop(`--apply needs --confirm ${items.length} (the number of accounts in the file)`);

const batch = batchProblems(items);
if (batch.length) stop(`the file is ambiguous, nothing was changed:\n  - ${batch.join("\n  - ")}`);

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(REPO_ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")])
);
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, noSession);
const anon = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, noSession);
const systemEmail = normalizeEmail(extractionTestWorkerEmail({ ...process.env, ...env }));

console.log(`${command} — ${items.length} account(s) — ${apply ? "APPLYING CHANGES" : "DRY RUN (nothing is written)"}`);
console.log(`Supabase project: ${new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0].slice(0, 4)}…  (shared by local and production)\n`);

/** What would happen, without writing anything. */
async function preview(item) {
  const email = normalizeEmail(item.email);
  const problem = emailProblem(email) ?? passwordProblem(item.password, email);
  if (problem) return { email, status: "failed", detail: problem };
  if (email === systemEmail) return { email, status: "failed", detail: "internal Extraction Test record — must never have a login" };
  const { data: rows, error } = await admin.from("users").select("user_id, user_role, auth_user_id").eq("user_mail", email);
  if (error) return { email, status: "failed", detail: `could not read app users: ${error.message}` };
  if (!rows?.length) return { email, status: "failed", detail: "no app user has this email (create the user in Admin Setup first)" };
  if (rows.length > 1) return { email, status: "failed", detail: "more than one app user has this email" };
  const [row] = rows;
  if (command === "create-logins") {
    return row.auth_user_id
      ? { email, status: "unchanged", detail: "already has a login — would be left alone" }
      : { email, status: "created", detail: `would create and link a login (${row.user_role})` };
  }
  if (!row.auth_user_id) return { email, status: "failed", detail: "has no login yet — run create-logins first" };
  const { data: auth } = await admin.auth.admin.getUserById(row.auth_user_id);
  if (normalizeEmail(auth?.user?.email) !== email) return { email, status: "failed", detail: "linked login is missing or has a different email — mapping is wrong" };
  return { email, status: "updated", detail: `would set the password, verify it, and revoke sessions (${row.user_role})` };
}

async function run(item) {
  if (!apply) return preview(item);
  const email = normalizeEmail(item.email);
  if (command === "set-passwords") return setPasswordVerified(admin, anon, { email, password: item.password });
  const { data: rows, error } = await admin.from("users").select("user_id").eq("user_mail", email);
  if (error) return { email, status: "failed", detail: `could not read app users: ${error.message}` };
  if (rows?.length !== 1) return { email, status: "failed", detail: rows?.length ? "more than one app user has this email" : "no app user has this email" };
  return provisionLogin(admin, { userId: rows[0].user_id, password: item.password });
}

const outcome = await runAccountBatch(items, run, { delayMs: apply && command === "set-passwords" ? 2000 : 0 });
for (const r of outcome.results) {
  const label = !apply && (r.status === "created" || r.status === "updated") ? `WOULD ${r.status === "created" ? "CREATE" : "UPDATE"}` : r.status.toUpperCase();
  console.log(`${label.padEnd(12)} | ${mask(r.email)} | ${r.detail}`);
}
console.log(
  `\n${outcome.succeeded} of ${outcome.results.length} ${apply ? "succeeded" : "would succeed"}, ${outcome.failed} failed.` +
    (outcome.complete ? "" : apply ? "  NOT COMPLETE — fix the failed accounts and run again (safe to repeat: existing logins are left alone; a repeated password is set and verified again)." : "  Fix the failures before applying.")
);
if (apply) console.log("Next: node scripts/verify-auth-accounts.mjs --credentials <same file>");
process.exit(outcome.complete ? 0 : 1);
