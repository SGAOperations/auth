# Data handling

The maintainer source of truth for what SGAuth stores about people. The public page at `/privacy` summarizes this file and must never claim anything it contradicts. Retention thresholds live in `src/lib/retention/policy.ts` (#90); where this file and that file disagree, the code wins and this file is stale.

## Scope and operator

SGAuth is operated by Northeastern SGA. The contact address is `sgaOperations@northeastern.edu`. The public notice is the `/privacy` page (`src/app/privacy/page.tsx`), linked from the site-wide footer.

## Inventory

Every personal field in `prisma/schema.prisma`. "Admins" means SGAuth admins, through the admin UI. Nothing below is readable by products unless the "Who sees what" section says so.

### `User`

| Field                                                                              | Purpose                                        | Who can read it               | Retention                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------- | ------------------------------------- |
| `name`                                                                             | Display name                                   | Admins; products              | Scrubbed at tombstone                 |
| `preferredName`                                                                    | Optional display name                          | Admins; products              | Scrubbed at tombstone                 |
| `email`                                                                            | Sign-in identifier, notifications              | Admins; products              | Scrubbed at tombstone                 |
| `image`                                                                            | Unused, always null                            | None                          | n/a                                   |
| `status`, `deactivatedAt`, `deletedAt`                                             | Account lifecycle                              | Admins                        | Kept (the row survives the tombstone) |
| `isAdmin`, `isPrimaryAdmin`                                                        | Authorization                                  | Admins; products (admin flag) | Kept                                  |
| `lastLoginAt`, `inactivityNoticeSentAt`                                            | Inactivity retention                           | Admins                        | Kept                                  |
| `legacyEmail`                                                                      | Marks an imported non-northeastern.edu address | Admins                        | Kept                                  |
| `emailVerified`, `passwordChangedAt`, `twoFactorEnabled`, `createdAt`, `updatedAt` | Account security state and timestamps          | Admins                        | Kept                                  |

### Credentials and security records

| Model and field                             | Purpose                                                                  | Who can read it                 | Retention                                  |
| ------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------ |
| `Account.password`                          | scrypt hash, or an imported bcrypt hash that is re-hashed on first login | Server only                     | Removed at tombstone                       |
| `TwoFactor.secret`, `TwoFactor.backupCodes` | TOTP second factor                                                       | Server only                     | Removed at tombstone                       |
| `Session.token`, `ipAddress`, `userAgent`   | Keep the user signed in; show active sessions                            | The user; admins (session list) | Purged at expiry or 90 days after creation |
| `KnownDevice.userAgent`, `tokenHash`        | Recognize a remembered device                                            | Server only                     | Until tombstone (see Known gaps)           |
| `AccountLock.lastFailedIp`                  | Lockout diagnostics                                                      | Server only                     | Until tombstone (see Known gaps)           |
| `UnlockToken.tokenHash`                     | Emailed unlock link; the raw token is never stored                       | Server only                     | Purged when expired                        |
| `Verification.identifier`, `value`          | Email verification and reset tokens                                      | Server only                     | Purged when expired                        |

### Positions, transfers and audit

| Model and field                                          | Purpose                                  | Who can read it  | Retention                                         |
| -------------------------------------------------------- | ---------------------------------------- | ---------------- | ------------------------------------------------- |
| `UserPosition`                                           | SGA positions a user holds               | Admins; products | Removed at tombstone                              |
| `AuditEvent.type`, `actorUserId`, `targetId`, `metadata` | Audit trail of security-relevant actions | Admins           | Kept; the catalog defines what metadata may carry |
| `AuditEvent.ip`, `userAgent`                             | Context for the audit trail              | Admins           | Nulled at 90 days, and at tombstone               |
| `PrimaryAdminTransfer`                                   | Primary Admin hand-over state            | Admins           | Kept                                              |

## Not collected

SGAuth stores no NUID, phone number, pronouns, photo, grades, class schedule, or academic or financial records. Products keep their own fields, keyed by the SGAuth user id.

## FERPA note

Names, email addresses and positions are directory-level information. SGA is a student organization, not the university's FERPA records steward. SGAuth is kept to that data set. Any proposal to store a non-directory field needs a change to this document and a privacy review first.

## Retention

The thresholds live in `src/lib/retention/policy.ts`. The rules, as of #90:

- Deactivated users are tombstoned at 30 days.
- An inactivity notice goes out at 11 months, and the account is tombstoned at 12 months. Admins and the Primary Admin are exempt and go to manual review.
- Unverified self sign-ups are tombstoned at 7 days.
- Sessions are purged at expiry or 90 days after creation.
- IP address and user agent are nulled on audit rows at 90 days.
- Expired verifications and unlock tokens are purged.

Each tombstone writes one `USER_DELETED` audit row whose `reason` is `admin`, `deactivated_30d`, `inactive_12mo` or `unverified_7d`. The runbook is [retention.md](runbooks/retention.md).

## Tombstone end state

A tombstone sets the user's status to `DELETED` and scrubs the personal fields: name, email, password, two-factor settings, sessions, known devices, lock record and positions. IP and user agent are removed from the user's audit history. The `User` row and its id are kept, so foreign keys in products and in audit history stay valid and products can show "Deleted user". The same email can sign up again later as a new account with a new id.

## Known gaps

`AccountLock.lastFailedIp` and `KnownDevice.userAgent` are not aged out. They are removed only by a tombstone. Shortening that is the follow-up noted in #90. `/privacy` states this.

## Processors

| Processor | What it receives                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Neon      | The database: everything in the inventory above.                                                                                              |
| Vercel    | Hosting and request logs. Logs are redacted by `src/lib/log/redact.ts`, so emails and the `ip` key are masked.                                |
| Resend    | Email delivery: the recipient address and the message.                                                                                        |
| Upstash   | Rate-limit counters keyed by IP, a SHA-256 email hash, a hashed session token or a user id. Each key expires with its window.                 |
| PostHog   | Planned, not yet integrated. It must stay free of PII per the design summary. Complete this row, and `/privacy`, in the same PR that adds it. |

## Who sees what

- SGAuth admins see users, positions and audit events.
- Each product a user signs into receives the id, email, name and preferred name, positions and the admin flag, through the session endpoint or a JWT.

## Deletion requests

1. A request arrives at `sgaOperations@northeastern.edu`.
2. Confirm it came from the account's own address, by replying to that address.
3. An admin tombstones the account through the admin delete (#48). The audit row is `USER_DELETED { reason: "admin" }`.
4. Reply within 14 days.

The Primary Admin cannot be tombstoned. The Primary Admin must transfer the role first.

## Change control

Any schema change that adds a personal field updates this file and `/privacy` in the same PR.
