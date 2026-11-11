// Presentation workspace for Demo Login (app/demo-login, lib/demoAccess.ts).
//
// Creates ONE dedicated presentation project with synthetic sample data in
// the existing Supabase database, and moves the configured Demo Login
// accounts (@example.com only) into it, so demo sessions — which can save
// changes — only ever work on presentation data.
//
//   node scripts/seed-presentation-project.mjs            DRY RUN: reads only, prints the plan
//   node scripts/seed-presentation-project.mjs --apply    makes the changes
//
// Safe to run again (idempotent): every record is found by its natural key
// first and only created when missing. Nothing is ever deleted. The only
// existing rows it changes belong to the Demo Login accounts themselves:
//   - their Active project roles OUTSIDE the presentation project are set to
//     status 'Removed' (the same soft-remove Admin Setup uses), so they leave
//     the client projects; work they recorded there is not touched;
//   - Active admin delegations held by the presentation Admin account
//     (demo.admin) are set to 'Revoked' unless they cover exactly the
//     presentation project.
// No real (non-@example.com) user, project, submission, assignment, chat
// message or file is read for changes or written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- sample data (synthetic)
const COMPANY = { code: "PRES-DEMO", name: "Presentation Demo Construction Co.", address: "100 Sample Avenue, Demo City (fictional)" };
const PROJECT = { code: "PRES-DEMO-001", name: "Presentation Demo Tower (Sample Data)", location: "Demo City (fictional)" };
const DEPARTMENTS = [
  { code: "PRES-ELEC", name: "Electrical Department" },
  { code: "PRES-PLMB", name: "Plumbing Department" },
  { code: "PRES-CONC", name: "Concrete Department" },
];
const WORK_ITEMS = {
  "Electrical Department": [
    { no: "E-100", csi: "26 05 19", desc: "Branch circuit wiring, levels 1-3 (sample)", value: 48000, uom: "LF", qty: 6000 },
    { no: "E-200", csi: "26 24 16", desc: "Panelboard installation (sample)", value: 32000, uom: "EA", qty: 8 },
    { no: "E-300", csi: "26 51 00", desc: "Interior LED lighting fixtures (sample)", value: 27500, uom: "EA", qty: 220 },
  ],
  "Plumbing Department": [
    { no: "P-100", csi: "22 11 16", desc: "Domestic water piping, risers (sample)", value: 36000, uom: "LF", qty: 1800 },
    { no: "P-200", csi: "22 13 16", desc: "Sanitary waste and vent piping (sample)", value: 29000, uom: "LF", qty: 1500 },
    { no: "P-300", csi: "22 42 00", desc: "Plumbing fixtures, restrooms (sample)", value: 21000, uom: "EA", qty: 42 },
  ],
  "Concrete Department": [
    { no: "C-100", csi: "03 30 00", desc: "Foundation footings (sample)", value: 64000, uom: "CY", qty: 320 },
    { no: "C-200", csi: "03 30 00", desc: "Slab on grade, level 1 (sample)", value: 52000, uom: "SF", qty: 12000 },
    { no: "C-300", csi: "03 11 00", desc: "Column formwork and pour (sample)", value: 38000, uom: "CY", qty: 140 },
  ],
};

