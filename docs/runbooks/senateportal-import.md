# Runbook: the SenatePortal user import

SenatePortal is the new name for Attendance Manager. Its users signed in through
Supabase Auth, so SGAuth has no password for them. `npm run import:senateportal`
loads a SenatePortal export once per environment. It creates or finds one SGAuth
account per address and writes the id-mapping file the SenatePortal team needs for
ATTENDANCE-M05.

The import:

- sends no email, and writes no `Account` or `Verification` row. A user sets a
  password through the set-password flow ([#34](https://github.com/SGAOperations/auth/issues/34))
  the first time they enter their address on the login page, and exactly one email
  is sent then.
- **assigns no positions.** SenatePortal's `MEMBER`/`EBOARD` role is not a record of
  who holds an office. `MEMBER` is the default for any signup, and the role could be
  changed without authorization. Positions such as `senator` and
  `speaker-of-the-senate` are assigned in SGAuth, through
  [positions-sync.md](positions-sync.md) or by an admin
  ([positions.md](positions.md)). The import takes no `--mapping` flag.
- **never stores NUID.** NUID stays in SenatePortal's own `User` table, keyed by the
  SGAuth id (ATTENDANCE-M04). Leave it out of the export. If the export carries it
  anyway, the validator drops the column before any other code sees the row. The
  console and `report.json` name the dropped column, never its values.

## Who runs it

Someone holding the target's `DIRECT_URL` (a migration-role credential). There is
no HTTP endpoint: possession of that URL is the authorization.

## Files

| File          | What it is                                                                            | Holds PII |
| ------------- | ------------------------------------------------------------------------------------- | --------- |
| Export        | `senateportal-export*.json`: a JSON array of rows (below). Gitignored.                | yes       |
| `report.json` | Per-row outcome, with the address, the non-northeastern.edu list and dropped columns. | yes       |
| `id-map.json` | SenatePortal id to SGAuth id, for the SenatePortal team. Written by `--apply` only.   | no        |

The export is an array of rows. Every field is required:

```json
[
  {
    "id": "senateportal userId",
    "email": "ada@northeastern.edu",
    "firstName": "Ada",
    "lastName": "Lovelace",
    "deletedAt": null
  }
]
```

- `firstName` and `lastName` are joined with a space. If both are blank, the import
  uses the part of the address before the `@` and counts it under `names defaulted`.
- `deletedAt` is an ISO 8601 time with an offset, or `null`.
- Any other column is dropped and named in the output. Re-export without it.

## Taking the export

The SenatePortal team runs this in their Supabase project's SQL editor and saves the
result as `senateportal-export-<date>.json`:

```sql
select coalesce(json_agg(json_build_object(
  'id',        u."userId",
  'email',     u.email,
  'firstName', u."firstName",
  'lastName',  u."lastName",
  'deletedAt', to_char(u."deletedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) order by u."createdAt"), '[]'::json)
from public."User" u
join auth.users a on a.id::text = u."supabaseAuthId"
where a.email_confirmed_at is not null;
```

- **Only confirmed addresses.** SenatePortal creates its `User` row at signup, before
  Supabase confirms the address. The join leaves out every row whose owner never
  proved the mailbox, so nobody can claim a SenatePortal id by signing up with
  someone else's address. A row without a Supabase account is left out for the same
  reason.
- **No NUID, no role.** The query selects neither.
- `deletedAt` is stored in UTC, so the `Z` suffix is correct.

Keep the export and the output directories outside the repository. The export name
pattern and `.temp/` are gitignored, but nothing else is. Move the export to the team
vault, never to git or chat.

## What the import does

Each row is decided by its address, compared case-insensitively. The rule is the same
one the Aplio import uses, so an account looks the same whichever product created it:

| Row                                                  | Outcome               | Effect                                                                                                                                                                             |
| ---------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deletedAt` set                                      | `skip`                | `soft-deleted in SenatePortal`. Nothing is written and no mapping is produced.                                                                                                     |
| No SGAuth user at that address                       | `create`              | A verified, `ACTIVE`, non-admin user with no password and no positions. `legacyEmail` is true unless the address ends in exactly `@northeastern.edu`.                              |
| A verified SGAuth user (Chambers, Aplio, or earlier) | `merge`               | Maps to the existing id and writes **nothing**: the name, password, positions and status all stay. A deactivated user gets the note `deactivated in SGAuth` and stays deactivated. |
| A tombstoned SGAuth user                             | `skip`                | `tombstoned in SGAuth`.                                                                                                                                                            |
| An unverified SGAuth user                            | `skip`                | `existing SGAuth account unverified; not mapped`. Resolve by hand (below).                                                                                                         |
| A later row with the same address as an earlier one  | `duplicate-in-source` | Maps to the same SGAuth user, so every SenatePortal id resolves.                                                                                                                   |

An unverified existing account is never mapped, because it could have been
pre-registered by someone holding the address. To resolve one, have the address's
owner verify the SGAuth account (a sign-in on the login page does it), or have an
admin tombstone it, then re-run the import.

## Procedure

Set `DIRECT_URL` and `SGAUTH_ENV` (`production`, `dev`, `preview` or `local`).
Exactly one of `--dry-run` or `--apply` is required, so an omitted flag can never
write. Run on dev first, then on production.

```bash
npm run import:senateportal -- --source senateportal-export-2026-11-20.json --dry-run
```

```bash
npm run import:senateportal -- --source senateportal-export-2026-11-20.json --apply
```

`--out <dir>` sets where the files go. It defaults to
`.temp/senateportal-import/<UTC timestamp>/`. Files are never overwritten.

## Reading the output

```
Target: ep-example-123.us-east-1.aws.neon.tech/neondb (SGAUTH_ENV=dev)
Source: 212 rows, sha256 <hex>
! dropped columns not in the contract: nuid (values never read); re-export without them
! skip <senateportal id> soft-deleted in SenatePortal
! 2 accounts are outside @northeastern.edu (legacyEmail); see report.json
212 rows: 150 create, 55 merge, 1 duplicate in source, 6 skip; 0 names defaulted; no positions assigned
```

- `! dropped columns` means the export carried columns outside the contract. The
  import is still correct, but fix the export query and take a new export before the
  production run, so the file in the vault holds no NUID.
- `! skip` names a row by SenatePortal id, never by address.
- `report.json` lists every non-northeastern.edu account that was created or merged
  under `legacyEmails`. They keep working. An admin can later move each one to the
  person's northeastern.edu address through AUTH-T24, which keeps the SGAuth id.
- A dry run ends with `Dry run. Re-run with --apply to write these changes.` An apply
  prints `Applied:`, the counts, and the paths of `report.json` and `id-map.json`.

## Failures

The import exits non-zero with a readable message and no writes for:

- A bad argument, environment variable or export. The message lists every problem by
  path, never by value.
- `Another writer created a user with an imported email; re-run.` The whole apply
  rolled back. Re-run.
- `Output file ... already exists`. An output file is written only after the commit,
  so on `--apply` the data is already in. Re-run with a fresh `--out` and it plans
  zero creates.

Connection failures and unexpected database errors print only an error name and code.
The apply is one transaction and writes the `BULK_IMPORT` audit event in it: if that
write fails, nothing is imported.

## Verify

- The dry run on dev reports the counts you expect, and an immediate second `--apply`
  reports `0 create`, with the same ids in `id-map.json`.
- An export carrying an `nuid` column imports, prints the dropped-column warning, and
  the NUID value appears nowhere in `report.json`, `id-map.json` or the user's row.
- An imported user holds no positions, and a merged user's positions are unchanged.
- Enter an imported password-less northeastern.edu address on the dev login page.
  Exactly one set-password email arrives. After the password is set the user is
  signed in with the SGAuth id from `id-map.json`.
- No email is sent by the import: the Resend dashboard shows no sends during the run,
  and no `Verification` rows exist for the addresses.
- The audit log has one `BULK_IMPORT` event with `source: senateportal` whose counts
  match the report.

## After the production run

- Give `id-map.json` to the SenatePortal team through the vault (ATTENDANCE-M05).
- Assign positions in SGAuth: `senator` to the current roster, and the Senate offices
  to their holders. The SenatePortal permission map reads positions, not the old role.
- Delete the export, `report.json`, `id-map.json` and the output directories.

Re-running the import is safe.
