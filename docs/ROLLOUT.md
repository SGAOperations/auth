# SGAuth rollout plan

SGAuth is one login at `auth.northeasternsga.com`, rolled out to each SGA product in turn. Each product's cutover ticket runs the checklist in §3 against its own row in §1 and §4. The order comes from the "Rollout" row of the [design summary](sgauth-design/SGAuth-design-summary.md).

Owners, contacts, dates and review status are `TBD` until the owner reviews happen. Fill them in as each review is held.

## 1. Order and schedule

| #   | Product                           | Subdomain                      | Cutover ticket                                                           | Owner | Named support contact | Backup contact | Target date | Owner review (date) | Status |
| --- | --------------------------------- | ------------------------------ | ------------------------------------------------------------------------ | ----- | --------------------- | -------------- | ----------- | ------------------- | ------ |
| 0   | SGAuth MVP                        | `auth.northeasternsga.com`     | Gate: [#103](https://github.com/SGAOperations/auth/issues/103)           | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 1   | VaultZ                            | `vaultz.northeasternsga.com`   | [vaultz#753](https://github.com/SGAOperations/vaultz/issues/753)         | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 2   | Chambers                          | `chambers.northeasternsga.com` | [chambers#154](https://github.com/SGAOperations/chambers/issues/154)     | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 3   | Aplio (hard cutover)              | `apply.northeasternsga.com`    | [aplio#738](https://github.com/SGAOperations/aplio/issues/738)           | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 4   | SenatePath                        | TBD                            | [senate-path#90](https://github.com/SGAOperations/senate-path/issues/90) | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |
| 5   | Attendance Manager (SenatePortal) | TBD                            | ATTENDANCE-M05 (not yet filed)                                           | TBD   | TBD                   | TBD            | TBD         | TBD                 | TBD    |

Step 0 is the SGAuth MVP itself. Nothing is announced at this step.

Ordering rules:

- VaultZ goes first. It has no per-user auth to unwind, and it proves the SDK.
- Chambers goes next. It has the most users, and their credentials are pre-imported.
- Aplio needs a date with no application cycle open.
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

| Product            | Users come from                                                                                     | First sign-in                                                                              | Rollback                                       | Legacy auth kept for                 | Template                   |
| ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------ | -------------------------- |
| VaultZ             | Admin-created or self-sign-up (no accounts today)                                                   | Lazy set-password flow ([#34](https://github.com/SGAOperations/auth/issues/34)) or sign-up | Flip `SGAUTH_ENABLED` (vaultz#748)             | Passphrase gate kept for one release | A                          |
| Chambers           | [#99](https://github.com/SGAOperations/auth/issues/99) (bcrypt hashes)                              | Existing password                                                                          | Previous deployment, with Supabase auth intact | 7 days                               | B                          |
| Aplio              | [#100](https://github.com/SGAOperations/auth/issues/100) (password-less; Chambers duplicates merge) | Set-password email                                                                         | Redeploy the previous release                  | Better Auth tables kept for 14 days  | A plus the Aplio paragraph |
| SenatePath         | [#101](https://github.com/SGAOperations/auth/issues/101) (admins only)                              | Set-password email                                                                         | Redeploy the previous release                  | Supabase project kept for 14 days    | A                          |
| Attendance Manager | [#101](https://github.com/SGAOperations/auth/issues/101) (SenatePortal)                             | Set-password email                                                                         | TBD (depends on the directive)                 | TBD                                  | A                          |

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

Filled in by AUTH-T92 ([#104](https://github.com/SGAOperations/auth/issues/104)) two weeks after each cutover.
