# Retention job

A daily job, `POST /api/jobs/retention` (08:23 UTC, from
`.github/workflows/scheduled-jobs.yml`), removes personal data on a schedule.
The rules and their thresholds are in `src/lib/retention/policy.ts`. The policy
as users see it is in [DATA_HANDLING.md](../DATA_HANDLING.md#retention).

## Rules

| Step                 | Selects                                                                               | Does                                       |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| `deactivated`        | Deactivated for 30 days, not an admin                                                 | Tombstones (`reason: deactivated_30d`)     |
| `inactive-tombstone` | Active, not an admin, noticed at least 30 days ago, and 12 months since sign-in       | Tombstones (`reason: inactive_12mo`)       |
| `inactive-notice`    | Active, not an admin, 11 months since sign-in, no notice since that sign-in           | Emails the inactivity notice               |
| `unverified`         | Self sign-up, never verified, never signed in, 7 days old                             | Tombstones (`reason: unverified_7d`)       |
| `purge`              | Sessions expired or created over 90 days ago; expired verifications and unlock tokens | Deletes them                               |
| `pii`                | Audit rows older than 90 days with an IP or user agent                                | Nulls the IP and user agent; the row stays |

- **Sign-in age** is `lastLoginAt`, or the creation date for a user who never
  signed in.
- **A late notice still gives 30 days.** The tombstone date is the later of
  12 months after sign-in and 30 days after the notice, and the email states it.
- **A sign-in after the notice cancels it.** The user gets a new notice after the
  next 11 months.
- **Notices are recorded only when sent.** A capped or failed send is retried the
  next day.
- **An unverified sign-up is tombstoned, not hard deleted.** Users are never hard
  deleted (ENGINEERING section 2). The tombstone frees the address.
- **Holding a position does not exempt a user.** Being an admin, or the Primary
  Admin, does.

Each tombstone writes one `USER_DELETED` audit row. Its `reason` names the rule
and its `removedPositionIds` lists the positions the user held. No
`POSITION_UNASSIGNED` rows are written.

## Batch caps

A run tombstones at most 50 users and emails at most 50 notices, so a large
backlog (the first run after the Chambers import) spreads over several days and
stays under the email caps. The `deferred` counts say how many rows were left.

## Dry run

A dry run selects what a real run would and writes nothing: no update, delete,
email or audit row. Its counts are "would do" counts.

```sh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://auth.northeasternsga.com/api/jobs/retention?dryRun=1"
```

`dryRun` takes `1` or `true`. Any other value answers `400` and does nothing.

## The response and the logs

The response is `{ job, ok, result }`. `result` holds `tombstoned`, `notices`,
`purged`, `anonymizedAuditRows`, `exempt`, `deferred` and `errors`. The
`job.completed` log line carries the same fields. Logs hold ids and counts, never
an email address or a name.

A step that throws is counted in `errors` and logged as `retention_step_failed`
with its `step`. The later steps still run. If `errors` is above zero the job
logs `[ALERT] retention job had errors` and answers `500`, so the Actions run
turns red and the alerts job emails "Scheduled job failed". The work that did
succeed has committed, and the next run tries the rest.

## Manual review list

`retention_exempt` is logged as a warning, once per rule, with the ids of the
admins and the Primary Admin that are past a threshold. The job never touches
them. For each one, an admin decides: revoke admin and let the rule apply, or
tombstone the account through the admin delete. The Primary Admin must transfer
the role first.

The same list, with the date each user will be tombstoned, is
`GET /api/sgauth/admin/users/upcoming-tombstones?withinDays=30` (admin only,
1 to 90 days). It includes users already past their date. The users list page
(#60) is to render it.

## Reading a tombstone

The id still resolves: the row stays with `status: DELETED`, the email
`deleted+<id>@invalid` and the name "Deleted user". Audit rows keep their
`actorUserId` and lose their IP and user agent. A tombstoned
address can register again as a new account with a new id.
