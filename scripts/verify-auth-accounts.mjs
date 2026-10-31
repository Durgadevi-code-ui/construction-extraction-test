// Pre-presentation login check: proves every application account can sign
// in, lands on the right dashboard, and that sessions behave. Read-only
// apart from Supabase's own last_sign_in_at and the short-lived test
// sessions it opens and then revokes. See docs in
// CONSTRUCTION_AUTHENTICATION_PERMANENT_STABILITY_AND_VERIFICATION_REPORT.md.
//
//   node scripts/verify-auth-accounts.mjs
//       1. Configuration: env variables, Supabase URL and both keys
//          actually accepted by Supabase, email/password login enabled,
//          password-reset link origin.
//       2. Account audit: every app user has exactly one confirmed,
//          unbanned login linked by id with the same email, an approved
//          role and an active project/department role; no duplicate,
//          orphaned or mismatched logins.
//
//   --credentials <file.json>
//       3. Sign-in check for each listed account. The file is
//          [{ "email": "...", "password": "...", "role": "WORKER" }]
//          ("role" optional: the role this account is meant to have) and
//          must be OUTSIDE this repository. App users missing from the file
//          are listed as UNVERIFIED — never silently skipped, never treated
//          as a password failure, and not a failure of the run (use
//          --require-all to make them one).
//
//   --app-url <http://localhost:3000 | https://...>
//       4. Checks the running app: login page, protected pages/APIs refuse
//          anonymous and forged sessions. With --credentials, each account
//          signs in through the real login form, then: lands on its role's
//          dashboard, is refused another role's dashboard, sees its own
//          email on /account, survives a session refresh, and after logout
//          its old cookies no longer work.
//
//   --production   reset links must not fall back to localhost (FAIL, not WARN)
//   --require-all  every sign-in account must be in --credentials and VERIFIED
//                  (use before a client presentation)
//   --env <file>   Supabase settings file (default .env.local)
//
// Output: masked emails, PASS/WARN/FAIL/INFO lines and a final per-account
// status table (login | role assignment | credentials); never a password or
// token. Exit code 0 only when no check FAILED.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { auditAccounts, classifySignInError, normalizeEmail, emailProblem, extractionTestWorkerEmail, passwordResetOrigin } from "../lib/authAccounts.ts";
import { loadAccountFile } from "./accountFile.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const envFile = arg("--env") ?? path.join(REPO_ROOT, ".env.local");
const credentialsFile = arg("--credentials");
const appUrl = arg("--app-url")?.replace(/\/+$/, "");
const production = process.argv.includes("--production");
const requireAll = process.argv.includes("--require-all");

