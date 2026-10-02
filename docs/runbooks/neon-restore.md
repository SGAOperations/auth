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
4. Know that the restore rewinds **auth state**, not just data: anything
   revoked, deactivated, rotated or changed after the target timestamp comes
   back as it was. The rewound `main` is live the moment the restore completes,
   so the exposure window described under "Close the exposure window first"
   below starts then. Step 5 below takes SGAuth offline before that moment, and
   traffic stays off until step 8 is complete.

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
5. **Take SGAuth offline (maintenance mode) before you touch `main`.** This
   is required, not optional. Do it before step 6 so the restored database is
   never reachable by live traffic. If you cannot take the deployment offline,
   stop here: leave `main` alone, keep the `restore-*` branch, and escalate to
   the second SGA operator.
6. If correct, restore `main` itself from the same timestamp. Neon keeps a
   backup branch of the pre-restore state, named `main_old_<timestamp>`, which
   also uses a branch slot. **That branch is the only surviving copy of the
   audit rows, revocations and other auth state written after the target
   timestamp** (the restored `main`'s audit log is rewound). Do not delete it
   yet.
7. Force-expire every session on the restored `main` (see the next section).
   SGAuth is still offline.
8. Work through the re-apply list below, using `main_old_*` as the source of
   truth for what must be re-applied. **SGAuth stays offline until every item
   on that list is re-applied or deliberately ruled out.** Only then bring it
   back online.
9. Delete `restore-*` only when you are done. Delete `main_old_*` last, and
   only when every condition under "Keep `main_old_*` until" below is met, so
   the branch count returns to 3/10 (AUTH-T09 treats leftovers as clutter).

CLI equivalent:

```sh
neonctl branches restore main "^self@<timestamp>" --project-id <NEON_PROJECT_ID> --preserve-under-name main_old_before_restore
```

`<timestamp>` is RFC 3339 in UTC, for example `2026-10-01T14:30:00.000Z`.
`--preserve-under-name` is required when restoring a branch to its own history
(`^self`). Quote the `"^self@<timestamp>"` argument: `^` is the escape
character in Windows `cmd.exe`, so unquoted it is silently mangled.

## Close the exposure window first

A restore rewinds the whole database, so anything done after the target
timestamp is undone: sessions revoked, accounts deactivated or deleted,
password resets, lockouts, passkey and 2FA changes, signing-key rotations.
From the moment `main` is restored, revoked sessions are valid again and a
compromised account may be back in service.

**Principle: traffic does not come back until the auth state an attacker could
exploit has been re-applied, not just until old sessions are dead.**
Force-expiring sessions is necessary but not sufficient. An attacker whose
account deactivation was rewound, or whose old password, passkey or disabled
2FA came back, simply signs in again and gets a brand-new, legitimately issued
session. So the exposure window runs from the restore until the whole
re-apply list below is done, and SGAuth stays in maintenance mode for all of it.

> Table and column names in this runbook ("the session table", "the key
> table", and so on) are provisional. The schema is still Supabase-shaped, and
> the real names are not settled until AUTH-T10 lands the Neon schema. Re-check
> them against the live schema rather than assuming they were verified.

Do these in order, with SGAuth offline throughout:

1. **Before promoting `main` (step 6), write down the target timestamp and the
   restore time**, so the post-timestamp window is unambiguous. Neon preserves
   everything written in that window in `main_old_*` once the restore happens.
2. **Take SGAuth offline first** (step 5), then promote `main`. The restored
   database must never serve live traffic while it holds rewound auth state.
3. **Force-expire every session** on the restored `main` (delete or expire all
   rows in the session table, so every user must sign in again). Every
   consuming product's short-lived JWT also stops being refreshable once its
   session is gone.
4. **Re-apply the post-timestamp auth state** listed below, starting with
   revocations and deactivations and then passwords and tokens, while still
   offline.
5. **Only then bring SGAuth back online**, once force-expiry and every item in
   the re-apply list are done or deliberately ruled out.

## Re-apply auth state from `main_old_*`

Query `main_old_*` (read-only; it holds the post-timestamp audit log and
revocations that the restored `main` no longer has) and diff its audit log
against the restored `main` to list everything that happened after the target
timestamp. Re-apply each of these, and record each as done:

- [ ] **Revocations and deactivations.** Every session revoked, account
      deactivated or deleted, and lockout applied after the timestamp (a
      compromised account must not come back into service).
- [ ] **Passwords and tokens.** Password changes and resets, and any
      **unexpired password-reset or email-verification token** issued or
      consumed after the timestamp: a consumed token is valid again, and a
      token issued afterward is gone. Invalidate all outstanding ones on the
      restored `main` and let users request new ones.
- [ ] **Passkeys and 2FA.** Passkeys removed or added and 2FA enrolled, reset
      or disabled after the timestamp. A removed passkey or disabled 2FA that
      comes back is a security regression; an enrollment that disappears locks
      the user out of their second factor.
- [ ] **Admin and position state.** `PrimaryAdminTransfer` rows (a transfer
      that was mid-flight or completed after the timestamp is rewound, which
      can leave the wrong person as Primary Admin or a stale pending transfer)
      and position or role changes, including demotions and removals that were
      silently undone.
- [ ] **Signing keys.** Confirm the JWT signing keys published in JWKS match the
      restored key table; rotate again if a key was rotated or revoked after
      the timestamp.

### Keep `main_old_*` until

Delete `main_old_*` only when **all** of these hold:

- every item above has been re-applied or deliberately ruled out, and noted in
  the incident record;
- the audit rows and revocations from the post-timestamp window have been
  extracted and attached to the incident notes (export the audit log rows,
  revoked-session and deactivation records, and `PrimaryAdminTransfer` and
  position/role changes from `main_old_*`), because they exist nowhere else;
- a second SGA operator has confirmed the above.

Its retention must outlive all of this work. If the branch budget (10 total)
is the pressure, free a slot by deleting `restore-*` or other temporary
branches, not `main_old_*`. If AUTH-T09's cleanup would remove it before you
are done, stop that job's deletion of this branch until the incident closes.

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
- [ ] **Auth state is re-applied.** Done per the two sections above
      (SGAuth offline, sessions force-expired, everything re-applied from
      `main_old_*`, and only then back online); do not tick this until
      `main_old_*` has been extracted.
- [ ] **Branch count** is back to 3/10 (`main`, `dev`, `test`).
- [ ] **Migration state.** `_prisma_migrations` matches the migrations in the
      deployed commit.
- [ ] **A real login works** on `auth.northeasternsga.com`.
- [ ] Record what happened, the timestamp used, and the data lost in the
      incident notes.
