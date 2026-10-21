# Architecture

SGAuth runs on Neon serverless Postgres and does not use Supabase for any
purpose.

> This is a starting file created by AUTH-T101. The rest of the architecture
> document lands with AUTH-T79, which extends this file and keeps the section
> below.

## Known limitations

### Neon Free plan quota

SGAuth launches on the Neon **Free** plan, which allows **100 CU-hours of
compute per month** per project. Past that, Neon suspends the compute until the
monthly period resets, and every SGA product's login goes down at once. A
compute that stays awake all day at the 0.25 CU minimum uses about 180
CU-hours a month, so exhaustion is plausible once several products are live.

Mitigations:

- A daily job (`.github/workflows/neon-quota-monitor.yml`) emails alerts at
  50%, 70%, 85% and 100% of the quota, with a projected exhaustion date.
- Scale-to-zero stays at 5 minutes, and the SDK's 60 second session cache keeps
  idle periods idle so the compute can suspend.
- No keep-warm pings, ever: they burn the quota (see `docs/ENGINEERING.md`).
- The upgrade runbook, [`runbooks/neon-upgrade.md`](runbooks/neon-upgrade.md),
  moves the project to Launch. Its trigger is 85% of the quota or any
  suspension.

### 6-hour restore window

History retention on the `main` branch is capped at **6 hours** on the Free
plan. A problem noticed after that is not recoverable from Neon itself. The
procedure and its limits are in
[`runbooks/neon-restore.md`](runbooks/neon-restore.md). The Launch plan extends
the window to 7 days.

## Security policies

- [SUBDOMAIN-POLICY.md](SUBDOMAIN-POLICY.md): who may have a
  `northeasternsga.com` subdomain, and why every one can read the session
  cookie.