const mask = (email) => {
  const [user = "", domain = ""] = String(email ?? "").split("@");
  return `${user.slice(0, 2)}***${user.length > 3 ? user.slice(-1) : ""}@${domain}`;
};
const counts = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
const failures = [];
function report(level, subject, message) {
  counts[level]++;
  if (level === "FAIL") failures.push(`${subject}: ${message}`);
  console.log(`${level.padEnd(4)} | ${subject} | ${message}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One account's final status, in three separate columns so a missing
 * login, a missing role assignment and an untested password are never
 * confused with each other:
 *   login:       LINKED | MISSING LOGIN | NO LOGIN (BY DESIGN)
 *   role:        OK | NO ROLE ASSIGNMENT | n/a
 *   credentials: VERIFIED | INVALID CREDENTIALS | UNVERIFIED (not in the
 *                credentials file — says nothing about the password) |
 *                RATE LIMITED / SERVICE PROBLEM (not judged) |
 *                SIGNED IN, CHECK FAILED (routing/session/identity) | n/a
 * `check` is null when the account is not in the credentials file,
 * otherwise { lines: [[level, message], ...] } from its sign-in checks.
 */
export function accountStatus(account, check) {
  if (account.system) return { login: "NO LOGIN (BY DESIGN)", role: "n/a", credentials: "n/a" };
  const role = account.role !== "ADMIN" && account.activeAssignments.length === 0 ? "NO ROLE ASSIGNMENT" : "OK";
  if (!account.hasLogin) return { login: "MISSING LOGIN", role, credentials: "n/a" };
  if (!check) return { login: "LINKED", role, credentials: "UNVERIFIED" };
  const failed = check.lines.filter(([level]) => level === "FAIL").map(([, message]) => message);
  let credentials = "VERIFIED";
  if (failed.some((m) => /^INVALID CREDENTIALS/.test(m))) credentials = "INVALID CREDENTIALS";
  else if (failed.some((m) => /^RATE LIMITED/.test(m))) credentials = "RATE LIMITED (not judged)";
  else if (failed.some((m) => /^(INFRASTRUCTURE|CONFIGURATION)/.test(m))) credentials = "SERVICE PROBLEM (not judged)";
  else if (failed.length) credentials = "SIGNED IN, CHECK FAILED";
  return { login: "LINKED", role, credentials };
}

// Where /workflow sends each role (app/workflow/page.tsx), and one other
// role's dashboard each role must be sent away from.
export const ROLE_HOME = { ADMIN: "/admin/setup", WORKER: "/workflow/worker", FOREMAN: "/workflow/foreman", SUPERVISOR: "/workflow/supervisor", MANAGER: "/workflow/supervisor" };
export const OTHER_ROLE_PAGE = { WORKER: "/workflow/foreman", FOREMAN: "/workflow/worker", SUPERVISOR: "/workflow/worker", MANAGER: "/workflow/worker" };

// ================================================================ redirect evaluation
// A response is { status, location, text }: `location` is the Location
// header (path or URL, or null), `text` the body.

const decodeHtml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
// React renders the apostrophe as &#x27;, so page text is decoded before matching.
const deniesAdminAccess = (html) => /doesn't have Admin access/.test(decodeHtml(String(html ?? "")));

/**
 * Where a response sends the browser, and how. proxy.ts redirects with a
 * real HTTP 3xx. A page that calls redirect() cannot: app/loading.tsx makes
 * every page stream, the 200 status is already sent, so Next.js puts the
 * redirect in the page as <meta id="__next-page-redirect"
 * http-equiv="refresh" content="1;url=…"> (documented in
 * node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md).
 * Only Next's own tag id counts; any other meta refresh is ignored.
 */
export function redirectTarget(res) {
  const base = "http://app.invalid";
  if (res.status >= 300 && res.status < 400 && res.location) return { via: "HTTP redirect", path: new URL(res.location, base).pathname };
  if (res.status === 200) {
    const tag = String(res.text ?? "").match(/<meta\b[^>]*\bid="__next-page-redirect"[^>]*>/)?.[0];
    const url = tag?.match(/\bcontent="\d+;\s*url=([^"]+)"/i)?.[1];
    if (url) return { via: "page redirect", path: new URL(decodeHtml(url), base).pathname };
  }
  return { via: null, path: null };
}

const describe = (res, target) => (target.path ? `${target.via} to ${target.path}` : `HTTP ${res.status} with no redirect`);

/** /workflow must send the user to exactly their own role's dashboard. */
export function evaluateOwnDashboardRouting(res, role) {
  const expected = ROLE_HOME[role];
  if (!expected) return ["FAIL", `ROLE — no dashboard is defined for role ${role}`];
  const target = redirectTarget(res);
  if (target.path === expected) return ["PASS", `routed to the ${role} dashboard (${describe(res, target)})`];
  return ["FAIL", `ROLE — expected a redirect to ${expected}, got ${describe(res, target)}${target.path ? "" : " (no project/department role assigned?)"}`];
}

/** The user's own dashboard must actually render — not redirect elsewhere. */
export function evaluateOwnDashboardLoads(res, role) {
  const target = redirectTarget(res);
  if (target.path) return ["FAIL", `SESSION/ROLE — own dashboard sent the user away (${describe(res, target)})`];
  if (res.status !== 200) return ["FAIL", `SESSION/ROLE — own dashboard returned HTTP ${res.status}`];
  if (role === "ADMIN" && deniesAdminAccess(res.text)) return ["FAIL", "ROLE — Admin Setup says this account has no Admin access"];
  return ["PASS", "dashboard loads on a second request (session persists)"];
}

/** Another role's dashboard must send the user back to /workflow. */
export function evaluateOtherRoleDashboard(res, role, otherPath) {
  const target = redirectTarget(res);
  if (target.path === "/workflow") return ["PASS", `refused another role's dashboard (${otherPath}: ${describe(res, target)})`];
  if (target.path) return ["FAIL", `ROLE — ${otherPath} should redirect a ${role} to /workflow, got ${describe(res, target)}`];
  if (res.status === 200) return ["FAIL", `ROLE — ${role} could open ${otherPath} (HTTP 200, no redirect)`];
  // An error page is not access, but not proof of refusal either.
  return ["WARN", `${otherPath} answered HTTP ${res.status} instead of redirecting — check the app logs`];
}

/**
 * Proves this verifier can read the running Next.js version's page
 * redirects: app/page.tsx always redirects "/" to /workflow. If a future
 * Next.js release changes the tag, this fails instead of the role checks
 * silently misjudging.
 */
export function evaluateRedirectSelfTest(res) {
  const target = redirectTarget(res);
  if (target.path === "/workflow") return ["PASS", `GET / → /workflow is readable (${target.via})`];
  return ["FAIL", `GET / did not show a readable redirect to /workflow (${describe(res, target)}) — role routing checks cannot be trusted; update redirectTarget for this Next.js version`];
}

async function main() {
  // ================================================================ 1. configuration

  console.log("\n== 1. Configuration");
  const env = Object.fromEntries(
    fs
      .readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")])
  );
  let configOk = true;
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (env[name]) report("PASS", name, "present");
    else {
      report("FAIL", name, `missing in ${path.basename(envFile)}`);
      configOk = false;
    }
  }
  if (!configOk) finish();

  let supabaseHost = "";
  try {
    const u = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
    supabaseHost = u.host;
    if (u.protocol !== "https:") report("FAIL", "Supabase URL", "must be https");
    else report(u.hostname.endsWith(".supabase.co") ? "PASS" : "WARN", "Supabase URL", u.hostname.endsWith(".supabase.co") ? "https, *.supabase.co" : "not a *.supabase.co host — confirm it is intended");
  } catch {
    report("FAIL", "Supabase URL", "not a valid URL");
    finish();
  }
  if (env.NEXT_PUBLIC_SUPABASE_ANON_KEY === env.SUPABASE_SERVICE_ROLE_KEY) report("FAIL", "keys", "public key and service-role key are identical");

  try {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY } });
    if (res.status === 200) {
      const settings = await res.json();
      report("PASS", "public (anon) key", "accepted by Supabase");
      report(settings.external?.email ? "PASS" : "FAIL", "email/password login", settings.external?.email ? "enabled in Supabase" : "DISABLED in Supabase Auth settings");
      report(settings.disable_signup ? "PASS" : "WARN", "public sign-up", settings.disable_signup ? "disabled (accounts only via Admin)" : "enabled — anyone can create a login");
    } else {
      report("FAIL", "public (anon) key", `rejected by Supabase (HTTP ${res.status}) — every login would fail`);
    }
  } catch (err) {
    report("FAIL", "Supabase reachability", `could not reach Supabase (${err.cause?.code ?? err.message})`);
    finish();
  }

  const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, noSession);

  let reset;
  try {
    reset = passwordResetOrigin({ ...process.env, ...env });
  } catch {
    reset = null;
    report("FAIL", "password-reset link", "NEXT_PUBLIC_SITE_URL is not a valid URL — password-reset requests would fail");
  }
  if (!reset) {
    // reported above
  } else if (reset.source === "local default") {
    report(production ? "FAIL" : "WARN", "password-reset link", `would point at ${reset.origin} — set NEXT_PUBLIC_SITE_URL${production ? "" : " (required in Vercel)"}`);
  } else {
    report(reset.origin.startsWith("https://") || !production ? "PASS" : "FAIL", "password-reset link", `${reset.origin} (from ${reset.source}) — must also be in Supabase Auth → URL Configuration → Redirect URLs`);
  }

  // ================================================================ 2. account audit

  console.log("\n== 2. Account audit");
  let audit;
  try {
    audit = await auditAccounts(admin, { systemEmails: [extractionTestWorkerEmail({ ...process.env, ...env })] });
    report("PASS", "service-role key", "accepted; app users and logins readable");
  } catch (err) {
    report("FAIL", "service-role key / database", err.message);
    finish();
  }
  const byEmail = new Map(audit.accounts.map((a) => [a.email, a]));
  for (const a of [...audit.accounts].sort((x, y) => x.role.localeCompare(y.role) || x.email.localeCompare(y.email))) {
    const subject = `${mask(a.email)} (${a.role})`;
    // One line per problem, labelled, so a missing login and a missing role
    // assignment are never merged into one message.
    for (const p of a.problems) {
      if (/^MISSING LOGIN/.test(p)) report("FAIL", subject, "MISSING LOGIN — this user cannot sign in; create it in Admin Setup → Users → Link Login");
      else if (/^no active project\/department role/.test(p)) report("FAIL", subject, "NO ROLE ASSIGNMENT — no active project/department role; the dashboard will be empty");
      else report("FAIL", subject, p);
    }
    if (a.problems.length) continue;
    if (a.system) report("PASS", subject, "internal Extraction Test record — no login by design");
    else report(a.warnings.length ? "WARN" : "PASS", subject, a.warnings.length ? a.warnings.join("; ") : `login linked, confirmed; active as ${a.activeAssignments.join(", ") || "ADMIN"}`);
  }
  for (const p of audit.globalProblems) report("FAIL", mask(p.split(":")[0]), p.slice(p.indexOf(":") + 2));
  const people = audit.accounts.filter((a) => !a.system);
  console.log(`${people.length} sign-in accounts (+${audit.accounts.length - people.length} internal record), ${people.filter((a) => a.hasLogin).length} with a linked login.`);

  // ================================================================ 4a. app checks without credentials

  const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function get(pathname, jar = new Map()) {
    const res = await fetch(`${appUrl}${pathname}`, { redirect: "manual", headers: jar.size ? { cookie: cookieHeader(jar) } : {} });
    const location = res.headers.get("location");
    // `location` stays the HTTP header only: the anonymous/logout checks
    // below require proxy.ts's real redirects. Page redirects are read
    // separately by redirectTarget() where a page is expected to redirect.
    return { status: res.status, location: location ? new URL(location, appUrl).pathname : null, text: await res.text() };
  }

  if (appUrl) {
    console.log(`\n== 4a. App at ${appUrl} (anonymous)`);
    try {
      const login = await get("/login");
      report(login.status === 200 && /name="password"/.test(login.text) ? "PASS" : "FAIL", "GET /login", `HTTP ${login.status}`);
      for (const p of ["/workflow", "/workflow/worker", "/admin/setup", "/account"]) {
        const r = await get(p);
        report(r.status >= 300 && r.status < 400 && r.location === "/login" ? "PASS" : "FAIL", `GET ${p} (no session)`, r.location ? `redirect → ${r.location}` : `HTTP ${r.status}`);
      }
      const [selfLevel, selfMessage] = evaluateRedirectSelfTest(await get("/"));
      report(selfLevel, "redirect detection self-test", selfMessage);
      const api = await get("/api/workflow/dashboard");
      report(api.status === 401 ? "PASS" : "FAIL", "GET /api/workflow/dashboard (no session)", `HTTP ${api.status}`);
      const ref = supabaseHost.split(".")[0];
      const forged = await get("/workflow", new Map([[`sb-${ref}-auth-token`, "base64-eyJhY2Nlc3NfdG9rZW4iOiJmb3JnZWQifQ"]]));
      report(forged.location === "/login" ? "PASS" : "FAIL", "GET /workflow (forged session cookie)", forged.location ? `redirect → ${forged.location}` : `HTTP ${forged.status}`);
      // A deployed app builds its Supabase host into its Content-Security-Policy.
      const head = await fetch(`${appUrl}/login`, { method: "HEAD" });
      const csp = head.headers.get("content-security-policy") ?? "";
      const deployedHost = csp.match(/https:\/\/([a-z0-9-]+\.supabase\.co)/)?.[1];
      if (deployedHost) report(deployedHost === supabaseHost ? "PASS" : "FAIL", "app ↔ Supabase project", deployedHost === supabaseHost ? "app uses the same Supabase project as this env file" : "app uses a DIFFERENT Supabase project than this env file");
      else report("WARN", "app ↔ Supabase project", "could not read the Supabase host from the app's headers");
    } catch (err) {
      report("FAIL", "app", `not reachable (${err.cause?.code ?? err.message}) — is it running?`);
    }
  }

  // ================================================================ 3/4b. per-account credential checks

  const checks = new Map(); // email -> { lines } for accounts in the credentials file
  if (credentialsFile) {
    const loaded = loadAccountFile(credentialsFile, REPO_ROOT);
    if (loaded.error) {
      report("FAIL", "credentials file", loaded.error);
      finish();
    }
    const creds = loaded.items;
    console.log(`\n== 3. Sign-in check (${creds.length} accounts${appUrl ? `, through ${appUrl}` : ", directly against Supabase"})`);

    const seen = new Set();
    const identities = new Map();
    for (const entry of creds) {
      const email = normalizeEmail(entry.email);
      const subject = mask(email);
      if (seen.has(email)) {
        report("FAIL", subject, "listed twice in the credentials file");
        continue;
      }
      seen.add(email);
      const account = byEmail.get(email);
      const expectedRole = entry.role ? String(entry.role).toUpperCase() : account?.role;

      if (!account) {
        report("FAIL", subject, `NOT AN ACCOUNT — no app user has this email${emailProblem(email) ? ` (${emailProblem(email)})` : ""}; nothing was tried`);
        continue;
      }
      if (!account.hasLogin) {
        report("FAIL", subject, "MISSING LOGIN — the app user has no login yet; create it in Admin Setup → Users → Link Login. Nothing was tried");
        continue;
      }
      if (entry.role && expectedRole !== account.role) report("FAIL", subject, `ROLE MISMATCH — meant to be ${expectedRole}, app user is ${account.role}`);
      if (typeof entry.password !== "string" || !entry.password) {
        report("FAIL", subject, "UNVERIFIED — no password in the credentials file");
        continue;
      }
      const pasteHint = entry.password !== entry.password.trim() ? " (the password in the file starts/ends with a space)" : "";

      const result = appUrl ? await checkThroughApp(email, entry.password, expectedRole) : await checkDirect(email, entry.password, account);
      if (result.identity) identities.set(email, result.identity);
      checks.set(email, result);
      for (const [level, message] of result.lines) report(level, subject, level === "FAIL" && /^INVALID CREDENTIALS/.test(message) ? message + pasteHint : message);
      await sleep(2000); // stay under Supabase Auth's per-IP sign-in limit
    }
    if (identities.size > 1) {
      const distinct = new Set(identities.values()).size;
      report(distinct === identities.size ? "PASS" : "FAIL", "session isolation", distinct === identities.size ? `${identities.size} accounts, ${distinct} distinct identities` : "two accounts resolved to the same identity");
    }
  }

  // ================================================================ 5. per-account status

  console.log("\n== 5. Account status (login | role assignment | credentials)");
  const tally = {};
  for (const a of [...audit.accounts].sort((x, y) => x.role.localeCompare(y.role) || x.email.localeCompare(y.email))) {
    const s = accountStatus(a, checks.get(a.email) ?? null);
    tally[s.credentials] = (tally[s.credentials] ?? 0) + 1;
    console.log(`  ${mask(a.email).padEnd(36)} ${a.role.padEnd(10)} ${s.login.padEnd(20)} ${s.role.padEnd(18)} ${s.credentials}`);
    // Not in the credentials file: informational only — it says nothing
    // about the password, unless --require-all asks for every account.
    if (s.credentials === "UNVERIFIED" && requireAll) report("FAIL", mask(a.email), "UNVERIFIED — --require-all is set and this account is not in the credentials file");
  }
  const unverified = tally.UNVERIFIED ?? 0;
  console.log(`  credentials: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  if (unverified && !requireAll) report("INFO", "credentials", `${unverified} account(s) UNVERIFIED — not in the credentials file; their passwords were not tested and are NOT judged`);

  /** Supabase-only: sign in, check identity mapping, refresh, sign out, old token refused. */
  async function checkDirect(email, password, account) {
    const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, noSession);
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { lines: [["FAIL", explainSignInFailure(error, account)]] };
    const lines = [];
    const { data: profile } = await admin.from("users").select("auth_user_id").eq("user_mail", email).maybeSingle();
    if (data.user.id !== profile?.auth_user_id) lines.push(["FAIL", "MAPPING ERROR — signed in as a different login than the app user is linked to"]);
    else lines.push(["PASS", `signed in; identity matches app user (${account.role})`]);
    const accessToken = data.session.access_token;
    const { error: refreshError } = await client.auth.refreshSession();
    lines.push(refreshError ? ["FAIL", `SESSION — refresh failed (${classifySignInError(refreshError)})`] : ["PASS", "session refresh works"]);
    await client.auth.signOut({ scope: "local" });
    const { error: afterLogout } = await admin.auth.getUser(accessToken);
    lines.push(afterLogout ? ["PASS", "after logout the old session is refused"] : ["FAIL", "SESSION — old access token still accepted after logout"]);
    return { lines, identity: data.user.id };
  }

  /** Through the running app: real login form, role routing, refresh, logout. */
  async function checkThroughApp(email, password, expectedRole) {
    const lines = [];
    const jar = new Map();
    const absorb = (res) => {
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(";");
        const name = pair.slice(0, pair.indexOf("=")).trim();
        const value = pair.slice(pair.indexOf("=") + 1);
        if (!value || attrs.some((a) => /max-age=0/i.test(a.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
    };

    let page;
    try {
      page = await fetch(`${appUrl}/login`);
    } catch (err) {
      return { lines: [["FAIL", `INFRASTRUCTURE — app not reachable (${err.cause?.code ?? err.message})`]] };
    }
    const html = await page.text();
    const decode = decodeHtml;
    const form = new FormData();
    const hidden = [...html.matchAll(/<input type="hidden" name="(\$ACTION[^"]*)"(?: value="([^"]*)")?/g)];
    if (hidden.length === 0) return { lines: [["FAIL", "could not find the login form's action fields — this check needs updating for the current Next.js version"]] };
    for (const m of hidden) form.append(m[1], decode(m[2] ?? ""));
    form.append("email", email);
    form.append("password", password);

    const res = await fetch(`${appUrl}/login`, { method: "POST", body: form, redirect: "manual" });
    absorb(res);
    const location = res.headers.get("location");
    if (!(res.status >= 300 && res.status < 400 && location)) {
      const message = decode((await res.text()).match(/text-error">([^<]+)</)?.[1] ?? `no redirect (HTTP ${res.status})`);
      const account = byEmail.get(email);
      return { lines: [["FAIL", explainAppLoginMessage(message, account)]] };
    }
    if (![...jar.keys()].some((k) => /^sb-.*-auth-token/.test(k))) return { lines: [["FAIL", "SESSION — signed in but no session cookie was set"]] };
    lines.push(["PASS", "signed in through the login page"]);

    lines.push(evaluateOwnDashboardRouting(await get("/workflow", jar), expectedRole));
    const expectedHome = ROLE_HOME[expectedRole];
    if (expectedHome) lines.push(evaluateOwnDashboardLoads(await get(expectedHome, jar), expectedRole));
    const other = OTHER_ROLE_PAGE[expectedRole];
    if (other) {
      lines.push(evaluateOtherRoleDashboard(await get(other, jar), expectedRole, other));
      const adminPage = await get("/admin/setup", jar);
      if (adminPage.status === 200 && !redirectTarget(adminPage).path && !deniesAdminAccess(adminPage.text)) {
        lines.push(["WARN", "can open Admin Setup — only correct if this account holds an Admin delegation"]);
      }
    }
    const accountPage = await get("/account", jar);
    const ownEmail = accountPage.status === 200 && accountPage.text.toLowerCase().includes(email);
    lines.push(ownEmail ? ["PASS", "/account shows this user's own email"] : ["FAIL", `IDENTITY — /account did not show this user's email (HTTP ${accountPage.status})`]);

    // Refresh and logout with the same cookies the browser would hold.
    const before = new Map(jar);
    const ssr = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (list) => list.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
      },
    });
    const { data: who } = await ssr.auth.getUser();
    const { error: refreshError } = await ssr.auth.refreshSession();
    if (refreshError) lines.push(["FAIL", `SESSION — refresh failed (${classifySignInError(refreshError)})`]);
    else {
      const again = await get("/account", jar);
      lines.push(again.status === 200 ? ["PASS", "session refresh works in the app"] : ["FAIL", `SESSION — app refused the refreshed session (HTTP ${again.status})`]);
    }
    await ssr.auth.signOut({ scope: "local" });
    const afterLogout = await get("/workflow", before);
    lines.push(afterLogout.location === "/login" ? ["PASS", "after logout the old session cookies are refused"] : ["FAIL", `SESSION — old cookies still accepted after logout (${afterLogout.location ?? afterLogout.status})`]);
    if (!who?.user) lines.push(["FAIL", "IDENTITY — the session cookies did not resolve to a Supabase user"]);
    return { lines, identity: who?.user?.id };
  }

  function explainSignInFailure(error, account) {
    const kind = classifySignInError(error);
    if (kind === "invalid_credentials") {
      // The login exists, is confirmed and not banned (audit), so Supabase
      // refusing it can only mean the stored password differs from the file's.
      return account?.hasLogin && account.emailConfirmed
        ? "INVALID CREDENTIALS — the login exists and is confirmed, but Supabase rejected this password (it is not the stored one)"
        : "SIGN-IN REFUSED — invalid_credentials (account state is not clean, see audit)";
    }
    if (kind === "rate_limited") return "RATE LIMITED — Supabase refused to check (too many attempts); retry in a few minutes. Password NOT judged.";
    if (kind === "unavailable") return "INFRASTRUCTURE — Supabase unreachable or erroring; password NOT judged";
    if (kind === "app_key_rejected") return "CONFIGURATION — Supabase rejected the public key; password NOT judged";
    if (kind === "email_not_confirmed") return "EMAIL NOT CONFIRMED";
    return `SIGN-IN FAILED — ${error.code ?? error.name} (HTTP ${error.status ?? "-"})`;
  }

  function explainAppLoginMessage(message, account) {
    if (/^Invalid email or password/.test(message)) {
      return account?.hasLogin && account.emailConfirmed
        ? "INVALID CREDENTIALS — the login exists and is confirmed, but Supabase rejected this password (it is not the stored one)"
        : "SIGN-IN REFUSED — Invalid email or password";
    }
    if (/Too many/.test(message)) return `RATE LIMITED — "${message}" Password NOT judged.`;
    if (/temporarily unavailable/.test(message)) return `INFRASTRUCTURE — "${message}" Password NOT judged.`;
    if (/not available right now/.test(message)) return `CONFIGURATION — "${message}" Password NOT judged.`;
    if (/isn't linked/.test(message)) return "MAPPING ERROR — password correct but the login is not linked to an app user";
    return `LOGIN FAILED — "${message}"`;
  }

  function finish() {
    console.log(`\nSummary: ${counts.PASS} passed, ${counts.WARN} warnings, ${counts.FAIL} failed, ${counts.INFO} info`);
    const scope = requireAll ? "" : " (accounts not in the credentials file were not tested — add --require-all before a presentation)";
    console.log(counts.FAIL ? "RESULT: FAIL — not ready for a presentation" : `${counts.WARN ? "RESULT: PASS with warnings" : "RESULT: PASS"}${scope}`);
    process.exit(counts.FAIL ? 1 : 0);
  }
  finish();
}


// Runs only when executed directly; importing (tests) just loads the
// evaluation functions above. Case-insensitive on Windows, where the same
// folder can appear as c:\… or C:\… — a mismatch must never turn the
// check into a silent no-op.
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) await main();
