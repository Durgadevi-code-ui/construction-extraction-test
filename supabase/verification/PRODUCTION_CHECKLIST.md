# Production security checklist

For the deployment review of the security changes. Nothing here has been
run against production. Every step is read-only unless it says **CHANGE**,
and each CHANGE needs an explicit go-ahead.

## Order of operations

1. **Before deploying:** run `security_review.sql` (read-only) in the Supabase
   SQL editor for the production project. Save the output as the "before" state.
2. Confirm `SUPABASE_SERVICE_ROLE_KEY` is set for Production (and Preview, if used)
   in Vercel. The app now uses it for every table, not just live updates and chat.
   If it is missing, every API route returns a generic 500.
3. **CHANGE: deploy the code.** Behavior is unchanged while the anon policies
   still exist.
4. Smoke-test each role: Worker (text, voice, handwritten, live-update
   photo/voice, confirmation step), Subcontractor/Foreman review, Contractor
   approval and dashboard, and Admin setup, workbook import and export.
5. **CHANGE: apply `00000000000022_lock_core_tables_service_role_only.sql`** to
   staging first, repeat step 4, then apply it to production.
6. **CHANGE: apply `00000000000023_rate_limits.sql`**, then set
   `RATE_LIMIT_BACKEND=supabase` in Vercel and redeploy.
7. Re-run `security_review.sql` and compare it with the "before" output.

The reverse order (migration 22 before the code) breaks the app, because the
old code reads these tables with the anon key.

## Supabase (`security_review.sql`)

What each section of the output should show after the migrations:

| Section | Expected |
|---|---|
| 1. RLS per table | `rls_enabled = true` on every app table |
| 2. Policies | No policy whose `roles` include `anon`, `authenticated` or `public`. Check every `unconditional = true` row. |
| 3. Table grants | No rows |
| 4. Executable functions | No rows |
| 5. Buckets | `public = false` for handwritten, voice, live-updates, project-documents |
| 6. Rate limiting | Table exists, RLS on, service_role can execute, anon cannot |
| 7. Expected tables | All exist (otherwise check for a renamed table) |

Also check in the dashboard (Authentication → Rate Limits) that Supabase Auth's
own limits are on. They complement, but don't replace, the app's per-IP and
per-email login limits.

## Vercel

Use the dashboard (or `vercel env ls production`, which lists names only). Don't
print values.

- **`DEMO_MODE`**: must be absent or not exactly `true` in **Production**.
  If it is `true`, the role-picker login on `/login` works for anyone. Also
  confirm no `DEMO_USER_*_EMAIL` variables are set in Production.
- **`RATE_LIMIT_BACKEND`**: `supabase` once migration 23 is applied. While it is
  unset, rate limiting is off (the app logs a one-time warning).
- **`SUPABASE_SERVICE_ROLE_KEY`**: present, and never in a `NEXT_PUBLIC_*` variable.
- **`SUBMISSION_TOKEN_SECRET`** (optional): a random value of at least 32
  characters, if review tokens should not be derived from the service-role key.
- **Deployment Protection**: Settings → Deployment Protection. Preview
  deployments should require Vercel Authentication. They use real
  environment variables, so an unprotected preview URL exposes a full copy of
  the app.
- **Firewall (optional)**: a Vercel WAF rate-limit rule on `/login` and
  `/api/admin/bootstrap` adds edge-level protection on top of the app's limits.

### Response headers on the deployed site

```sh
curl -sI https://<production-domain>/login
```

Expect:

- `Content-Security-Policy` with `default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'self'` and `upgrade-insecure-requests`
- `Strict-Transport-Security`
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy`
- `Permissions-Policy` with `camera=(self), microphone=(self)`

Then open the site and the browser console as a signed-in Worker, take a
live-update photo, record voice, and view the live-update feed. The console
should show no "Content Security Policy" errors.

### Access checks on the deployed site

- Signed out, `/dev/extraction-test`, `/workflow`, `/admin/setup` and `/account`
  should redirect to `/login`.
- Signed out, `POST /api/text`, `/api/voice`, `/api/handwritten`,
  `/api/user-validation` and `/api/workflow/live-updates` should return 401.
- `POST /api/admin/bootstrap` should be refused, since an Admin already exists.
