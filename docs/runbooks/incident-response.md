# Runbook: incident response

Contain a suspected compromise, rotate what leaked, and tell the right people.
Pick the section that matches the scope, then finish with Notify and Record.

> Status: the admin user controls land with #60 and the audit viewer with #63.
> Check labels against the merged UI during the dev walkthrough.

## Who is authorized

Admins for a single account. Anything that touches the database directly needs
the `migration` role (`DIRECT_URL`) and a second SGA operator informed first, as
in [neon-restore.md](neon-restore.md).

## One compromised account

1. Open the user's detail page.
2. Deactivate the account, or use **Revoke all sessions** / **Force re-login** if
   the person must keep access.
3. Reset the user's MFA and invalidate their password, so they set a new one.
4. Check the audit timeline on the same page for what the account did.

The Primary Admin cannot be deactivated or have MFA changed by admins. For a
compromised PA, use [break-glass.md](break-glass.md) with `--demote-previous`.

## Several accounts, or a suspected session leak

Delete every row in the `Session` table, so every user must sign in again. Use
the `migration` role over `DIRECT_URL`, the same way
[neon-restore.md](neon-restore.md) force-expires sessions. Re-check the table
name against the live schema first, because that runbook calls its table names
provisional.

## Secret or key exposure

Follow [rotate-secrets.md](rotate-secrets.md) (lands with #81). In short:

- Rotating `BETTER_AUTH_SECRET` signs everyone out.
- A leaked JWT signing key needs the JWKS rotation. Already-issued JWTs stay valid
  for up to 10 minutes.
- For a leaked Neon credential, rotate both role passwords (`runtime` and
  `migration`) and update Vercel env and the password manager.

## Notify

In this order:

1. The other admins and a second SGA operator.
2. The owners of every affected product.
3. Affected users. A short template:

   > We found unusual activity on your SGAuth account on <date>. We signed you out
   > everywhere. Please sign in again and set a new password. If you did not
   > expect this, reply to this message. We are sorry for the disruption.

## Record

Export the relevant audit rows with the audit log viewer's CSV export and attach
them to the incident notes, with the timeline and what you changed. If data was
destroyed, see [neon-restore.md](neon-restore.md).

## Verify afterwards

- [ ] The exposed account, session or secret is no longer usable.
- [ ] Audit rows for the incident are exported and saved.
- [ ] Admins, product owners and affected users have been notified.
