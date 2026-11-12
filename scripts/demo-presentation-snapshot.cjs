/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI; loads the app's TypeScript through tests/register-ts.cjs. */
/**
 * Snapshot / reseed safeguard CLI for the ISOLATED presentation project(s).
 *
 *   node --require ./tests/register-ts.cjs scripts/demo-presentation-snapshot.cjs snapshot --out <file.json>
 *   node --require ./tests/register-ts.cjs scripts/demo-presentation-snapshot.cjs restore  --in  <file.json>            # DRY RUN (plan only, no writes)
 *   node --require ./tests/register-ts.cjs scripts/demo-presentation-snapshot.cjs restore  --in  <file.json> --apply    # writes baseline values
 *   node --require ./tests/register-ts.cjs scripts/demo-presentation-snapshot.cjs restore  --in  <file.json> --apply --prune  # also removes demo drift rows
 *
 * SAFETY:
 *   - Every operation is isolation-gated (lib/demoSnapshot.ts
 *     assertIsolatedDemoProject): it refuses any project not in the
 *     configured DEMO_PROJECT_IDS, or any project with a real (@-not-example.com)
 *     member. It can never read or write real client data.
 *   - `restore` is a DRY RUN unless `--apply` is passed; pruning drift rows
 *     needs `--apply --prune`. A one-line audit record is printed for every run.
 *   - `snapshot` is read-only.
 *
 * It reads the SAME Supabase project as .env.local (shared by local and
 * production), so a WRITE (`--apply`) touches real presentation rows. Capture
 * a baseline and keep a dry run clean before ever applying.
 */
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
// Load .env.local (real settings win over the test loader's placeholders).
for (const line of fs.readFileSync(path.join(REPO, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const { getSupabaseServiceRoleClient } = require(path.join(REPO, "lib/supabaseAdmin.ts"));
const { demoLoginConfig } = require(path.join(REPO, "lib/demoAccess.ts"));
const {
  snapshotPresentationProject,
  planRestore,
  applyRestore,
} = require(path.join(REPO, "lib/demoSnapshot.ts"));

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(name);

function audit(record) {
  console.log(`[demo-safeguard] ${JSON.stringify({ at: new Date().toISOString(), ...record })}`);
}
function stop(message) {
  console.error(`demo-presentation-snapshot: ${message}`);
  process.exit(1);
}

async function main() {
  const config = demoLoginConfig();
  const allowed = config.projectIds;
  if (allowed.size === 0) stop("No DEMO_PROJECT_IDS configured — nothing is treated as a presentation project.");
  const admin = getSupabaseServiceRoleClient();

  if (command === "snapshot") {
    const out = flag("--out");
    if (!out) stop("snapshot requires --out <file.json>");
    const snapshots = [];
    for (const projectId of allowed) {
      const snap = await snapshotPresentationProject(admin, projectId, allowed);
      snapshots.push(snap);
      audit({ op: "snapshot", projectId, departments: snap.departments.length, workItems: snap.workItems.length, dependencies: snap.dependencies.length });
    }
    fs.writeFileSync(out, JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), snapshots }, null, 2));
    audit({ op: "snapshot-written", file: out, projects: snapshots.length });
    return;
  }

  if (command === "restore") {
    const inFile = flag("--in");
    if (!inFile) stop("restore requires --in <file.json>");
    const apply = has("--apply");
    const prune = has("--prune");
    const parsed = JSON.parse(fs.readFileSync(inFile, "utf8"));
    const snapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : [parsed];
    for (const snap of snapshots) {
      if (!apply) {
        const plan = await planRestore(admin, snap, allowed);
        audit({ op: "restore-dryrun", ...plan, wouldPrune: prune });
      } else {
        const result = await applyRestore(admin, snap, allowed, { prune });
        audit({ op: "restore-applied", ...result });
      }
    }
    if (!apply) audit({ op: "restore-dryrun-complete", note: "no writes performed — pass --apply to write" });
    return;
  }

  stop(`unknown command "${command ?? ""}". Use: snapshot | restore`);
}

main().catch((err) => {
  console.error("[demo-safeguard] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
