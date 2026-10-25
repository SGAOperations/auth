# Runbook: rotate secrets

Applies to every secret SGAuth holds. [ENVIRONMENTS.md](../ENVIRONMENTS.md) lists
where each one is set. This runbook covers `BETTER_AUTH_SECRET`, the Resend key,
the Upstash token, the Neon role passwords, `CRON_SECRET` and the JWKS signing
key.

## When to rotate

- **JWKS signing key:** once a year.
- **Any secret, immediately:** on suspected exposure, when a person with access
  leaves, or when a value reaches a log or a preview build.
- Rotate `dev` first, then production. The `dev` run is the rehearsal.

## Who

An SGA operator with Vercel project admin, plus Neon, Upstash and Resend access
as needed. Tell a second operator before every production rotation.

## Rules for every rotation

- **Each Vercel scope gets its own new value.** Never reuse one across
  Production, `dev` and Preview. See the rules in
  [ENVIRONMENTS.md](../ENVIRONMENTS.md#environment-variables).
- Generate values with `npx @better-auth/cli secret`, or in the provider's
  console.
- To run a script against an environment, pull its variables to a file **outside
  the repository** with
  `vercel env pull <file> --environment=<production|preview|development> [--git-branch dev]`,
  load them, and delete the file after use.
- **Never paste a value** into a terminal command line, an issue, a pull request
  or chat. Values live in Vercel, the provider and the team password manager.
- Environment changes need a redeploy (Vercel, Redeploy latest on that branch).
- After each rotation, read the build log and the first minutes of runtime logs
  and confirm no secret value appears in them.
- Record the rotation in the [rotation log](#rotation-log).

## Inventory

| Secret                                      | Lives in                                                       | Consumers                                                     | Effect of rotating                                                        | Procedure                                   |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS` | Vercel (per scope)                                             | Session and preview-gate cookies, encrypted Jwks and 2FA data | All users sign in again                                                   | [Better Auth secret](#better_auth_secret)   |
| `RESEND_API_KEY`                            | Vercel, and the Actions secret used by the quota monitor       | Transactional email                                           | Email fails until the redeploy if the old key is revoked first            | [Resend key](#resend-key)                   |
| `UPSTASH_REDIS_REST_TOKEN`                  | Vercel (per scope)                                             | Rate limiting                                                 | Rate limiting fails open until the redeploy                               | [Upstash token](#upstash-token)             |
| Neon `runtime` and `migration` passwords    | Vercel (`DATABASE_URL`, `DIRECT_URL`) and the password manager | The app and every script                                      | Database errors until the redeploy                                        | [Neon role passwords](#neon-role-passwords) |
| `CRON_SECRET`                               | Vercel and the Actions secret for the job workflows (#50)      | `/api/jobs/*` and its callers                                 | Scheduled jobs fail between the two updates                               | [CRON_SECRET](#cron_secret)                 |
| JWKS signing key                            | The `Jwks` table, published at `/.well-known/jwks.json`        | Every Supabase-backed product                                 | None for users, if the steps run in order                                 | [JWKS rotation](#jwks-rotation)             |
| Vercel bypass secrets                       | Vercel                                                         | Automation                                                    | See [ENVIRONMENTS.md](../ENVIRONMENTS.md#deployment-protection-exception) | Procedure in ENVIRONMENTS.md                |

## `BETTER_AUTH_SECRET`

Better Auth encrypts at rest with this secret: the private keys in the `Jwks`
table, and every enrolled user's TOTP secret and backup codes. **Replacing
`BETTER_AUTH_SECRET` with a new value would leave all of that undecryptable**
(`/api/auth/token` would fail and every enrolled user's TOTP would break). So a
rotation never swaps it. It adds a version to `BETTER_AUTH_SECRETS`, the
versioned list Better Auth supports: the first entry signs and encrypts, the
others only decrypt, and `BETTER_AUTH_SECRET` stays set to its original value to
decrypt data written before the first rotation.

**Effect:** every session cookie and preview-gate cookie becomes invalid, so
**all users sign in again**. Schedule it in a low-usage window (not during an
application cycle) and announce it.

Steps:

1. Read the current `BETTER_AUTH_SECRETS` for the scope, if any.
2. First rotation: set `BETTER_AUTH_SECRETS="1:<new>"` and leave
   `BETTER_AUTH_SECRET` unchanged. Later rotations: prepend `<n+1>:<new>` and keep
   every older entry. Each secret is 32 or more characters. A malformed value
   stops the app at boot, naming the entry number and never the value.
3. Redeploy.

Verify:

- A sign-in works.
- An account enrolled in TOTP passes TOTP.
- `npm run jwks:rotate -- status` shows `decrypts=yes` on every key.
- `/api/auth/token` returns a token for a signed-in session.

**Never remove an old version, and never change `BETTER_AUTH_SECRET`.** TwoFactor
rows still decrypt with the version that wrote them. After an exposure, also do a
full [JWKS rotation](#jwks-rotation), so the signing key is encrypted under the
new version, and reset 2FA for admins (see Limits below).

Limits: Better Auth does not re-encrypt existing TwoFactor rows on rotation.
Someone holding an old secret and a copy of the database could still read those
seeds. A re-encryption script is a follow-up.

## Resend key

1. In SGAuth's own Resend account, create a new sending-only key restricted to
   `auth.northeasternsga.com`.
2. Update `RESEND_API_KEY` in the Vercel scope(s) and in the Actions secret.
3. Redeploy and send a test email (a password-reset request for a synthetic
   account).
4. Revoke the old key.

## Upstash token

Rotating the token in the Upstash console invalidates the old one at once, and
rate limiting **fails open** until the redeploy, so do it in a low-usage window.

1. Rotate the token in the Upstash console for that environment's database.
2. Update `UPSTASH_REDIS_REST_TOKEN` in that environment's scope only (each
   environment has its own database), and redeploy.
3. Confirm no `rate_limit_unavailable` alerts follow.

## Neon role passwords

1. On the branch, reset the role's password (Neon console, Roles, Reset
   password; or the API `POST /projects/{id}/branches/{branch_id}/roles/{role}/reset_password`).
   The old password stops working at once.
2. Update the matching `DATABASE_URL` or `DIRECT_URL` in Vercel and in the
   password manager. Keep `sslmode=verify-full`.
3. Redeploy right away. Expect database errors until it is live.
4. Rotate the `dev` and `test` branch roles the same way and update the CI
   secrets listed in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## `CRON_SECRET`

1. Pick a moment between scheduled runs.
2. Update the Vercel scope and the Actions secret together, then redeploy.
3. Re-run any job that failed in between by hand (`workflow_dispatch`).

## JWKS rotation

SGAuth signs tokens with ES256 keys held in the `Jwks` table. Rotation is
manual, and there is no `rotationInterval`: a Supabase project learns of a new
key only when it re-fetches the JWKS, and an automatic rotation would reject
fresh tokens until then. The four steps stage the new key, give it to every
Supabase project, switch signing, and later remove the old key.

How it works: Better Auth signs with the newest live key and publishes every
key until its `expiresAt` plus the grace period. A staged key carries a sentinel
`createdAt`, so it is published but never the newest. `activate` moves its
`createdAt` to now and expires the old signer, which stays published for the
7-day grace period so tokens it already signed keep verifying.

Prerequisites:

- The staged-rotation tool (`scripts/jwks-rotate.ts`) is deployed with the
  environment you are rotating.
- Variables for that scope, pulled outside the repository: `DIRECT_URL`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS` (when set) and `SGAUTH_ENV`.
- A Supabase personal access token in `SUPABASE_ACCESS_TOKEN`, local to you.
  Never set it in Vercel, `.env.example` or the repository.
- The project ref of every product project that trusts SGAuth.
- After any `better-auth` upgrade, run the database tests
  (`prisma/seed/jwks-rotation.db.test.ts`) first: the tool relies on Better
  Auth's key-selection rule and its secret envelope.

Every write command is a dry run until you add `--apply`, and refuses to write
when the secret in your environment does not decrypt the signing key (it is not
the one the server uses).

**Step 0. Check the state.** `npm run jwks:rotate -- status`. Expect one
`active` key with `decrypts=yes`.

**Step 1. Stage.** `npm run jwks:rotate -- stage`, then again with `--apply`.
`status` now shows the `staged` key, and `/.well-known/jwks.json` lists both key
ids once the staged key is served.

**Step 2. Give the key to every Supabase project.**

```
npm run supabase:push-jwks -- --issuer <issuer> --project-ref <ref> [--project-ref <ref> ...]
npm run supabase:push-jwks -- --issuer <issuer> --project-ref <ref> [...] --apply
```

For a project registered with an inline `custom_jwks` key set, the script
creates a new integration with the live key set, waits for `resolved_jwks` to
list every key, and only then deletes the old one. If the new one never
resolves, it deletes the new one and leaves the old ones in place. For a project
registered by issuer URL or JWKS URL (the default of #93), Supabase re-fetches
the keys itself within about 30 minutes, so the script only verifies.

Exit codes: 0, every project verified; 1, an input or API error; 2, not verified
yet. **Do not switch before every project exits 0.** If an issuer-bound project
exits 2, wait and re-run.

**Step 3. Switch.**

```
npm run jwks:rotate -- activate --issuer <issuer>
npm run jwks:rotate -- activate --issuer <issuer> --apply
```

The command refuses unless the staged key is in the public JWKS at
`<issuer>/.well-known/jwks.json`. New tokens carry the new `kid`: decode the
header of a fresh `/api/auth/token` response to check. The old key stays
published for 7 days. The command prints the date to retire it.

**Step 4. Retire, 7 or more days later.**

```
npm run jwks:rotate -- retire --kid <old kid>
npm run jwks:rotate -- retire --kid <old kid> --apply
```

The command refuses unless the key is expired and past its grace period, and
unless an active signer remains. Then run the `supabase:push-jwks` command again
so inline integrations drop the old key.

If a step fails: before step 3 nothing has changed for users, so fix the cause
and re-run. After step 3, never delete the new key. If Supabase rejects tokens,
re-run the push.

Notes:

- The staged key's `createdAt` is a sentinel, not the time it was made. Record
  the real time in the rotation log.
- If the jwt plugin's `gracePeriod` is ever set below 7 days, the old key leaves
  the JWKS before it can be retired. That is harmless for 10-minute tokens, but
  update the constants in `src/lib/auth/jwt-constants.ts` and this runbook
  together.
- `activate` writes a `JWKS_ROTATED` audit event. `stage` and `retire` write
  none: neither changes what a verifier sees.

## Dev dry run

Run this on `dev` against a throwaway Supabase project before every production
rotation. It is also the acceptance procedure for this runbook.

1. Register the throwaway project twice with #93's script (or curl): once with
   an inline `custom_jwks` set and once by issuer URL, so both paths run.
2. Create one RLS-protected test table, readable `to authenticated`.
3. Start a probe in a second terminal. Every 10 seconds it fetches a token from
   `https://auth-dev.northeasternsga.com/api/auth/token` with a synthetic user's
   session cookie, calls the project's PostgREST endpoint for that table with
   `Authorization: Bearer <token>`, and logs the status code and the token's
   `kid`.
4. Run steps 0 to 3 above against `dev`. At each step `status` shows the roles
   described, and the push exits 0 for the project.
5. Keep the probe running for 15 minutes after the switch. **Every request must
   return 200**, and the logged `kid` must change from old to new exactly once.
   Record the count of non-200 responses (it must be 0).
6. Confirm a token minted with the old `kid` just before the switch is still
   accepted after it.
7. After 7 days (or, on `dev` only, by moving the old key's `expiresAt` back and
   noting it in the log), run step 4. The push shows the old integration
   replaced, and `resolved_jwks` lists only the new `kid`.
8. Read the build log and the script output from the run. No secret, token,
   connection string or private key may appear.

## Rotation log

| Date | Environment | Secret | Operator | Second operator | Verified    |
| ---- | ----------- | ------ | -------- | --------------- | ----------- |
| n/a  | n/a         | n/a    | n/a      | n/a             | Not yet run |
