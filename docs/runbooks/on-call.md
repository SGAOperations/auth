# On-call notes

Short notes for whoever is watching SGAuth. Each runbook linked here has the
detail.

## Neon quota alerts

A daily job emails the alert recipients when the `sgauth` project's compute
usage crosses a share of the Free plan's 100 CU-hour monthly quota.

| Alert              | What it means                                    | What to do                                                                                                       |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 50% and 70%        | Usage is climbing; the email has a projection.   | Check the projected exhaustion date. Look for anything that keeps the compute awake (see below). No upgrade yet. |
| 85%                | **Upgrade trigger.**                             | Follow [neon-upgrade.md](neon-upgrade.md) today. The Vice President of Operational Affairs approves the spend.   |
| 100% or suspension | The compute is suspended until the period resets | Every SGA login is down. Upgrade now per [neon-upgrade.md](neon-upgrade.md).                                     |

**Upgrade trigger: 85% of the quota, or any suspension.**

## "Neon quota monitor failed" email

The job could not read usage from Neon or could not validate the response.
Open the failed run of **Neon quota monitor** in GitHub Actions, and check the
`NEON_API_KEY` and `NEON_PROJECT_ID` secrets. Until it is fixed, no quota
alerts are sent. The secrets (`NEON_API_KEY`, `NEON_PROJECT_ID`,
`RESEND_API_KEY`, `NEON_QUOTA_ALERT_TO`) live in the repository's Actions
secrets, and the values are in the team password manager.

## Security alert emails

A job every 15 minutes (`POST /api/jobs/alerts`) counts security events and
emails every active, verified admin one summary covering each condition it
found. Each condition is reported at most once an hour. A condition that
appears during that hour is reported by the first run after it.

| Condition                                | What it means                                                       | First step                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Failed sign-in spike (over 50 in 15 min) | Credential stuffing or a broken client.                             | Check Vercel logs for `[ALERT] rate-limit` and the sign-in 429 rate. Look for one IP or one account.       |
| Account lockout spike (over 5 in 1 h)    | Several accounts were locked after repeated failures.               | Check the audit log for `ACCOUNT_LOCKED` targets. Same address range, or a targeted account?               |
| Break-glass recovery used                | The Primary Admin was recovered outside the normal transfer.        | Confirm with the Primary Admin immediately. See [break-glass.md](break-glass.md).                          |
| Primary Admin transfer started           | A transfer was initiated.                                           | Confirm it was expected. The cooling period lets the sender cancel.                                        |
| Signing keys rotated                     | The token signing keys changed.                                     | Confirm the rotation was planned. Products refetch the JWKS on their own.                                  |
| Scheduled job failed                     | A job route threw. The email names the job.                         | Open the failed run in GitHub Actions and the Vercel logs for `job.failed`.                                |
| Upstash fail-open                        | Rate limits or email caps were not enforced while Upstash was down. | Check Upstash status and the `UPSTASH_REDIS_REST_*` settings. See [RATE-LIMITING.md](../RATE-LIMITING.md). |

If an alert cannot be delivered (no eligible admin, or every send failed), the
job fails and the Actions run turns red. The condition is not marked as
reported, so the next run tries again.

## Retention job

A daily job (`POST /api/jobs/retention`) tombstones deactivated and inactive
users and purges expired sessions and tokens. See [retention.md](retention.md).

| Signal                             | What it means                                                         | First step                                                                              |
| ---------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `[ALERT] retention job had errors` | A step failed. The run is red and "Scheduled job failed" is emailed.  | Find `retention_step_failed` in the Vercel logs for the step. The next run tries again. |
| `retention_exempt` warning         | An admin or the Primary Admin is past a threshold and was left alone. | Review them by hand, as in [retention.md](retention.md#manual-review-list).             |

## Never add keep-warm pings

Do not schedule or poll database traffic to keep the compute awake. Scale-to-zero
is what keeps SGAuth inside the Free quota.

## Quarterly checks

- Subdomain review: the workflow opens an issue on the 1st of January, April, July and October. Follow [subdomain-review.md](subdomain-review.md) and close it within the month.

## Other runbooks

- [break-glass.md](break-glass.md): recover the Primary Admin when the normal
  transfer cannot run.
- [neon-restore.md](neon-restore.md): restore `main` to an earlier point in time.
- [neon-upgrade.md](neon-upgrade.md): move the project to the Launch plan.
- [legacy-bcrypt.md](legacy-bcrypt.md): imported bcrypt hashes still awaiting re-hash, and when to remove the path.
- [subdomain-review.md](subdomain-review.md): inventory the DNS zone and remove dangling records.
- [chambers-import.md](chambers-import.md): one-time import of Chambers users, passwords and positions.
- [retention.md](retention.md): the daily retention job, its dry run and its manual-review list.

## Upgrade log

Record each plan change here: date, who approved, and the plan now in force.
None yet.
