# Runbook: import the Chambers users

`npm run import:users` loads the users in a validated Chambers export into
SGAuth: their accounts, their bcrypt password hashes (which #33 re-hashes to
scrypt on first sign-in) and their positions. It runs once per environment, dev
first, then production. The export format and how to produce it are in
[chambers-export.md](chambers-export.md).

## Who runs it

Someone holding the target's `DIRECT_URL` (a migration-role credential). There is
no HTTP endpoint: possession of that URL is the authorization. In production the
mapping must also carry the Primary Admin's approval (below).

## Prerequisites

- The export passes `npm run validate-export` with the `--expect-*` counts taken
  from the source ([chambers-export.md](chambers-export.md)).
- The curated positions are synced to the target
  ([positions-sync.md](positions-sync.md)).
- Every product role the mapping uses (`chambers-...`) already exists as a
  position. An unknown position key stops the run.

## Files

| File             | What it is                                                                                  | Holds PII |
| ---------------- | ------------------------------------------------------------------------------------------- | --------- |
| Export           | The validated `chambers-export*.json`.                                                      | yes       |
| Mapping          | `{ approvedBy, approvedAt, roles }`: Chambers roles to position keys. See the example file. | no        |
| Replacement file | Optional. One `old new` email pair per line. See the example file.                          | yes       |
| `report.json`    | Per-row outcome, with the Chambers address and any replacement.                             | yes       |
| `id-map.json`    | Chambers id to SGAuth id, for the Chambers team. Written by `--apply` only.                 | yes       |

Examples, with no real data: `prisma/import/chambers-positions.example.json` and
`prisma/import/chambers-email-replacements.example.txt`. Keep the export, the
replacement file and the output directory outside the repository (the export name
pattern and `.temp/` are gitignored, but nothing else is). No file holds a
password hash.

## Build the mapping

Every role in the export needs a mapping entry, even one that maps to `[]`:

- `admin_role:<role>`: a role from `NEON_ADMIN_ROLES` in
  `src/lib/import/chambers-export.ts` (`SUPABASE_ADMIN_ROLES` for a `supabase`
  export).
- `iems_role:<role>`: any non-empty IEMS role.
- `board:<body_id>:<role>`: the role is exactly `Leadership` or `Member`. A body
  that has both kinds of seat needs two entries. Map `Leadership` to the body's
  director or chair key and `Member` to its `-member` or `-committee-member` key
  in `prisma/seed/positions.json`.

Run the dry run (below) and repeat until it reports no unmapped roles. Each
unmapped board key is printed with its body's name:

```
? unmapped role board:<uuid>:Leadership "Elections Board" (2 rows)
```

A dry run still prints the summary when roles are unmapped, so it is the way to
build the mapping. It exits non-zero and writes nothing.

## Replacement emails

Only `@northeastern.edu` addresses are imported (subdomains such as
`@coe.northeastern.edu` do not count). A user with any other address is skipped
and reported unless the replacement file lists them.

1. Run the dry run without a replacement file. Every skipped row with the reason
   `non-northeastern email; no replacement supplied` is listed in `report.json`
   by `sourceEmail`.
2. Write one `old new` line for each user who should be imported under a
   Northeastern address. The new address must end in `@northeastern.edu`.
3. Re-run the dry run with `--email-replacements <file>` until the only
   non-northeastern skips left are users who should not be imported.

Replaced users sign in with their **new** address and their Chambers password.
Their email starts unverified, because Chambers verified the old address. A line
that matches no export row is reported as `? replacement line <k> matches no
export row` and does no harm.

The file holds PII. Keep it outside the repository and delete it with the export.

## Approval

