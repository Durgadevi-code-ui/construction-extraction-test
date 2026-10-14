# Production security checklist

For whoever applies the database changes and changes Vercel settings. Current
state:

- **Done:** app commit `7fbe06f` is deployed to both Vercel production projects
  and confirmed working with the service-role key.
- **Not done:** migrations 22 and 23. Rate limiting is off.
- **Demo login:** removed from the code (no demo UI, server action or
  `DEMO_*` handling). Deployments built before the removal still contain it
  and `DEMO_MODE` is still set in both projects — see section 5.
- **Supabase project:** `adqerwabeihdbhldzgba`, used by both Vercel projects.

Use the **working-tree** copies of the SQL files. They are newer than the
copies in `7fbe06f`: each now runs in one explicit transaction, skips (and
reports) objects `postgres` does not own instead of failing, and migration 23
reloads the API schema cache.

## 1. Before running anything

1. Dashboard → Database → Backups: confirm a backup from today exists, or that
   Point-in-Time Recovery is enabled. Note the current time. Migration 22
   changes permissions, not data (apart from each bucket's `public` flag), so
   PITR is only a last resort: restoring it would also undo every write since.
2. SQL editor: run `supabase/verification/security_review.sql` (read-only) and
   save **all** of its output. Section 2 is the exact record of every policy that
   migration 22 drops.
3. Optional: if `ROLLBACK` appears as the last line of that output, nothing was
   changed. It always should.

## 2. Execution order

| Step | Where | Action | Expected |
|---|---|---|---|
| 1 | SQL editor | Run `00000000000022_lock_core_tables_service_role_only.sql` | `COMMIT`. Read every `WARNING` line (see below). |
| 2 | Browser | Sign in on both sites and open one Worker page and the Admin setup page | Loads normally |
| 3 | SQL editor | Run `00000000000023_rate_limits.sql` | `COMMIT` |
| 4 | SQL editor | Run `supabase/verification/post_migration_checks.sql` | All expectations met; last statement fails with `permission denied for table users` |
| 5 | Vercel (both projects) | Add `RATE_LIMIT_BACKEND=supabase` (Production), then redeploy | See section 4 |
| 6 | Terminal | External anon probe (section 3) | 401 or `42501` for every table |
| 7 | Both sites | Smoke tests (section 6) | All pass |

Never set `RATE_LIMIT_BACKEND=supabase` before step 3. Without the function, the
upload, extraction and workbook routes answer 503 by design.

### Warnings from migration 22

- `NOT DROPPED (not owner): storage policy …` means `postgres` can't drop that
  `storage.objects` policy. Delete it under Dashboard → Storage → Policies. This
  matters: a private bucket still serves files to anyone a policy allows.
- `RLS NOT ENABLED` or `STILL REACHABLE … spatial_ref_sys` (or another extension
  table) is extension reference data. Acceptable if it holds no app data;
  otherwise ask the extension owner to fix it.
- `no privileges were granted/revoked for "<function>"` refers to an extension
  function `postgres` doesn't own. Section C of `post_migration_checks.sql`
  lists any that remain executable.
- `BUCKETS NOT UPDATED`: set the buckets to private under Storage → Settings.

## 3. External anon probe (after step 4)

Run on a machine that has `.env.local`. It prints only status codes.

```sh
node -e '
const fs=require("fs");const e=Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.split("=")[0],l.slice(l.indexOf("=")+1).replace(/^"|"$/g,"")]));
const k=e.NEXT_PUBLIC_SUPABASE_ANON_KEY,h={apikey:k,Authorization:"Bearer "+k};
(async()=>{for(const t of ["users","user_project_roles","projects","work_items","extraction_submissions","companies","departments","unified_records","user_validations","rate_limit_counters"]){
 const r=await fetch(`${e.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${t}?select=*&limit=1`,{headers:h});const b=await r.json().catch(()=>({}));
 console.log(t.padEnd(24),r.status,b.code??(Array.isArray(b)?"ROWS RETURNED - STILL OPEN":""));}
 const r=await fetch(`${e.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/rate_limit_hit`,{method:"POST",headers:{...h,"content-type":"application/json"},body:"{\"p_key\":\"x\",\"p_window_seconds\":60}"});
 console.log("rpc rate_limit_hit".padEnd(24),r.status);})()'
```

For every line, expect `401 42501` (permission denied) or `404`. Any `ROWS RETURNED`
line means that table is still open.

## 4. Vercel settings

Set these in **both** `construction-extraction-test` and
`construction-extraction-test-rnld`, under Settings → Environment Variables →
Production:

| Variable | Value | Notes |
|---|---|---|
| `RATE_LIMIT_BACKEND` | leave unset | Since the follow-up to `7fbe06f`, an unset value means `supabase` in Vercel production (migration 23 is applied). Set `off` only as an emergency kill switch. |
| `SUPABASE_SERVICE_ROLE_KEY` | (existing) | Confirmed working. Must never have a `NEXT_PUBLIC_` prefix. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | (existing) | Leave unchanged |
| `DEMO_MODE` | delete it | Demo login is removed from the code, which no longer reads it; deleting it removes the last trace |
| `DEMO_USER_*_EMAIL` | delete them | Same time as `DEMO_MODE` |
| `SUBMISSION_TOKEN_SECRET` | optional: random, at least 32 characters | Setting it voids pending confirmations (users resubmit) |
| `RATE_LIMIT_TRUST_PROXY_HEADERS` | **do not set** | Vercel's own headers are already trusted |

Environment changes only take effect in a **new** deployment: Deployments →
latest Production → ⋯ → Redeploy (without the build cache is fine), in each
project. Then confirm with
`curl -s https://<site>/login | grep -c "Demo Mode"` (expect `0` once demo mode is
off).

## 5. Turning off public demo Admin access

Demo login is removed from the code, so any deployment built from it has no
demo path whatever the environment says. Deployments built **before** the
removal still have it (Preview ones honor `DEMO_MODE`) and keep the
environment they were built with, so changing variables does not fix them.

1. Remove or protect every pre-removal deployment that is publicly
   reachable, including any alias with a Deployment Protection exception
   (e.g. a `-git-<branch>-` alias that answers without Vercel SSO).
2. In both Vercel projects, delete `DEMO_MODE` and every `DEMO_USER_*_EMAIL`
   variable from Production and Preview.
3. Redeploy both projects, then confirm `/login` no longer shows "Demo Mode".
4. Existing demo sessions keep working until their access token expires (the
   Supabase JWT expiry, 1 hour by default). Refresh tokens keep them signed in
   longer. To end them now, delete those users' rows in `auth.sessions`, which
   is a deliberate write in the SQL editor:
   `delete from auth.sessions where user_id in (select id from auth.users where email in ('<demo emails>'));`
5. If the demo accounts themselves are no longer needed, deactivate their
   assignments in Admin Setup → Users. That is reversible; deleting accounts is not.

## 6. Smoke tests (both sites)

Signed out:

- [ ] `/workflow`, `/admin/setup`, `/account` and `/dev/extraction-test` redirect to `/login`.
- [ ] `POST` to `/api/text`, `/api/voice`, `/api/handwritten`,
  `/api/user-validation` and `/api/workflow/live-updates` returns 401.
- [ ] `curl -sI https://<site>/login` shows CSP, HSTS, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`.
- [ ] `POST /api/admin/bootstrap` answers "An Admin account already exists".

Signed in (real accounts, or demo while it is still on):

- [ ] Worker: the dashboard loads; text, voice and handwritten updates submit and
  confirm; a live-update photo and voice note upload and appear in the feed.
- [ ] Subcontractor: the review queue loads, and a comment or forward works.
- [ ] Contractor: approve or reject, the dashboard, and the Excel export download.
- [ ] Admin: setup pages load; a workbook import preview works (dry run; don't
  commit unless intended).
- [ ] Chat: a Team message and a direct message send and appear for the other
  party in the same project only.
- [ ] Browser console: no "Content Security Policy" errors on any page above.

Rate limiting (after step 5):

- [ ] Eleven wrong-password logins for one email within 10 minutes. The 11th says
  "Too many requests…". This is safe: it only affects that email for 10 minutes.
- [ ] The `rate_limit_counters` table count increases (the SQL editor shows it).

Finally, re-run `security_review.sql` and compare it with the saved "before" output.

## 7. Recovery

| Problem | Action |
|---|---|
| A migration errors | Nothing was applied (single transaction). Fix the cause and run it again. |
| App errors after 22 with "Something went wrong on the server" | Check `SUPABASE_SERVICE_ROLE_KEY` in that Vercel project and that the deployment is `7fbe06f` or later. Don't reopen the tables. |
| Something outside the app needed anon access | Run `supabase/verification/emergency_reopen_core_tables.sql` (this **reopens the vulnerability**). Fix that consumer, then re-run migration 22. Both directions are tested. |
| Login or uploads answer 503 after enabling rate limiting | `RATE_LIMIT_BACKEND` was set but the RPC is unreachable. Confirm migration 23 is applied (section C of `post_migration_checks.sql`). For a quick fix, delete `RATE_LIMIT_BACKEND` and redeploy (rate limiting goes off; login is never blocked by this). |
| Data damaged (not expected from either migration) | Point-in-Time Recovery to just before step 1. |
