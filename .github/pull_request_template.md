## What and why

<!-- What does this change, and why? Link the issue or task. -->

## How it was tested

<!-- Commands run, screens checked, roles used. "Security checks" must be green. -->

## Security checklist

- [ ] Every new or changed API route checks the session (`getCurrentUser()`) and returns 401 without one.
- [ ] Authorization is enforced on the server (role, project, department, assignment), not only hidden in the UI, and uses the existing helpers in `lib/authContext.ts`, `lib/delegation.ts` and `lib/workflow.ts`.
- [ ] Ids from the request (project, department, work item, user) are checked against the caller's scope before anything is read or written.
- [ ] Input is validated on the server (types, lengths in `lib/inputLimits.ts`, file signatures in `lib/fileSignature.ts`).
- [ ] Errors go through `jsonError` (`lib/apiErrors.ts`); no database detail, ids or stack traces reach the client.
- [ ] No secrets, keys or real user data are committed; any new environment variable is added to `.env.example` (name only).
- [ ] Database changes are a new migration under `supabase/migrations/` and keep tables unreachable with the anon key.
- [ ] New security-relevant behavior has a test in `tests/`.

## Deployment notes

<!-- Environment variables, migrations, or Vercel/Supabase settings that must change. "None" if none. -->
