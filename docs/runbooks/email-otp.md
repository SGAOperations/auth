# Runbook: decide on, and switch on, email sign-in codes

Sign-in by emailed 6-digit code is built and **off by default in every
environment**. Password is the launch sign-in method because the email volume is
constrained by the Resend free tier. This runbook is how the decision to turn
codes on is made, and how it is flipped and rolled back. The code never makes
the decision.

Who runs it: an admin with access to the Resend dashboards, the Vercel
environment variables and the Vercel log search.

## What it is and why it is off

The Better Auth `emailOTP` plugin, limited to **sign-in** for an existing,
verified, non-admin account without MFA. Admins and accounts with two-factor
authentication are refused, because Better Auth's `twoFactor` plugin only
intercepts the password, username and phone sign-ins, and a code sign-in would
skip the second factor. A code never creates an account, and every other code
route (verify email, password reset, change email) is shut.

With `SGAUTH_EMAIL_OTP_ENABLED` off, the plugin is not registered: the
`/api/auth/email-otp/*` routes and `/login/code` return 404 and `/login` shows
no link. Background and decision record: issue #112.

## Review window

The window starts on the day Aplio's switch from email OTP to Slack OTP ships,
because that switch should cut the combined volume a lot. It needs **at least 60
days of data after SGAuth's launch** ([launch-checklist.md](launch-checklist.md)).
Record both dates in the comment from step 5:

- Aplio Slack-OTP switch shipped: `<yyyy-mm-dd>`
- SGAuth production launch: `<yyyy-mm-dd>`
- Window: from the later of the two, for 60 days or more.

## Measuring the budget

The budget is **all SGA email across every Resend account**: the Chambers/Aplio
account and the SGAuth account together, not SGAuth's alone. For the window,
record:

1. From each Resend dashboard, the **daily send counts**. Add the two accounts
   day by day, then take:
   - the combined **peak day**,
   - the combined **95th-percentile day**,
   - the combined **monthly total** (the busiest 30 days).
2. SGAuth's **daily password-reset request count**: search the production logs
   for `email_sent` lines with `template` `reset-password` ([EMAIL.md](../EMAIL.md))
   and count them per UTC day. This is the proxy for code demand. Take its
   **peak day** and its **95th-percentile day**.
3. The Resend free-tier numbers (daily and monthly quota), **quoted from
   Resend's pricing page on the decision date**. Write the date down with them.

## Decision rule

Let **projected code volume** be 2 times the peak daily reset count.

Go **only if both hold**:

- combined peak day + projected code volume is at most **80% of the combined
  daily free quota**, and
- combined monthly total + 30 times the 95th-percentile daily reset count is at
  most **80% of the combined monthly quota**.

If either fails, the answer is no: leave the flag off. Passwords and the reset
flow stay the sign-in methods.

If it is a go, set `SGAUTH_EMAIL_OTP_DAILY_CAP` to the **headroom left at 80%
of the combined daily quota** after the combined peak day (and never more than
the headroom the monthly rule allows, spread over 30 days). The cap counts every
code request, so it bounds email volume no matter how the traffic looks. Over
the cap the page shows "Email codes are unavailable right now" and password
sign-in is unaffected.

The counter runs before eligibility is known, so requests for unknown or
ineligible addresses spend the cap too. This is by design: refusing at the cap
only for eligible addresses would show which addresses are eligible. The cost is
that a few IPs, each held to the per-IP send limit (10 an hour), can use up the
day's cap and turn code sign-in off for everyone until the next UTC day. Password
sign-in is unaffected. Treat an unexpected `daily cap reached` alert as possible
abuse and look at the `emailOtpSend` rate-limit logs before raising the cap.

## Record the decision

Post a comment on issue #112 with the numbers, the result of each half of the
rule, and the decision (go with a cap of N, or no go).

The pull request that built this feature closed #112 on merge, but the
acceptance criterion (a decision after 60 days of data) is met by this comment,
not by the merge. Reopen #112 until the comment is posted.

## Flip

1. In Vercel, set `SGAUTH_EMAIL_OTP_ENABLED=true` and `SGAUTH_EMAIL_OTP_DAILY_CAP`
   on the **dev** environment. Redeploy dev.
2. Smoke-test on `auth-dev.northeasternsga.com` with a synthetic, verified,
   non-admin user without MFA:
   - `/login`, password step: the "Email me a sign-in code instead" link shows.
   - Request a code, receive the email, enter it, and land on the SGAuth home page (`/`).
   - A wrong code three times, and a code past its 10 minutes, answer the same
     "That code didn't work" as a wrong code: the page never says "too many
     attempts" or "expired", since either would show the address is eligible.
   - An admin or an MFA account gets the same screens but no email, and a code
     read from the database cannot sign it in.
3. Confirm the audit log shows `LOGIN_SUCCESS` with method `email_otp` for the
   good sign-in and `LOGIN_FAILED` rows with method `email_otp` for the bad ones.
4. Set the same two variables on **Production** and redeploy.

Both variables are server-only. `SGAUTH_EMAIL_OTP_ENABLED` must be exactly `true`
or `false`: any other value stops the app from starting.

## Rollback

Set `SGAUTH_EMAIL_OTP_ENABLED=false` (or remove it) and redeploy. No data
cleanup is needed: codes live in the `Verification` table and expire within 10
minutes. Sessions already created by a code stay valid like any other session.

## Watching it after the flip

- `email_otp_skipped` log lines carry `recipientHash` and the refusal reason,
  never an address.
- `[ALERT] email-otp daily cap 80%` and `[ALERT] email-otp daily cap reached`
  log once a day each. Reaching the cap means the cap, or the demand, needs a
  look.
- `[ALERT] email-otp send counter unavailable` means Upstash is down. Code
  requests answer unavailable until it recovers (the counter fails closed);
  password sign-in is unaffected.
- Accounts imported without a password can sign in by code without ever setting
  one. That is intended, since a code proves control of the mailbox as much as a
  set-password link does, but it means those accounts may never set a password.
  Watch for it in the review.