The Primary Admin reviews the mapping and the dry-run report. Then the operator
sets `approvedBy` (the Primary Admin's email) and `approvedAt` (`YYYY-MM-DD`) in
the mapping. In production, `--apply` refuses unless `approvedBy` is the current
Primary Admin. Elsewhere a missing approval is only a warning. The replacement
file is not part of the approval: its checksum is recorded in the audit event.

## Procedure

Set `DIRECT_URL` and `SGAUTH_ENV` (`production`, `dev`, `preview` or `local`).
Both are required. Exactly one of `--dry-run` or `--apply` is required, so an
omitted flag can never write.

1. Dry run on dev.

   ```bash
   npm run import:users -- --source chambers-export-2026-11-02.json \
     --mapping chambers-positions.json \
     --email-replacements chambers-email-replacements.txt --dry-run
   ```

2. Compare the printed `sha256` of the source with the validator's `SHA-256`
   line recorded in the vault. Check that the `Target:` line is the database you
   intend.
3. Apply on dev with the same arguments and `--apply`, then verify (below).
4. Repeat steps 1 to 3 on production, with the same export and replacement file.

`--out <dir>` sets where the files go. It defaults to
`.temp/chambers-import/<UTC timestamp>/`. Files are never overwritten.

## Reading the output

```
Target: ep-example-123.us-east-1.aws.neon.tech/neondb (SGAUTH_ENV=dev)
Source: 412 rows from chambers-neon exported 2026-11-02T15:00:00.000000+00:00, sha256 <hex>
~ 3 email(s) are outside @northeastern.edu
Mapping: 21 roles, approved by primary-admin@northeastern.edu on 2026-11-02
Replacements: 2 entries, sha256 <hex>
! skip <chambers id> banned in Chambers
! 1 non-northeastern rows have no replacement; see report.json
412 rows: 380 create, 0 merge, 0 unchanged, 32 skip (1 non-northeastern); 2 emails replaced; 640 position assignments
```

- `~` lines are warnings and do not stop the run.
- `! skip` names a row by Chambers id, never by email. The reasons are
  `banned in Chambers`, `non-northeastern email; no replacement supplied`,
  `duplicate email after replacement` and `tombstoned in SGAuth`.
- `?` lines are problems and stop the run before any write: unmapped roles,
  an `admin_role:` key that is not a role of the export's source, and unknown
  position keys. A replacement line that matches nothing is also a `?` line, but
  only a note.

What each outcome does:

- **create**: a new user, with a credential Account when the export has a hash.
  An inactive Chambers user is created `DEACTIVATED` with no positions.
- **merge**: the user already exists in SGAuth. The import sets
  `emailVerified` to true when Chambers says so, adds a credential Account when
  there is none (or fills one with no password), and adds mapped positions the
  user lacks. It never changes a name or status, never replaces an existing
  password, and never removes a position.
- **unchanged**: nothing to add.
- **skip**: nothing is written for the row.

A dry run ends with `Dry run. Re-run with --apply to write these changes.` An
apply prints `Applied: ...` and the paths of `report.json` and `id-map.json`.

## Failures

All exit non-zero with a readable message and no writes:

- A bad argument, environment variable, export, mapping or replacement file. The
  message lists every problem by path or line number, never by value.
- Unmapped roles, disallowed admin roles or unknown position keys.
- Production without the Primary Admin's approval.
- `Another writer created a user with an imported email; re-run.` The whole apply
  rolled back. Re-run the dry run.
- `Output file ... already exists`. An output file is written only after the
  commit, so on `--apply` the data is already in. Re-run with a fresh `--out` and
  it plans zero creates.

Connection failures and unexpected database errors print only an error name and
code. The apply is one transaction and writes the `BULK_IMPORT` audit event in it:
if that write fails, nothing is imported.

## Verify

- The dry run on dev reports the counts you expect, and an immediate second
  `--apply` reports `0 create`.
- Sign a sample imported user in at `/api/auth/sign-in/email` with their Chambers
  password, and check that they hold the mapped positions.
- Check that the audit log has one `BULK_IMPORT` event whose counts match the
  report.

## After the production run

- Give `id-map.json` to the Chambers team. Tell them which rows have
  `emailReplaced: true`: those users now sign in under a new address.
- Delete the export, the replacement file, `report.json`, `id-map.json` and the
  output directory, and delete the vault copy of the export
  ([chambers-export.md](chambers-export.md#handling)).

Re-running is safe. Adding a replacement line later and re-running imports that
user without touching anyone else.
