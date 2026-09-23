// Seeds work_items.additional_fields.__tasks from supabase/seed/work-item-tasks.json.
//
//   node scripts/seed-work-item-tasks.mjs          dry run (validates everything, writes nothing)
//   node scripts/seed-work-item-tasks.mjs --apply  writes
//
// Safety: every entry is matched by line_item_no AND its description must
// match the database row (case/whitespace/dash-insensitive). Any entry that
// cannot be matched aborts the whole run before anything is written. Rows
// not listed in the data file (e.g. the imported GRAND TOTALS / Legend
// footer rows) are never touched. Only the "__tasks" key of
// additional_fields is set; every other key is preserved.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const apply = process.argv.includes("--apply");

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const slug = (label) =>
  label
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const data = JSON.parse(fs.readFileSync("supabase/seed/work-item-tasks.json", "utf8"));

// Build task objects with stable, unique-per-work-item ids.
const planned = data.items.map((item) => {
  const seen = new Map();
  const tasks = item.tasks.map((t) => {
    const label = typeof t === "string" ? t : t.label;
    const conditional = typeof t === "string" ? false : t.conditional === true;
    let id = slug(label);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    return { id, label, conditional };
  });
  return { ...item, tasks };
});

const { data: rows, error } = await db
  .from("work_items")
  .select("work_item_id, line_item_no, description_of_work, additional_fields");
if (error) throw new Error(`Failed to read work_items: ${error.message}`);

const problems = [];
const writes = [];
for (const item of planned) {
  const matches = rows.filter(
    (r) => r.line_item_no === item.lineItemNo && norm(r.description_of_work) === norm(item.description)
  );
  if (matches.length === 0) {
    const byNo = rows.filter((r) => r.line_item_no === item.lineItemNo);
    problems.push(
      `No match for ${item.lineItemNo} "${item.description}"` +
        (byNo.length ? ` (DB has: ${byNo.map((r) => `"${r.description_of_work}"`).join(", ")})` : " (no such line item)")
    );
    continue;
  }
  if (item.tasks.length === 0) problems.push(`${item.lineItemNo} has no tasks`);
  for (const row of matches) writes.push({ row, item });
}
const dupNos = planned.map((i) => i.lineItemNo).filter((n, i, a) => a.indexOf(n) !== i);
if (dupNos.length) problems.push(`Duplicate line items in data file: ${dupNos.join(", ")}`);

if (problems.length) {
  console.error("ABORTING - nothing written:\n  " + problems.join("\n  "));
  process.exit(1);
}

console.log(`${planned.length} data entries validated against ${writes.length} database rows.`);
let written = 0;
if (!apply) console.log("Dry run only. Re-run with --apply to write.");
for (const { row, item } of apply ? writes : []) {
  const merged = { ...(row.additional_fields ?? {}), __tasks: item.tasks };
  const { error: upErr } = await db
    .from("work_items")
    .update({ additional_fields: merged })
    .eq("work_item_id", row.work_item_id);
  if (upErr) throw new Error(`Failed writing ${item.lineItemNo}: ${upErr.message}`);
  written += 1;
}
if (apply) console.log(`Wrote __tasks to ${written} work items.`);
