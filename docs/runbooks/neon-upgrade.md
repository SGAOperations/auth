# Runbook: upgrade the Neon project from Free to Launch

Applies to the `sgauth` Neon project (region `aws-us-east-1`).

## When to upgrade

The upgrade trigger is **85% of the monthly compute quota, or any suspension**.

The Free plan allows 100 CU-hours of compute per month. At 100% Neon suspends
the compute **until the monthly period resets**, and every SGA product's login
is down for all of that time. A daily job emails an alert at 50%, 70%, 85% and
100% (`.github/workflows/neon-quota-monitor.yml`). The alert can arrive up to
about a day after the crossing, so do not wait for 100%. Act the day the 85%
email arrives, or as soon as you see a suspension.

## Who approves

The **Vice President of Operational Affairs** approves the spend. The upgrade
itself is done by a member of the SGAOperations Neon org with the **Admin**
role.

## Cost

Launch is pay-as-you-go at **$0.106 per CU-hour**. For example, a compute that
stays awake all month at the 0.25 CU minimum uses about 180 CU-hours, which is
about $19. SGAuth keeps scale-to-zero on, so real usage is usually lower.
Re-check current pricing on neon.com/pricing before asking for approval.

## Steps

1. Get the approval above, and write down who approved and when.
2. In the Neon console open the SGAOperations org, then **Billing**, then
   **Change plan**, and choose **Launch**.
3. Pay with a payment method from the SGA account, never a personal card.
4. Confirm the compute is active (**Branches**, then `main`, then **Compute**)
   and that a real login works on `auth.northeasternsga.com`.

## What changes

- **Restore window goes from 6 hours to 7 days.** Raise history retention on
  `main` to match, and update the limitation section of
  [neon-restore.md](neon-restore.md).
- **Scale-to-zero becomes configurable.** Keep it at 5 minutes. Never add
  keep-warm pings: on a pay-as-you-go plan they cost money.
- **The quota alerts no longer apply.** Disable the Neon quota monitor workflow,
  or raise `QUOTA_CU_HOURS` in `scripts/neon-quota-monitor.mjs` in a follow-up.

## After

Record the upgrade in the [on-call notes](on-call.md): the date, who approved,
and the plan now in force.
