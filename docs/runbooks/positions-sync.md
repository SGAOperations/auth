# Runbook: sync the curated position list

The curated SGA position list lives in `prisma/seed/positions.json` (83
positions). `npm run positions:sync` reconciles it with the `Position` table.
This is the only supported way to load it into production.

The JSON is the source of truth: `--apply` resets any admin rename of a curated
position, and the dry run shows you each one first.

## When to run it

- At launch, from the #103 checklist.
- After any pull request that edits `positions.json` has merged and deployed.

Do not run it on a schedule or on every deploy. Admins can rename positions in
production, and an automatic sync would undo those renames.

## Who runs it

Someone holding the production `DIRECT_URL` (a migration-role credential).
There is no HTTP endpoint: possession of that URL is the authorization.

## Procedure

Set `DIRECT_URL` and `SGAUTH_ENV` (one of `production`, `dev`, `preview`,
`local`) in the environment. Both are required. Without them, or with any flag
other than `--apply`, the command exits non-zero before connecting.

1. Dry run. This writes nothing.

   ```bash
   npm run positions:sync
   ```

2. Read the output (below). Check that the `Target:` line is the database you
   intend.

3. Apply.

   ```bash
   npm run positions:sync -- --apply
   ```

4. Record the output in the ticket. (Audit events for this command do not exist
   yet, so the output is the record.)

For local, dev and preview databases, `npm run seed` runs the same sync with
apply always on. It refuses to run when `SGAUTH_ENV=production`.

## Reading the output

The first line names the target without credentials:

```
Target: ep-example-123.us-east-1.aws.neon.tech/neondb (SGAUTH_ENV=production)
```

Then one line per position that is not already in sync, then the counts:

```
+ create vp-finance "Vice President of Finance" [Operational Affairs]
~ update senator name "Senator (old)" -> "Senator"
! skip   old-key (retired by an admin; not recreated)
83 curated: 1 create, 1 update, 80 unchanged, 1 skipped
```

When nothing differs, it prints
`83 curated positions already in sync; nothing to do.`

- `+ create`: the key has never existed. It is created with no holders.
- `~ update`: the active row's name or category differs from the JSON. **Applying
  it reverts an admin rename.** To keep the admin's name, remove the entry from
  the JSON (or change the JSON to match) before applying. Otherwise accept the
  revert.
- `! skip`: an admin deleted this position. It is not recreated, however long
  ago. Recreating it is an admin UI action.

A dry run ends with `Dry run. Re-run with --apply to write these changes.` An
apply ends with `Applied: ...` and the counts.

## Failures

All exit non-zero with a readable message and no writes:

- The JSON is invalid (bad key format, duplicate key, duplicate name). The
  message lists every offending entry. Nothing is connected to.
- `DIRECT_URL` or `SGAUTH_ENV` is missing or invalid, or an unknown flag was
  passed.
- `Another writer created a curated key; re-run.` An admin created one of the
  keys between the read and the write. The whole apply rolled back. Re-run the
  dry run.

Connection failures and unexpected database errors print a stack trace. The
apply runs in one transaction, so a failure part-way leaves nothing written.

## What it never does

- Delete a position.
- Recreate a position an admin deleted.
- Touch `description`, holders, or any position that is not in the JSON.
  Product roles such as `aplio-admin` and admin-created positions are ignored,
  and are not mentioned in the output.
- Change a key. Keys are immutable.

## Retiring or splitting a curated position

Removing an entry from `positions.json` does not retire it: the sync ignores
keys that are not in the JSON, so the row stays live. Keys cannot be renamed
either. To replace a key (for example, to split one position into two):

1. Merge the pull request that adds the replacement keys and removes the old
   one, then run the sync (see Procedure) so the new keys exist.
2. Move every holder of the old position with
   `PATCH /api/sgauth/admin/users/[id]/positions` and
   `{ "assign": [<new id>], "unassign": [<old id>] }`. It is one audited
   transaction, and the unassign runs first, so the 50-position limit is never
   hit.
3. Soft-delete the old position with `DELETE /api/sgauth/admin/positions/[id]`
   and `{ "confirmKey": "<old key>" }`. The response reports `holderCount`; a
   non-zero count means a holder was missed, and the `POSITION_DELETED` audit
   row lists their ids.

A Chambers import mapping that still names a retired key stops with
`? unknown position key`. Update the mapping before the next import.