// The Demo Login slots (same keys/roles/teams as lib/demoAccess.ts DEMO_SLOTS).
const SLOTS = [
  { key: "admin_demo", role: "SUPERVISOR", department: "Electrical Department", delegatedAdmin: true },
  { key: "contractor_electrical", role: "SUPERVISOR", department: "Electrical Department" },
  { key: "contractor_plumbing", role: "SUPERVISOR", department: "Plumbing Department" },
  { key: "contractor_concrete", role: "SUPERVISOR", department: "Concrete Department" },
  { key: "subcontractor_electrical", role: "FOREMAN", department: "Electrical Department" },
  { key: "subcontractor_plumbing", role: "FOREMAN", department: "Plumbing Department" },
  { key: "subcontractor_concrete", role: "FOREMAN", department: "Concrete Department" },
  { key: "worker_electrical", role: "WORKER", department: "Electrical Department" },
  { key: "worker_plumbing", role: "WORKER", department: "Plumbing Department" },
  { key: "worker_concrete", role: "WORKER", department: "Concrete Department" },
];
// The presentation Admin's delegation: every Admin Setup / workflow module
// except USER_MANAGEMENT (lib/demoAccess.ts refuses that for demo accounts).
const ADMIN_PERMISSIONS = [
  "PROJECT_MANAGEMENT",
  "DEPARTMENT_MANAGEMENT",
  "WORK_ITEM_MANAGEMENT",
  "WORKER_ASSIGNMENT",
  "PLANNED_QUANTITY_MANAGEMENT",
  "PROGRESS_REVIEW",
];

// ---------------------------------------------------------------- setup
function loadEnv() {
  const text = fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
  return { ...env, ...process.env };
}
const env = loadEnv();
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const isDemoEmail = (e) => typeof e === "string" && /^[^@\s]+@example\.com$/.test(e.trim().toLowerCase());

