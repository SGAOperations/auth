# Runbook: break-glass Primary Admin recovery

`npm run recover-primary-admin` changes who the Primary Admin (PA) is, or clears
the PA's MFA, without the normal transfer flow or the admin UI. It exists for
the cases where those cannot run. There is no HTTP endpoint for it: holding the
production `DIRECT_URL` (a migration-role credential) and typing a confirmation
phrase at a terminal are the authorization.

## When to use it

- The PA is unreachable or has left, and no transfer can be started or accepted.
- The PA account is compromised. Add `--demote-previous` so the old PA also loses
  the admin flag.
- The PA has lost both their phone and their backup codes. Use `--reset-mfa`
  (admins cannot touch the PA's MFA, so this is the only way).

**When not to:** whenever the normal Primary Admin transfer can run. Use that
instead.

## Who holds credentials

At least two people hold the production `DIRECT_URL`, which lives in the team
password manager. The holders are filled in when the current Primary Admin
reviews this runbook.

|      Holder       |                 Role                   |          Contact               |
| ------            | ----                                   | -------                        |
| Eli Patania       | Vice President of Operational Affairs  | patania.e@northeastern.edu     |
| Logan Ravinuthala | Digital Innovation Manager             | ravinuthala.l@northeastern.edu |
| Elina Jiang       | Information Manager                    | jiang.eli@northeastern.edu     |

## Two-person rule

One holder runs the script while a second holder watches the screen. Put the
second holder's name in `--reason`, for example
`"PA left, no transfer possible; witnessed by Grace Hopper"`. Never run it alone.

## Procedure

Set these in the shell. The script does not read `.env`, so a stray local
`DIRECT_URL` can never be used by accident.

- `DIRECT_URL`: the production migration-role URL.
- `SGAUTH_ENV`: one of `production`, `dev`, `preview`, `local`.
- `RESEND_API_KEY` and `RESEND_FROM_EMAIL`: needed for a real run, so every admin
  can be notified. A dry run does not need them.

Without `DIRECT_URL`, or with an unknown flag or a missing required flag, the
command exits 1 before connecting.

1. Dry run. This changes nothing.

   ```bash
   npm run recover-primary-admin -- --email new-pa@northeastern.edu --operator "Your Name" --reason "Why, and who is watching" --dry-run
   ```

2. Read the output. Check that the `Target:` line is the production database,
   and that every line of the plan is what you intend.

3. Run it for real: the same command without `--dry-run`. At the prompt, type the
   phrase exactly (case-sensitive): `TRANSFER PRIMARY ADMIN`.

   ```bash
   npm run recover-primary-admin -- --email new-pa@northeastern.edu --operator "Your Name" --reason "Why, and who is watching"
   ```

   Add `--demote-previous` for a compromised PA.

4. For a lost phone and backup codes, use the MFA mode instead. The phrase is
   `RESET PRIMARY ADMIN MFA`.

   ```bash
   npm run recover-primary-admin -- --reset-mfa --email pa@northeastern.edu --operator "Your Name" --reason "Why, and who is watching"
   ```

The target must be an active user. A transfer makes them admin and PA, cancels
any in-flight transfer, and signs the old PA out everywhere. The old PA stays an
admin unless `--demote-previous` is set.

## Reading the output

```
Target: ep-example-123.us-east-1.aws.neon.tech/neondb (SGAUTH_ENV=production)
Break-glass: transfer Primary Admin
! cancel in-flight transfer <id> (COOLING)
- clear Primary Admin from old@northeastern.edu (stays admin)
+ make new@northeastern.edu admin and Primary Admin
x sign out old@northeastern.edu (3 sessions)
warning: new@northeastern.edu has no MFA; they must enrol TOTP before any admin action
Type TRANSFER PRIMARY ADMIN to continue:
```

Then, after the phrase:

```
Committed. Audit event <id>.
Sessions signed out: 3.
Verified: exactly one Primary Admin (new@northeastern.edu).
Notified: a@northeastern.edu, b@northeastern.edu (ok); c@northeastern.edu (FAILED)
```

A warning does not stop the run. A refusal does, with a message such as
`<email> is already the Primary Admin`.

A dry run ends with `Dry run. Nothing was written.`

## Exit codes

- `0`: everything succeeded.
- `1`: the run was refused or failed, and nothing was written. This includes a
  wrong phrase, no terminal (the phrase must be typed at one), and
  `The database changed since the plan was shown`. Re-run from the dry run.
- `2`: the change **committed**, but verification or a notification failed. The
  script prints `Some notifications failed. Email those addresses by hand`.
  Email each listed address yourself, saying who the new PA is and why. Then do
  the checks below.

## How to verify afterwards

1. Run the dry run again. The plan must be refused with
   `<email> is already the Primary Admin`.
2. Confirm the new PA can sign in and is prompted to enrol MFA.
3. Confirm the old PA's sessions are gone (they are signed out on their next
   request).
4. Check the audit row exists:

   ```sql
   SELECT "id", "createdAt", "targetId", "metadata"
   FROM "AuditEvent"
   WHERE "type" = 'BREAK_GLASS_PA_RECOVERY'
   ORDER BY "createdAt" DESC
   LIMIT 5;
   ```

   `actorType` is `BREAK_GLASS`, and `metadata.mode` is `transfer` or
   `reset_mfa`, with the operator and reason you gave.

Record the output and the audit event id in the incident ticket.

## Suspected misuse

Every admin is emailed on every run, so an unexpected email is the alarm. If
nobody on the holder list ran it:

1. Rotate the migration-role password in Neon, then update the password manager.
2. Run break-glass again to restore the rightful PA.
3. Treat the old `DIRECT_URL` as leaked.

## What it never does

- Expose an HTTP endpoint.
- Change any password.
- Delete a user, a session record other than the old PA's, or an audit row. The
  only deletions are the old PA's sessions (and, for `--reset-mfa`, the PA's TOTP
  enrolment and backup codes).
