# SGAuth rollout plan

SGAuth is one login at `auth.northeasternsga.com`, rolled out to each SGA product in turn. Each product's cutover ticket runs the checklist in §3 against its own row in §1 and §4. The order comes from the "Rollout" row of the [design summary](sgauth-design/SGAuth-design-summary.md).

Owners, contacts, dates and review status are `TBD` until the owner reviews happen. Fill them in as each review is held.

## 1. Order and schedule

| #   | Product                                   | Subdomain                      | Cutover ticket                                                           | Owner | Named support contact | Backup contact | Target date | Owner review (date) | Status |
| --- | ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------ | ----- | --------------------- | -------------- | ----------- | ------------------- | ------ |
| 0   | SGAuth MVP                                | `auth.northeasternsga.com`     | Gate: [#103](https://github.com/SGAOperations/auth/issues/103)           | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 1   | VaultZ                                    | `finance.northeasternsga.com`  | [vaultz#753](https://github.com/SGAOperations/vaultz/issues/753)         | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 2   | Chambers                                  | `chambers.northeasternsga.com` | [chambers#154](https://github.com/SGAOperations/chambers/issues/154)     | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 3   | Aplio (dual write, scheduled read switch) | `apply.northeasternsga.com`    | [aplio#738](https://github.com/SGAOperations/aplio/issues/738)           | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 4   | SenatePath                                | TBD                            | [senate-path#90](https://github.com/SGAOperations/senate-path/issues/90) | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 5   | Attendance Manager (SenatePortal)         | TBD                            | ATTENDANCE-M05 (not yet filed)                                           | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |

Step 0 is the SGAuth MVP itself. Nothing is announced at this step.

Ordering rules:

- VaultZ goes first. It has no per-user auth to unwind, and it proves the SDK.
- Chambers goes next. It has the most users, and their credentials are pre-imported.
- Aplio needs a date with no application cycle open. Its read switch happens at one scheduled instant, and new signups are written to both systems until then ([aplio-import.md](runbooks/aplio-import.md)).
- SenatePath needs its Neon migration ([senate-path#88](https://github.com/SGAOperations/senate-path/issues/88)) done first.
- Attendance Manager waits on the pending Supabase-vs-Neon directive, which picks ATTENDANCE-M02 or M03.
- A product does not start its cutover until the previous product's 3-day support window has closed with no open rollback. One product at a time.

## 2. Before any product (platform gate)

The production launch checklist, [#103](https://github.com/SGAOperations/auth/issues/103) (AUTH-T91), must be signed off by the Primary Admin before step 1. Its items are not repeated here.

One carried risk: the design recommends upgrading Neon Free to Launch before the Chambers cutover (accepted risk; see [neon-upgrade.md](runbooks/neon-upgrade.md)). It is a Chambers go/no-go item that the operator decides, not a requirement.

Per-product integration steps live in the integration guide ([#92](https://github.com/SGAOperations/auth/issues/92), AUTH-T80). User imports live in [#99](https://github.com/SGAOperations/auth/issues/99) (Chambers), [#100](https://github.com/SGAOperations/auth/issues/100) (Aplio) and [#101](https://github.com/SGAOperations/auth/issues/101) (SenatePath and SenatePortal).

## 3. Per-product cutover checklist

Copy this list into the cutover ticket.

**T-7 days (prepare)**

- [ ] Users pre-imported on dev, then on production, using the import ticket for the product. The import report and the id-mapping file go to the product team.
- [ ] Position mapping file approved by the Primary Admin.
- [ ] Product registry entry created: slug, name, `https://<sub>.northeasternsga.com`, visibility positions.
- [ ] Subdomain DNS points at the product's Vercel project, HTTPS only.
- [ ] Product env vars set per the integration guide ([#92](https://github.com/SGAOperations/auth/issues/92)).
- [ ] `@nusgaops/sgauth` pinned to an exact version, and the version recorded in the ticket.
- [ ] Rollback mechanism (§4) rehearsed on the product's dev or preview domain.
- [ ] Date confirmed with the owner, and support contacts named in §1.

**T-2 days (announce)**

- [ ] Send the right template from §6 from the SGA shared mailbox, and record the send time. Do not send announcements through SGAuth's Resend account or the product's mailer. SGAuth's Resend account is reserved for transactional auth email, with per-recipient and global caps.

**T-0 (cut over)**

- [ ] Deploy the SGAuth-enabled release.
- [ ] Smoke test:
  1. A sample imported user signs in on the product. For Chambers this is with their existing password. For everyone else it is through the set-password email.
  2. The session shows on the account page at `auth.northeasternsga.com`.
  3. A position-gated page allows a holder and denies a non-holder.
  4. Opening a second, already-live product needs no further sign-in.
  5. Signing out on the product signs the user out on the other product as well.
- [ ] Go/no-go: if any smoke step fails, or sign-in is broken for imported users, roll back (§4) and do not announce completion.

**T+0 to T+3 days (support window)**

- [ ] Run the support window in §5.

**T+14 days**

- [ ] Post-launch review per AUTH-T92 ([#104](https://github.com/SGAOperations/auth/issues/104)), recorded in §7.

## 4. What differs per product

| Product            | Users come from                                                                                     | First sign-in                                                                              | Rollback                                                                                                                                                                                             | Legacy auth kept for                 | Template                   |
| ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------- |
| VaultZ             | Admin-created or self-sign-up (no accounts today)                                                   | Lazy set-password flow ([#34](https://github.com/SGAOperations/auth/issues/34)) or sign-up | Flip `SGAUTH_ENABLED` (vaultz#748)                                                                                                                                                                   | Passphrase gate kept for one release | A                          |
| Chambers           | [#99](https://github.com/SGAOperations/auth/issues/99) (bcrypt hashes)                              | Existing password                                                                          | Previous deployment, with Supabase auth intact                                                                                                                                                       | 7 days                               | B                          |
| Aplio              | [#100](https://github.com/SGAOperations/auth/issues/100) (password-less; Chambers duplicates merge) | Set-password email                                                                         | Redeploy the previous release. Through T, Aplio's own user table is current because of the dual write, so rollback means reverting Aplio's read switch ([aplio-import.md](runbooks/aplio-import.md)) | Better Auth tables kept for 14 days  | A plus the Aplio paragraph |
| SenatePath         | [#101](https://github.com/SGAOperations/auth/issues/101) (admins only)                              | Set-password email                                                                         | Redeploy the previous release                                                                                                                                                                        | Supabase project kept for 14 days    | A                          |
| Attendance Manager | [#101](https://github.com/SGAOperations/auth/issues/101) (SenatePortal)                             | Set-password email                                                                         | TBD (depends on the directive)                                                                                                                                                                       | TBD                                  | A                          |

Never delete legacy auth data or a Supabase project before its retention window ends. Before the bcrypt verify path is removed, AUTH-T92 checks that no `bcrypt$` hashes remain (see [legacy-bcrypt.md](runbooks/legacy-bcrypt.md)).

## 5. Support window (3 days)

The window starts when the cutover deploys and ends 72 hours later. The named contact from §1 checks the SGA shared mailbox at least twice a day, and the backup covers any gap. Escalate to the SGAuth operator for anything not in this table.

| Symptom                                   | Action                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Set-password or unlock email not received | Check spam and Microsoft Safe Links quarantine, then resend from the login page. Admins can push an invite to that one person. |
| "Account locked"                          | Use the emailed unlock link, or wait for the lock to expire.                                                                   |
| Signed in but sees nothing                | Missing position. The product owner requests it from an SGAuth admin.                                                          |
| Non-northeastern.edu Aplio address        | An admin moves the account to the person's northeastern.edu address (AUTH-T24). The id is kept.                                |
| Chambers password rejected                | The user resets with the set-password or reset email. Record the count, because CHAMBERS-C07's acceptance tracks stragglers.   |
| Widespread sign-in failure                | Roll back (§4) and notify the owner.                                                                                           |

## 6. Email templates

Plain text. Placeholders are in `{curly}` form.

### Template A: one login for all SGA tools

Used for VaultZ, Aplio, SenatePath and Attendance Manager.

```
Subject: {Product} now uses your SGA login

Hi {first name},

Starting {date}, you'll sign in to {Product} with SGAuth, one login for all SGA tools. The same account will work for every SGA tool as each one moves over.

What to do:
1. Go to {product URL} and choose Sign in. You'll land on auth.northeasternsga.com.
2. Enter your {email used in Product} address.
3. The first time, we'll email you a link to set your password. Open it, choose a password of at least 12 characters, and you're in.

Your {Product} data hasn't changed. It's all still there.

Stay safe: we'll never ask for your password by email. Only enter it on a page whose address starts with https://auth.northeasternsga.com.

Questions? Email {support contact} at {support address} through {window end date}.

{sender name}
SGA {sender role}
```

Aplio paragraph, inserted after step 3:

```
Aplio used to send you a one-time code each time you signed in. From now on you'll use the password you set in step 3 instead.
```

### Template B: Chambers (your password keeps working)

```
Subject: Chambers now uses your SGA login — your password stays the same

Hi {first name},

Starting {date}, Chambers sign-in moves to SGAuth, one login for all SGA tools.

Your existing Chambers password keeps working. Go to chambers.northeasternsga.com, choose Sign in, and use the same email and password as before. You don't need to reset anything.

The same login will also work for other SGA tools as they move over.

If your password doesn't work, choose "Forgot password?" on the sign-in page and we'll email you a link.

Stay safe: we'll never ask for your password by email. Only enter it on a page whose address starts with https://auth.northeasternsga.com.

Questions? Email {support contact} at {support address} through {window end date}.

{sender name}
SGA {sender role}
```

## 7. Post-launch reviews

Fourteen days after each cutover (the T+14 step in §3), the SGAuth operator and the product owner fill in a copy of the template below for that product and commit it here.

Tracked by AUTH-T92 ([#104](https://github.com/SGAOperations/auth/issues/104)) and its per-product cleanup sub-issues.

### 7.1 Review tracker

`Status` is `Not started`, `In review` or `Done`. `Done` means the review is committed and the cleanup sub-issue is closed.

| Product            | Cutover date | Review due (cutover + 14 d) | Reviewed on | Cleanup sub-issue                                                          | Outcome | Status |
| ------------------ | ------------ | --------------------------- | ----------- | -------------------------------------------------------------------------- | ------- | ------ |
| VaultZ             | TBD          | TBD                         | TBD         | [vaultz#758](https://github.com/SGAOperations/vaultz/issues/758)           | TBD     | TBD    |
| Chambers           | TBD          | TBD                         | TBD         | [chambers#250](https://github.com/SGAOperations/chambers/issues/250)       | TBD     | TBD    |
| Aplio              | TBD          | TBD                         | TBD         | [aplio#888](https://github.com/SGAOperations/aplio/issues/888)             | TBD     | TBD    |
| SenatePath         | TBD          | TBD                         | TBD         | [senate-path#103](https://github.com/SGAOperations/senate-path/issues/103) | TBD     | TBD    |
| Attendance Manager | TBD          | TBD                         | TBD         | Not filed (waits on the directive)                                         | TBD     | TBD    |

### 7.2 Review template

The template follows the peak-count queries.

**Peak counts.** Read-only; run in the Neon SQL editor or `psql` on the read role. Each query is a true rolling window ending at every event, so a spike that straddles a bucket boundary is not missed. Replace the two timestamps with the review window. The value is the largest `n`; it is the figure to record, and the Flag rule compares it to the AUTH-T77 thresholds.

```sql
-- Peak 15-minute LOGIN_FAILED count
SELECT max(n) AS peak_15_min
FROM (
  SELECT count(*) OVER (
    ORDER BY "createdAt"
    RANGE BETWEEN INTERVAL '15 minutes' PRECEDING AND CURRENT ROW
  ) AS n
  FROM "AuditEvent"
  WHERE type = 'LOGIN_FAILED'
    AND "createdAt" >= '<window start>' AND "createdAt" < '<window end>'
) w;

-- Peak hourly ACCOUNT_LOCKED count
SELECT max(n) AS peak_1_hour
FROM (
  SELECT count(*) OVER (
    ORDER BY "createdAt"
    RANGE BETWEEN INTERVAL '1 hour' PRECEDING AND CURRENT ROW
  ) AS n
  FROM "AuditEvent"
  WHERE type = 'ACCOUNT_LOCKED'
    AND "createdAt" >= '<window start>' AND "createdAt" < '<window end>'
) w;
```

Copy this block under §7.4, as a heading `### 7.<n> <Product> — reviewed <YYYY-MM-DD>`. Record counts only, never user emails or names. Where a source has not shipped, write `n/a — <ticket> not shipped` instead of a value.

```markdown
**Window:** <cutover deploy date> to <cutover deploy date + 14 days>

#### Metrics

| Metric                                    | Source                                                                                                             | Value | Flag? |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----- | ----- |
| Sign-ins (daily, 14 d)                    | PostHog "Daily logins" insight, `login_succeeded` ([POSTHOG.md](POSTHOG.md), AUTH-T75)                             |       |       |
| Sign-in failure rate                      | PostHog "Failure rate" insight (AUTH-T75), broken down by `reason`                                                 |       |       |
| Failed logins                             | `AuditEvent` `LOGIN_FAILED` count in the window, and the peak 15-minute count, from "Peak counts" below (AUTH-T73) |       |       |
| Lockouts                                  | `AuditEvent` `ACCOUNT_LOCKED` count in the window, and the peak hourly count, from "Peak counts" below (AUTH-T73)  |       |       |
| Threshold alerts fired                    | AUTH-T77 alert emails during the window                                                                            |       |       |
| Support requests                          | Count kept by the named support contact (§5), by triage row                                                        |       |       |
| Imported users signed in                  | Imported users with a `LOGIN_SUCCESS` in the window, out of the number imported (from the import report)           |       |       |
| Chambers only: `bcrypt$` hashes remaining | "Remaining hashes" query in [legacy-bcrypt.md](runbooks/legacy-bcrypt.md), run read-only on production             |       |       |
| Chambers only: re-hashes                  | "Re-hash rate" query in [legacy-bcrypt.md](runbooks/legacy-bcrypt.md), summed over the window                      |       |       |

Skip the two Chambers-only rows for every other product.

**Flag rule.** Mark `Flag?` as yes when the peak counts exceeded the AUTH-T77 alert thresholds (more than 50 `LOGIN_FAILED` in 15 minutes, more than 5 `ACCOUNT_LOCKED` in an hour), a rollback happened, or a support triage row recurred for 3 or more people. Do not invent other numeric thresholds.

#### Findings

- What went wrong:
- What users hit:
- What we would change for the next cutover:

#### Legacy cleanup

Link evidence for each item: a PR, a commit, or a screenshot of the deleted resource.

- [ ] The legacy auth code was deleted from the product (login UI, local session or role logic, auth-provider SDK calls).
- [ ] Legacy auth secrets and env vars were removed from Vercel (all environments) and from `.env.example`.
- [ ] Legacy auth data was deleted, or the auth project was retired, only after the §4 "Legacy auth kept for" window ended.
- [ ] The rollback flag or path from §4 was removed, or marked retired.
- [ ] The cleanup sub-issue is linked: `<repo>#<n>`.

#### Follow-ups

- Issues filed because of this review:

#### Sign-off

- SGAuth operator: <name>, <YYYY-MM-DD>
- Product owner: <name>, <YYYY-MM-DD>
```

### 7.3 bcrypt verify path removal

The Chambers-only bcrypt verify path (AUTH-T21, [#33](https://github.com/SGAOperations/auth/issues/33)) is removed by its own follow-up ticket, not by a review. The gate and the list of files to delete are the "Removal criterion" in [legacy-bcrypt.md](runbooks/legacy-bcrypt.md). The Chambers review records the remaining count and links the follow-up issue.

Never remove the path while the count is above zero (unless the remaining accounts are deliberately cleared, as the runbook allows), or before Chambers' 7-day legacy window (§4) has ended.

### 7.4 Completed reviews

None yet.