const plan = [];
const note = (action, what) => plan.push(`${APPLY ? "DONE " : "WOULD"} ${action.padEnd(10)} ${what}`);
function must(result, what) {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

// ---------------------------------------------------------------- 1. preflight (read-only)
async function preflight() {
  const accounts = [];
  for (const slot of SLOTS) {
    const email = (env[`DEMO_LOGIN_${slot.key.toUpperCase()}_EMAIL`] ?? "").trim().toLowerCase();
    if (!email) throw new Error(`DEMO_LOGIN_${slot.key.toUpperCase()}_EMAIL is not set in .env.local`);
    if (!isDemoEmail(email)) throw new Error(`${slot.key}: ${email} is not an @example.com demo address — refusing`);
    const user = must(
      await db.from("users").select("user_id, user_mail, user_role, status, auth_user_id").eq("user_mail", email).maybeSingle(),
      `look up ${email}`
    );
    if (!user) throw new Error(`${slot.key}: no app user ${email}`);
    if (!user.auth_user_id) throw new Error(`${slot.key}: ${email} has no login`);
    if (user.user_role === "ADMIN") throw new Error(`${slot.key}: ${email} is an ADMIN — refusing`);
    if (user.status !== "Active") throw new Error(`${slot.key}: ${email} is not Active`);
    accounts.push({ ...slot, email, userId: user.user_id });
  }
  const admins = must(await db.from("users").select("user_id").eq("user_role", "ADMIN").eq("status", "Active"), "look up Admin");
  if (admins.length !== 1) throw new Error(`expected exactly one Active ADMIN to record as the delegation's grantor, found ${admins.length}`);
  return { accounts, adminUserId: admins[0].user_id };
}

// ---------------------------------------------------------------- 2. find-or-create helpers
async function findOrCreate(table, match, insert, label, idColumn) {
  let q = db.from(table).select(idColumn);
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const found = must(await q.limit(2), `look up ${label}`);
  if (found.length > 1) throw new Error(`${label}: more than one match — refusing to guess`);
  if (found[0]) {
    note("exists", label);
    return found[0][idColumn];
  }
  note("create", label);
  if (!APPLY) return `(new ${table})`;
  const created = must(await db.from(table).insert({ ...match, ...insert }).select(idColumn).single(), `create ${label}`);
  return created[idColumn];
}

// ---------------------------------------------------------------- run
async function main() {
  console.log(APPLY ? "APPLYING presentation seed\n" : "DRY RUN — nothing is written (add --apply to make these changes)\n");
  const { accounts, adminUserId } = await preflight();
  note("check", `${accounts.length} Demo Login accounts found, all @example.com, linked, Active, none ADMIN`);

  // Company, project, departments
  const companyId = await findOrCreate("companies", { code: COMPANY.code }, { name: COMPANY.name, address: COMPANY.address, status: "Active" }, `company ${COMPANY.code} "${COMPANY.name}"`, "company_id");
  const projectId = APPLY || !companyId.startsWith("(")
    ? await findOrCreate("projects", { project_code: PROJECT.code }, { company_id: companyId, project_name: PROJECT.name, project_location: PROJECT.location, status: "Active" }, `project ${PROJECT.code} "${PROJECT.name}"`, "project_id")
    : (note("create", `project ${PROJECT.code} "${PROJECT.name}"`), "(new projects)");
  if (!projectId.startsWith("(")) {
    const project = must(await db.from("projects").select("company_id").eq("project_id", projectId).single(), "read project");
    if (project.company_id !== companyId) throw new Error(`project ${PROJECT.code} exists under another company — refusing`);
  }

  const departmentIds = {};
  for (const d of DEPARTMENTS) {
    departmentIds[d.name] = projectId.startsWith("(")
      ? (note("create", `department "${d.name}"`), "(new departments)")
      : await findOrCreate("departments", { project_id: projectId, department_name: d.name }, { department_code: d.code, status: "Active" }, `department "${d.name}"`, "department_id");
  }

  // Work items
  const workItemIds = {};
  for (const [deptName, items] of Object.entries(WORK_ITEMS)) {
    workItemIds[deptName] = [];
    for (const w of items) {
      const deptId = departmentIds[deptName];
      const id = deptId.startsWith("(")
        ? (note("create", `work item ${w.no} "${w.desc}"`), "(new work_items)")
        : await findOrCreate(
            "work_items",
            { department_id: deptId, line_item_no: w.no },
            { project_id: projectId, csi_line_code: w.csi, description_of_work: w.desc, scheduled_value: w.value, unit_of_measure: w.uom, planned_quantity: w.qty, retainage_percent: 10, status: "Active" },
            `work item ${w.no} "${w.desc}"`,
            "work_item_id"
          );
      workItemIds[deptName].push(id);
    }
  }

  // Demo accounts: Active role in the presentation project, removed elsewhere
  for (const a of accounts) {
    const deptId = departmentIds[a.department];
    const roles = must(
      await db.from("user_project_roles").select("user_project_role_id, project_id, department_id, role, status").eq("user_id", a.userId),
      `roles of ${a.email}`
    );
    const target = roles.find((r) => r.project_id === projectId && r.department_id === deptId && r.role === a.role);
    if (target?.status === "Active") note("exists", `${a.email}: ${a.role} in ${a.department}`);
    else if (target) {
      note("reactivate", `${a.email}: ${a.role} in ${a.department}`);
      if (APPLY) must(await db.from("user_project_roles").update({ status: "Active" }).eq("user_project_role_id", target.user_project_role_id), "reactivate role");
    } else {
      note("create", `${a.email}: ${a.role} in ${a.department}`);
      if (APPLY) must(await db.from("user_project_roles").insert({ user_id: a.userId, project_id: projectId, department_id: deptId, role: a.role, status: "Active" }), "create role");
    }
    for (const r of roles.filter((r) => r.status === "Active" && r !== target)) {
      note("remove", `${a.email}: role ${r.role} in another project (${r.project_id}) -> status 'Removed'`);
      if (APPLY) must(await db.from("user_project_roles").update({ status: "Removed" }).eq("user_project_role_id", r.user_project_role_id), "remove role");
    }
  }

  // Workers assigned to their department's sample work items
  for (const a of accounts.filter((x) => x.role === "WORKER")) {
    for (const wid of workItemIds[a.department]) {
      if (wid.startsWith("(")) {
        note("assign", `${a.email} -> a ${a.department} sample work item`);
        continue;
      }
      const existing = must(await db.from("work_item_assignments").select("status").eq("work_item_id", wid).eq("user_id", a.userId).maybeSingle(), "look up assignment");
      if (existing?.status === "Active") {
        note("exists", `${a.email} assigned to work item ${wid.slice(0, 8)}`);
        continue;
      }
      note("assign", `${a.email} -> work item ${wid.slice(0, 8)}`);
      if (APPLY) {
        must(
          await db.from("work_item_assignments").upsert({ work_item_id: wid, user_id: a.userId, status: "Active", assigned_at: new Date().toISOString() }, { onConflict: "work_item_id,user_id" }),
          "assign work item"
        );
      }
    }
  }

  // Presentation Admin delegation
  const presAdmin = accounts.find((a) => a.delegatedAdmin);
  const delegations = must(
    await db.from("admin_delegations").select("delegation_id, delegation_projects(project_id), delegation_departments(department_id)").eq("delegate_user_id", presAdmin.userId).eq("status", "Active"),
    "look up delegations"
  );
  const coversExactly = (d) =>
    d.delegation_projects.length === 1 && d.delegation_projects[0].project_id === projectId && d.delegation_departments.length === 0;
  let keep = delegations.find(coversExactly);
  for (const d of delegations.filter((d) => d !== keep)) {
    note("revoke", `${presAdmin.email}: delegation ${d.delegation_id.slice(0, 8)} (covers other projects) -> 'Revoked'`);
    if (APPLY) must(await db.from("admin_delegations").update({ status: "Revoked", revoked_at: new Date().toISOString() }).eq("delegation_id", d.delegation_id), "revoke delegation");
  }
  if (keep) {
    note("exists", `${presAdmin.email}: delegation over the presentation project`);
    const perms = must(await db.from("delegation_permissions").select("permission").eq("delegation_id", keep.delegation_id), "read permissions").map((p) => p.permission);
    for (const p of ADMIN_PERMISSIONS.filter((p) => !perms.includes(p))) {
      note("add", `delegation permission ${p}`);
      if (APPLY) must(await db.from("delegation_permissions").insert({ delegation_id: keep.delegation_id, permission: p }), "add permission");
    }
  } else {
    note("create", `${presAdmin.email}: delegation over the presentation project only, permissions ${ADMIN_PERMISSIONS.join(", ")}, valid 1 year`);
    if (APPLY) {
      const now = new Date();
      const created = must(
        await db
          .from("admin_delegations")
          .insert({
            admin_user_id: adminUserId,
            delegate_user_id: presAdmin.userId,
            status: "Active",
            starts_at: now.toISOString(),
            ends_at: new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString(),
            reason: "Presentation Admin for Demo Login (presentation project only)",
          })
          .select("delegation_id")
          .single(),
        "create delegation"
      );
      must(await db.from("delegation_projects").insert({ delegation_id: created.delegation_id, project_id: projectId }), "delegation project");
      must(await db.from("delegation_permissions").insert(ADMIN_PERMISSIONS.map((permission) => ({ delegation_id: created.delegation_id, permission }))), "delegation permissions");
    }
  }

  // Verify isolation (what lib/demoAccess.ts demoProjectsIsolated enforces)
  if (!projectId.startsWith("(")) {
    const members = must(await db.from("user_project_roles").select("users(user_mail)").eq("project_id", projectId).eq("status", "Active"), "verify members");
    const real = members.filter((m) => !isDemoEmail((Array.isArray(m.users) ? m.users[0] : m.users)?.user_mail));
    if (real.length > 0) throw new Error(`presentation project has ${real.length} non-demo member(s) — Demo Login would refuse it`);
    note("check", `presentation project members: ${members.length}, all @example.com`);
  }

  console.log(plan.join("\n"));
  console.log(`\nDEMO_PROJECT_IDS=${projectId}`);
  if (!APPLY) console.log("\nDry run only. Re-run with --apply to make these changes.");
}

main().catch((err) => {
  console.log(plan.join("\n"));
  console.error(`\nSTOPPED: ${err.message}`);
  process.exit(1);
});
