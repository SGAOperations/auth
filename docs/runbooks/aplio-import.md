# Runbook: the Aplio cutover (import, dual write, reconcile)

Aplio users signed in with an emailed code and have no passwords. Their move to
SGAuth has three parts:

1. **Import.** `npm run import:aplio` loads an Aplio export once per environment.
   It sends no email and never dual-writes.
2. **Dual write.** From launch until the read switch, Aplio stays the read
   source. Each new Aplio signup is also written to SGAuth, through
   `POST /api/provision/aplio/users`. The endpoint uses the same per-row decision
   as the import, so a dual-written user looks exactly like an imported one.
3. **Scheduled read switch.** Aplio's reads move to SGAuth at one instant,
   `APLIO_READ_CUTOVER_AT`. From then on the endpoint answers 410.
   `npm run reconcile:aplio` is the read-only check that says whether the switch is
   safe.

"Password-less" means a user with no credential `Account` that holds a password.
No Aplio path ever writes an `Account` or a `Verification` row. A user sets a
password through the set-password flow ([#34](https://github.com/SGAOperations/auth/issues/34))
the first time they enter their address on the login page, and exactly one email is
sent then.

## Who runs it

- **Import and reconcile:** someone holding the target's `DIRECT_URL` (a
  migration-role credential). There is no HTTP endpoint for either: possession of
  that URL is the authorization.
- **Dual write:** Aplio's server, with the `APLIO_DUAL_WRITE_SECRET` bearer. The
  operator sets the two env vars in Vercel.

## Files

| File             | What it is                                                                        | Holds PII |
| ---------------- | --------------------------------------------------------------------------------- | --------- |
| Export           | `aplio-export*.json`: a JSON array of rows (below). Gitignored.                   | yes       |
| `report.json`    | Per-row outcome, with the address, and the list of non-northeastern.edu accounts. | yes       |
| `id-map.json`    | Aplio id to SGAuth id, for the Aplio team (APLIO-P03). Written by `--apply` only. | no        |
| `reconcile.json` | Every live row's category, and the dual-written users Aplio does not have.        | yes       |

The export is an array of rows. Every field is required unless noted, and an
unknown column is an error:

```json
[
  {
    "id": "aplio user id",
    "email": "ada@northeastern.edu",
    "name": "Ada Lovelace",
    "isAdmin": false,
    "deletedAt": null,
    "sgauthUserId": null
  }
]
```

- `name` may be `null`; the import then uses the part of the address before the `@`.
- `deletedAt` is an ISO 8601 time with an offset, or `null`.
- `sgauthUserId` is optional, the column APLIO-P03 adds. Only `reconcile:aplio` reads
  it. The import ignores it, because the mapping always comes from the address.

Keep the export and the output directories outside the repository (the export name
pattern and `.temp/` are gitignored, but nothing else is).

## What the import does

Each row is decided by its address, compared case-insensitively:

| Row                                                  | Outcome               | Effect                                                                                                                                  |
| ---------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `deletedAt` set                                      | `skip`                | Nothing is written and no mapping is produced.                                                                                          |
| No SGAuth user at that address                       | `create`              | A verified, `ACTIVE`, non-admin user with no password. `legacyEmail` is true unless the address ends in exactly `@northeastern.edu`.    |
| A verified SGAuth user (Chambers, or earlier import) | `merge`               | Maps to the existing id and writes **nothing**: a Chambers password survives. A deactivated user gets the note `deactivated in SGAuth`. |
| A tombstoned SGAuth user                             | `skip`                | `tombstoned in SGAuth`.                                                                                                                 |
| An unverified SGAuth user                            | `skip`                | `existing SGAuth account unverified; not mapped`. Resolve by hand (below).                                                              |
| A later row with the same address as an earlier one  | `duplicate-in-source` | Maps to the same SGAuth user, so every Aplio id resolves.                                                                               |

Aplio's `isAdmin` never reaches SGAuth: it is product-level, and APLIO-P04 maps it
to a position. The report counts the live `isAdmin: true` rows as `aplioAdmins`, as
a handoff number. Subdomains such as `husky.northeastern.edu` count as legacy.

An unverified existing account is never mapped, because it could have been
pre-registered by someone holding the address; mapping an Aplio id to it would hand
that person the Aplio data. To resolve one, have the address's owner verify the
SGAuth account (a sign-in on the login page does it), or have an admin tombstone it,
then re-run the import.

## Procedure

Set `DIRECT_URL` and `SGAUTH_ENV` (`production`, `dev`, `preview` or `local`). Exactly
one of `--dry-run` or `--apply` is required, so an omitted flag can never write.

```bash
npm run import:aplio -- --source aplio-export-2026-11-20.json --dry-run
npm run import:aplio -- --source aplio-export-2026-11-20.json --apply
```

`--out <dir>` sets where the files go. It defaults to
`.temp/aplio-import/<UTC timestamp>/`. Files are never overwritten.

## Cutover sequence

1. On SGAuth production, set `APLIO_DUAL_WRITE_SECRET` and
   `APLIO_READ_CUTOVER_AT=<T>`, then redeploy. The operator picks T: no application
   cycle open ([ROLLOUT §1](../ROLLOUT.md)), and at least a day after step 4. T is an
   ISO 8601 time with an offset, such as `2026-12-01T05:00:00-05:00`. Both variables
   are set together or not at all, and neither has a default. Dev gets its own pair
   with distinct values. Preview and local set neither.
2. Aplio deploys its dual write, with the same secret, the same T, and its
   `sgauthUserId` column. From this moment every new signup reaches both systems.
3. Take the Aplio export **after** step 2, so no signup falls into a gap. Then run
   `import:aplio` with `--dry-run` and then `--apply`, on dev first and then on
   production.
4. Hand `id-map.json` to the Aplio team. Their APLIO-P03 backfill fills
   `sgauthUserId`. Hand the `legacyEmails` list from `report.json` to the person who
   will correct those addresses (AUTH-T24).
5. Before T, run the pre-switch checklist.
6. At T, Aplio's reads switch to SGAuth and the SGAuth endpoint starts answering 410. After T, new applicants sign up through SGAuth, and Aplio creates their row
   on first login (APLIO-P03).
7. Within 24 hours after T, take a fresh export and run `reconcile:aplio`. Fix
   forward, using the table below.

## Reading the import output

```
Target: ep-example-123.us-east-1.aws.neon.tech/neondb (SGAUTH_ENV=dev)
Source: 1204 rows, sha256 <hex>
! skip <aplio id> soft-deleted in Aplio
! 7 accounts are outside @northeastern.edu (legacyEmail); see report.json
1204 rows: 1010 create, 150 merge, 4 duplicate in source, 40 skip; 3 names defaulted; 6 Aplio admins (not granted)
```

- `! skip` names a row by Aplio id, never by address.
- The report lists every non-northeastern.edu account that was created or merged
  under `legacyEmails`. They keep working. An admin can later move each one to the
  person's northeastern.edu address through AUTH-T24, which keeps the SGAuth id and
  the Aplio history.
- A dry run ends with `Dry run. Re-run with --apply to write these changes.` An apply
  prints `Applied:`, the counts, and the paths of `report.json` and `id-map.json`.

## Dual write

`POST /api/provision/aplio/users` with `Authorization: Bearer <APLIO_DUAL_WRITE_SECRET>`
and the body `{ "aplioId": string, "email": string, "name": string | null }`. An extra
field is an error.

| Status | Body                                               | Meaning                                                                                 |
| ------ | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 200    | `{ "sgauthUserId": "...", "outcome": "created" }`  | A new account was created.                                                              |
| 200    | `{ "sgauthUserId": "...", "outcome": "existing" }` | The address already had a verified account. Nothing changed. The same call is a repeat. |
| 400    | `{ "error": "bad_request", "issues": [paths] }`    | The body is wrong. Paths only, never a value.                                           |
| 401    | `{ "error": "unauthorized" }`                      | No bearer, or the wrong one.                                                            |
| 404    | `{ "error": "not_found" }`                         | Either variable is unset: the endpoint is off.                                          |
| 409    | `{ "error": "tombstoned" }`                        | The address belongs to a tombstoned account. Do not retry.                              |
| 409    | `{ "error": "unverified_account" }`                | An unverified account holds the address. Do not retry; it shows up in reconcile.        |
| 410    | `{ "error": "cutover_passed" }`                    | `APLIO_READ_CUTOVER_AT` has passed. Do not retry.                                       |
| 500    | `{ "error": "internal" }`                          | Retry with backoff. The request is idempotent.                                          |

The endpoint writes one `USER_CREATED` audit event with `source: aplio_dual_write` on
a create, and nothing otherwise. It sends no email. Logs carry the Aplio id and the
outcome, never an address.

What Aplio does, built in the Aplio repository:

- It calls the endpoint **after** its own user row commits. It never calls inside its
  own transaction, and a failed call never blocks the signup.
- On a 200, Aplio stores `sgauthUserId`. On a 5xx or a network error, it keeps the row
  with `sgauthUserId = null` and retries with backoff. On a 409 it stops retrying and
  the row surfaces in reconcile. On a 410 it stops, because the read switch has
  happened.
- Aplio's reads switch at the same `APLIO_READ_CUTOVER_AT` instant.

## Reconcile

```bash
npm run reconcile:aplio -- --source aplio-export-2026-11-30.json \
  --cutover-at 2026-12-01T05:00:00-05:00
```

`--cutover-at` is required and has no default. A value without an offset is a usage
error. The command is read-only: it makes no writes and writes no audit row. It
writes `reconcile.json` (which holds addresses) to `--out`, defaulting to
`.temp/aplio-reconcile/<UTC timestamp>/`.

It sorts every live (not soft-deleted) Aplio row into one category, prints a count
for each with the fix for any that is not zero, and ends with one of:

```
READY: switch reads at 2026-12-01T10:00:00.000Z
NOT READY: 1 missing-in-sgauth, 1 mismatch
```

`READY` exits 0 and `NOT READY` exits 1. `READY` needs all four blocking categories at
zero and the cutover still ahead. After the cutover the command still runs, for the
post-switch check, but it never prints `READY`.

| Category            | Which write failed                                               | Fix                                                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                | None                                                             | Nothing to do.                                                                                                                                                                                                                                     |
| `missing-in-sgauth` | SGAuth (endpoint unreachable, 5xx, Aplio gave up)                | Re-run `import:aplio --apply` with the fresh export. The import is idempotent and creates only the missing users. Send the new `id-map.json` for backfill. Aplio's own retry may already have fixed it, so re-run reconcile first.                 |
| `needs-backfill`    | Aplio stored no id (crash after the SGAuth 200)                  | Aplio re-runs its APLIO-P03 backfill from the latest `id-map.json`. A re-import produces one if needed.                                                                                                                                            |
| `mismatch`          | Email changed on one side after the mapping                      | Stop. Resolve by hand. Never switch with a mismatch.                                                                                                                                                                                               |
| `blocked`           | SGAuth holds an unverified or tombstoned account at that address | By hand. Either the address's owner verifies the SGAuth account, or an admin tombstones a squatter. Then re-run the import and reconcile.                                                                                                          |
| `sgauth-only`       | Aplio (rolled back after the SGAuth call)                        | Review only; it never blocks. A user created through the dual write whose address matches no live export row. It is a harmless password-less account that nobody can reach without the mailbox. An admin tombstones it if it is not a real person. |

## Pre-switch checklist

Before T:

- [ ] The `APLIO_READ_CUTOVER_AT` value in SGAuth production (read back from Vercel)
      and Aplio's read-switch setting are the same instant.
- [ ] A fresh Aplio export, with `sgauthUserId`, taken within the hour before T.
- [ ] `npm run reconcile:aplio -- --source <export> --cutover-at <T>` prints `READY`.
- [ ] Aplio's dual-write retry queue is empty (an Aplio-side check).
- [ ] SGAuth logs show no 5xx from `/api/provision/aplio/users` since the export.
- [ ] Spot check: one user who signed up after the import exists in SGAuth, with the id
      Aplio holds.

A signup whose SGAuth write is still retrying at T gets a 410. Reconcile after T finds
it as `missing-in-sgauth`, and a re-import fixes it forward. The empty retry queue
check keeps that set near zero.

## Post-switch check

Within 24 hours after T, take a fresh export and run `reconcile:aplio` against it. It
will say `NOT READY: cutover has passed`; read the category counts, not the verdict,
and fix forward using the table above.

## Failures

The import and reconcile exit non-zero with a readable message and no writes for:

- A bad argument, environment variable or export. The message lists every problem by
  path, never by value.
- `Another writer created a user with an imported email; re-run.` The whole apply
  rolled back. A dual write landing mid-apply is exactly this case. Re-run.
- `Output file ... already exists`. An output file is written only after the commit,
  so on `--apply` the data is already in. Re-run with a fresh `--out` and it plans zero
  creates.

Connection failures and unexpected database errors print only an error name and code.
The apply is one transaction and writes the `BULK_IMPORT` audit event in it: if that
write fails, nothing is imported.

## Verify

- The dry run on dev reports the counts you expect, and an immediate second `--apply`
  reports `0 create`, with the same ids in `id-map.json`.
- The merged Chambers user still signs in with their Chambers password, and a row
  with `isAdmin: true` produced a user with `isAdmin = false`.
- Enter an imported password-less northeastern.edu address on the dev login page.
  Exactly one set-password email arrives. After the password is set the user is signed
  in with the SGAuth id from `id-map.json`.
- No email is sent by the import or the dual write: the Resend dashboard shows no
  sends during the run, and no `Verification` rows exist for the addresses.
- The audit log has one `BULK_IMPORT` event with `source: aplio` whose counts match the
  report, and one `USER_CREATED` event per dual-written account.

## Rollback

Until T, Aplio's own user table is current, because every signup was dual-written, so
rolling back means reverting Aplio's read switch. SGAuth keeps the accounts it
created. To turn the endpoint off sooner, unset either variable and redeploy: it
answers 404. If the secret leaks, rotate it per [rotate-secrets.md](rotate-secrets.md).
The impact of a leak is password-less account creation for chosen addresses; each is
unusable without its mailbox, each is audited with `aplio_dual_write`, and the window
closes at T.

## After the production run

- Give `id-map.json` to the Aplio team, and the `legacyEmails` list to whoever will
  correct those addresses.
- Delete the export, `report.json`, `id-map.json`, `reconcile.json` and the output
  directories.

Re-running the import is safe.
