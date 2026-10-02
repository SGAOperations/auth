# Runbook: restore the Neon `main` branch to a point in time

Applies to the `sgauth` Neon project (region `aws-us-east-1`). Production data
lives on the `main` branch.

## Limitation: 6-hour history window (Free plan)

SGAuth launches on the Neon **Free** plan. History retention on `main` is set
to the Free maximum, **6 hours**. That means:

- You can restore `main` to any moment in the **last 6 hours**, and no further
  back. Data older than that window is unrecoverable from Neon itself.
- A problem noticed the next morning is probably already outside the window.
  Act fast, and do not wait on a second opinion before starting the restore if
  the damage is clearly recent and ongoing.
- AUTH-T101 revisits this: the Launch plan extends the window and is part of
  that ticket's upgrade runbook.

## Who is authorized

Only members of the SGAOperations Neon org with the **Admin** role, and only
with a second SGA operator informed before the restore starts. A restore
rewrites production data, and every SGA product's login depends on it.

## Before you restore

1. Write down the target timestamp (UTC) and why you picked it. Pick the last
   moment you are confident the data was good.
2. Note the current time. Confirm the target is inside the 6-hour window.
3. Tell the other SGA operators in the ops channel that auth is about to be
   restored, because sessions and accounts changed after the target timestamp
   will be lost.

## Restore procedure

Prefer restoring into a **new branch** first and inspecting it. It costs one
branch slot (the Free plan allows 10 total; 3 are permanent, so check the
count first) and does not touch production until you decide to promote it.

1. In the Neon console open project `sgauth`, then **Restore** (or **Branches**,
   then `main`, then **Restore**).
2. Choose **From history** and enter the target timestamp, or use the Time
   Travel assist to run read-only queries at that timestamp first.
3. Choose **Restore to a new branch** and name it `restore-<yyyymmdd>-<hhmm>`.
4. Inspect the new branch (row counts, the affected records).
5. If correct, restore `main` itself from the same timestamp. Neon keeps a
   backup branch of the pre-restore state, named
   `main_old_<timestamp>`, which also uses a branch slot.
6. Delete `restore-*` and `main_old_*` branches once you are done, so the
   branch count returns to 3/10 (AUTH-T09 treats leftovers as clutter).

CLI equivalent:

```sh
neonctl branches restore main "^self@<timestamp>" --project-id <NEON_PROJECT_ID> --preserve-under-name main_old_before_restore
```

`<timestamp>` is RFC 3339 in UTC, for example `2026-10-01T14:30:00.000Z`.
`--preserve-under-name` is required when restoring a branch to its own history
(`^self`). Quote the `"^self@<timestamp>"` argument: `^` is the escape
character in Windows `cmd.exe`, so unquoted it is silently mangled.

## After the restore: re-check

A restore resets the branch's data and catalog state to the target moment.
Verify each of the following before declaring recovery complete:

- [ ] **Roles still exist and have the right privileges.** The runtime role has
      DML only (no DDL); the migration role owns the `public` schema. Role changes
      made after the target timestamp are undone by a restore.
- [ ] **Connection strings still work.** `DATABASE_URL` (pooled, runtime role) and
      `DIRECT_URL` (direct, migration role) both connect. If a role password was
      rotated after the target timestamp, the old password is back in effect:
      rotate again and update Vercel env and the password manager.
- [ ] **Auth state is re-applied.** A restore rewinds the whole database, so
      anything done after the target timestamp is undone: sessions revoked,
      accounts deactivated or deleted, password resets, lockouts, and signing-key
      rotations. Revoked sessions become valid again and a compromised account may
      be back in service. Re-apply every post-timestamp revocation, deactivation,
      deletion, reset and lockout (use the audit log and incident notes, and note
      that the audit log is also rewound). Then force-expire every session
      created before the restore, and confirm the JWT signing keys published in
      JWKS match the restored key table (rotate again if a key was rotated or
      revoked after the timestamp).
- [ ] **Branch count** is back to 3/10 (`main`, `dev`, `test`).
- [ ] **Migration state.** `_prisma_migrations` matches the migrations in the
      deployed commit.
- [ ] **A real login works** on `auth.northeasternsga.com`.
- [ ] Record what happened, the timestamp used, and the data lost in the
      incident notes.
