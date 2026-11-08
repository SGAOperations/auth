# Slack mandate for leaders

Anyone holding a leadership position must allow Slack title updates to use SGA
tools. This is a policy change, so the gate ships off
(`SGAUTH_SLACK_MANDATE_ENABLED=false`) and is turned on per environment, `dev`
(the SGA Testing workspace) first. What it checks and where it blocks:
[integration/slack.md](../integration/slack.md).

Audit event: `SLACK_MANDATE_BLOCKED`.

## Preconditions

Do not turn it on until each of these is recorded here with a link.

| Precondition                               | Record                                          |
| ------------------------------------------ | ----------------------------------------------- |
| EVP approval (given, per #355)             | link to the approval                            |
| Privacy review sub-issue closed            | link to the closed sub-issue                    |
| Canary (#356) recorded                     | link to the canary result                       |
| Slack app configured for the title consent | [integration/slack.md](../integration/slack.md) |

The gate is not enforced by code: these preconditions and the default-off flag
are the control.

## Turn it on

1. On `dev`, set `SGAUTH_SLACK_MANDATE_ENABLED=true` in Vercel. The Slack app
   variables (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_TEAM_ID`) must be
   set, or startup fails naming the flag.
2. Redeploy.
3. Verify on `dev`:
   - A leader without title access opens a product and lands on
     `/login` with "Allow Slack title updates to continue".
   - The audit log, filtered by "Blocked by Slack title requirement", shows one
     row with surface `session`. Reloading adds no more rows.
   - **Allow Slack title updates**, then approve on Slack. `/login` shows "SGAuth
     can now update your Slack title." and **Continue** reaches the product.
   - Cancelling on Slack leaves the interstitial with an alert.
   - **Stop title updates** on the account card blocks the product again, and a
     new audit row appears.
   - A non-leader with no Slack link keeps full access, with no notice and no row.
4. Repeat on `production`.

## Turn it off

Unset the flag (or set it to `false`) and redeploy. No data changes. Expect up to
60 seconds of product-side session caching before a leader is let through.

## Reading the blocks

Filter the audit log by "Blocked by Slack title requirement". A row means a
leader without title access was refused on that surface (`session` or `token`).
Rows are written at most once per user per day, plus once after each grant.
