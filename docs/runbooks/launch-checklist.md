# Runbook: production launch checklist and Primary Admin bootstrap

Run this once, before the first SGA product goes live on SGAuth. The operator
works through it with the future Primary Admin, and the Primary Admin signs it
off by commenting on [#103](https://github.com/SGAOperations/auth/issues/103).

Every item says how to verify it and what to record. Record outputs, never
credentials: no `DIRECT_URL`, no API key, no backup code ever goes in a comment.

## Prerequisites

The checklist cannot be completed until these have landed. Each section below
names the one it needs.

| Needs                                 | Ticket                                                         |
| ------------------------------------- | -------------------------------------------------------------- |
| Threat model and pre-launch checklist | [#84](https://github.com/SGAOperations/auth/issues/84)         |
| Security headers                      | [#78](https://github.com/SGAOperations/auth/issues/78)         |
| Health endpoint and uptime monitor    | [#88](https://github.com/SGAOperations/auth/issues/88)         |
| Break-glass recovery                  | [#51](https://github.com/SGAOperations/auth/issues/51)         |
| Escalating account lockout            | [#76](https://github.com/SGAOperations/auth/issues/76)         |
| TOTP enrolment                        | #79 and [#66](https://github.com/SGAOperations/auth/issues/66) |

Production sign-up and email verification must work before section 7
([#29](https://github.com/SGAOperations/auth/issues/29),
[#32](https://github.com/SGAOperations/auth/issues/32)), which is why the email
items come first.

## 1. DNS and email

- [ ] `auth.northeasternsga.com` resolves to Vercel and is assigned as the
      production domain ([ENVIRONMENTS.md](../ENVIRONMENTS.md), "Console
      settings"). Verify: `nslookup auth.northeasternsga.com`, then open
      `https://auth.northeasternsga.com` and check the certificate.
- [ ] SPF, DKIM and DMARC (`p=quarantine`) are verified on
      `mail.northeasternsga.com` in Resend ([EMAIL.md](../EMAIL.md)). Verify: the
      domain shows **Verified** in the Resend dashboard.
- [ ] A test mail to a Gmail address and an Outlook address lands in the inbox
      with aligned DMARC. Verify: in each client, show the original message and
      read `dmarc=pass`. Record: both results.

## 2. Production environment variables

- [ ] Every Production-column row of [ENVIRONMENTS.md](../ENVIRONMENTS.md),
      "Environment variables", is set in the Vercel Production environment: - `DATABASE_URL` and `DIRECT_URL`, both `sslmode=verify-full` - `SGAUTH_ENV=production` - `BETTER_AUTH_SECRET` - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` - `RESEND_API_KEY` and `RESEND_FROM_EMAIL` - `POSTHOG_KEY` and `POSTHOG_HOST` - `CRON_SECRET`

      Verify: `vercel env ls production`, comparing names against the table.

- [ ] No value is shared with `dev` or Preview. Verify: the secrets differ, and
      `DATABASE_URL` and `DIRECT_URL` point at the Neon `main` branch only.
- [ ] `SEED_PRIMARY_ADMIN_*`, `SGAUTH_PREVIEW_GATE*` and
      `SGAUTH_SIGNUP_ALLOWLIST` are **not** set in Production. The env schema
      refuses the seed keys outside `local`. Verify: they are absent from
      `vercel env ls production`.
- [ ] `SGAUTH_CSP_MODE` is recorded, and so is whether the #78 enforce flip has
      happened. Record: the value and the date of the flip, or "report-only".

## 3. Neon

- [ ] History retention on `main` is confirmed in the Neon console and recorded.
      It is 6 hours on the Free plan ([neon-restore.md](neon-restore.md),
      [neon-upgrade.md](neon-upgrade.md)). Record: the retention shown.
- [ ] The `runtime` and `migration` roles exist with the privileges described in
      the README ("Neon branches and roles"). Verify: the roles list in the
      console.
- [ ] `_prisma_migrations` matches the deployed commit. Verify: the newest
      directory under `prisma/migrations/` at the deployed commit is the last
      row of `_prisma_migrations` on `main`, with a `finished_at` and no
      `rolled_back_at`.

## 4. Services

- [ ] The Upstash production database is separate from `dev`
      ([RATE-LIMITING.md](../RATE-LIMITING.md)). Verify: the endpoint host in
      Vercel Production differs from the one in Preview (`dev`).
- [ ] The Resend production key is the one in Vercel Production, restricted to
      sending from `auth.northeasternsga.com`.
- [ ] A PostHog project exists for production, and its host is allowed by the
      CSP once #87 has landed. Record: the project name.
- [ ] The uptime monitor from #88 is live against
      `https://auth.northeasternsga.com/api/health` and alerts the admins.
      Verify: pause the check or point a copy at a bad URL, and confirm an alert
      arrives. Record: the monitor name and who receives alerts.

## 5. Security review

- [ ] Every pre-launch item in `docs/THREAT_MODEL.md` (#84) is closed, or has an
      accepted-risk note with an owner. Record: the count closed and the count
      accepted, with owners.
- [ ] securityheaders.com grades `https://auth.northeasternsga.com` **A** (#78).
      Record: the grade.

## 6. Curated positions

- [ ] Dry run, review it, then apply ([positions-sync.md](positions-sync.md)):

  ```sh
  SGAUTH_ENV=production DIRECT_URL=<production direct url> npm run positions:sync
  SGAUTH_ENV=production DIRECT_URL=<production direct url> npm run positions:sync -- --apply
  ```

  Check the `Target:` line names the production host before applying. Record:
  both outputs.

- [ ] Back up the positions:

  ```sh
  pg_dump "$DIRECT_URL" --data-only --table='"Position"' --table='"RetiredPositionKey"' --file=positions-<yyyymmdd>.sql
  ```

  Store the file in the SGA ops drive. Never commit it to the repository.
  Record: the file name and where it is stored.

## 7. Bootstrap the Primary Admin

`npm run bootstrap-primary-admin` promotes an account that already exists. It
never creates one, so no password passes through the terminal or shell history,
and the verified mailbox is the proof of ownership.

1. The future Primary Admin signs up at
   `https://auth.northeasternsga.com` and verifies their email.
2. The operator runs the dry run:

   ```sh
   SGAUTH_ENV=production DIRECT_URL=<production direct url> npm run bootstrap-primary-admin -- --email <pa address>
   ```

   Check the `Target:` line names the production host. The output lists the
   grant, any sessions to revoke and the audit row, and ends with the dry-run
   line. It refuses, writing nothing, if the account is unknown, not active,
   unverified or without a password.

3. The operator re-runs with `--apply`:

   ```sh
   SGAUTH_ENV=production DIRECT_URL=<production direct url> npm run bootstrap-primary-admin -- --email <pa address> --apply
   ```

   In one transaction this sets `isAdmin` and `isPrimaryAdmin`, signs the user
   out everywhere, and writes a `PA_BOOTSTRAPPED` audit event (actor `SYSTEM`,
   metadata `sessionsRevoked` only).

4. The Primary Admin signs in again and enrols TOTP (#79 and #66), and stores
   the backup codes offline.
5. Re-run the dry run from step 2. It must print the refusal "a Primary Admin
   already exists" and exit 1. Record: that output. It is the evidence that the
   script is left disabled.

**Why it can never write again.** The script refuses whenever any Primary Admin
exists. The `primary_admin_must_exist` trigger means the count can never return
to zero, so after one successful run the script can never write. Recovery from
a lost Primary Admin is the Primary Admin transfer or
[break-glass.md](break-glass.md), never this script.

## 8. Break-glass

- [ ] At least two named people hold the production `DIRECT_URL` and have read
      [break-glass.md](break-glass.md) (#51). Record: the names, never the
      credential.

## 9. Smoke test on a real subdomain

Use the first rollout product's production deployment on its
`*.northeasternsga.com` domain, before it is announced. `scripts/sso-stub.mjs`
cannot do this: it is loopback-only, and the `__Secure-` cookie is never sent
over plain http to a custom host. If no product is ready, a throwaway HTTPS
stub on a spare subdomain is the fallback, and it is a separate ticket.

- [ ] Sign in on `auth.northeasternsga.com`, then open the product. It shows the
      signed-in user.
- [ ] The cookie is `__Secure-sgauth.session_token` with Domain
      `.northeasternsga.com`, HttpOnly, Secure and SameSite=Lax
      ([SESSION-COOKIE.md](../SESSION-COOKIE.md)). Verify: browser dev tools,
      Application, Cookies.
- [ ] The session endpoint returns the user ([SESSION-ENDPOINT.md](../SESSION-ENDPOINT.md)).
- [ ] Sign out. The product shows signed out, and the session endpoint returns
      no session.
- [ ] Lockout (#76), once, with a synthetic account: the 6th bad password
      attempt is refused. Record: the response.

## 10. Sign-off

The Primary Admin pastes this as a comment on
[#103](https://github.com/SGAOperations/auth/issues/103), filled in. Merging the
pull request closes #103 (`Closes #103`), so reopen it until this comment is
posted.

````md
## Production launch sign-off

Date: <yyyy-mm-dd>
Primary Admin: <name>

- [ ] 1. DNS and email verified
- [ ] 2. Production environment variables set
- [ ] 3. Neon retention, roles and migrations confirmed
- [ ] 4. Services live and the uptime monitor alerting
- [ ] 5. Threat model items closed, security headers grade A
- [ ] 6. Curated positions applied and backed up
- [ ] 7. Primary Admin bootstrapped, MFA enrolled, second dry run refused
- [ ] 8. Two people hold break-glass credentials
- [ ] 9. Smoke test passed on a real subdomain

### Positions sync output

```text
<dry run and apply output>
```

### Bootstrap output

```text
<the --apply output, and the refused second dry run>
```
````
