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

## Never add keep-warm pings

Do not schedule or poll database traffic to keep the compute awake. Scale-to-zero
is what keeps SGAuth inside the Free quota.

## Other runbooks

- [neon-restore.md](neon-restore.md): restore `main` to an earlier point in time.
- [neon-upgrade.md](neon-upgrade.md): move the project to the Launch plan.
- [legacy-bcrypt.md](legacy-bcrypt.md): imported bcrypt hashes still awaiting re-hash, and when to remove the path.

## Upgrade log

Record each plan change here: date, who approved, and the plan now in force.
None yet.
