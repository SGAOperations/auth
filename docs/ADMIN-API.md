# Admin user-management API

Endpoint reference for the admin UI (#60) and for product owners. The handlers live in `src/lib/admin/users/`; the three route files under `src/app/api/sgauth/admin/users/` only bind them.

## Rules for every admin route

- Every `/api/sgauth/admin/*` route goes through `requireAdmin` in `src/lib/admin-api.ts`. It checks the session, reads the actor fresh from the database, runs the gate `can(actor, action)`, then applies the rate limit to mutations. Add options to that guard; do not write a second one.
- **Every admin route requires the calling admin to have MFA enrolled.** An admin without it gets 403 `MFA_REQUIRED` with `enrollmentUrl`, on reads and mutations alike. Resetting an admin's MFA therefore locks them out of the admin API until they enroll again.
- Requests use the session cookie. Responses are JSON with `Cache-Control: no-store`.
- Non-browser callers must send a registered `Origin` header on every non-GET request. The proxy enforces it (#77); the routes add no check of their own.
- A mutation passes, in order: the guard, input validation, loading the target, `can(actor, action, target)`, fresh re-authentication where the table says so, then the change and its single audit row in one transaction. Email goes out after the commit and never changes the status code: its outcome (`sent`, `capped`, `failed` or `skipped`) is in `email`.
- `can()` runs before the re-auth check, so an action that is never allowed does not ask for re-authentication.
- A denied or conflicting request writes nothing and no audit row.

## Endpoints

All paths are under `/api/sgauth/admin/users`.

| Method and path             | `can()` action       | Fresh auth | Audit event                                            | Success                                |
| --------------------------- | -------------------- | ---------- | ------------------------------------------------------ | -------------------------------------- |
| `GET /`                     | `accessAdmin` (gate) | no         | none                                                   | 200 `{ users, page, pageSize, total }` |
| `POST /`                    | `accessAdmin` (gate) | no         | `USER_CREATED { source: "admin", invited }`            | 201 `{ user, email }`                  |
| `GET /:id`                  | `accessAdmin` (gate) | no         | none                                                   | 200 `{ user: AdminUserDetail }`        |
| `PATCH /:id`                | `updateProfile`      | no         | `USER_UPDATED { fields }`, none when nothing changed   | 200 `{ user }`                         |
| `DELETE /:id`               | `delete`             | yes        | `USER_DELETED { reason: "admin", removedPositionIds }` | 200 `{ user }`                         |
| `POST /:id/deactivate`      | `deactivate`         | yes        | `USER_DEACTIVATED { revokedSessions }`                 | 200 `{ user, revokedSessions }`        |
| `POST /:id/reactivate`      | `reactivate`         | no         | `USER_REACTIVATED`                                     | 200 `{ user }`                         |
| `POST /:id/grant-admin`     | `grantAdmin`         | yes        | `ADMIN_GRANTED`                                        | 200 `{ user, email }`                  |
| `POST /:id/revoke-admin`    | `revokeAdmin`        | yes        | `ADMIN_REVOKED`                                        | 200 `{ user }`                         |
| `POST /:id/revoke-sessions` | `revokeSessions`     | no         | `SESSIONS_REVOKED { scope: "all" }`                    | 200 `{ user, revokedSessions }`        |
| `POST /:id/unlock`          | `unlock`             | no         | `ACCOUNT_UNLOCKED { method: "admin" }`                 | 200 `{ user }`                         |
| `POST /:id/reset-mfa`       | `resetMfa`           | yes        | `MFA_RESET`                                            | 200 `{ user, email }`                  |
| `POST /:id/resend-invite`   | `resendInvite`       | no         | `USER_INVITED`                                         | 200 `{ user, email }`                  |

### Changing a user's email

`POST /:id/email` (fresh auth, `can()` action `changeEmail`) starts an admin-initiated email change. Body, strict: `{ "newEmail": "<address>" }`, trimmed and lower-cased, at most 254 characters. It answers 202 `{ status: "PENDING_VERIFICATION", expiresAt }` and never returns the token.

- Unlike the table above, **re-authentication is checked first**, before the target is loaded or `can()` runs, so every case answers `REAUTH_REQUIRED` while the stamp is stale.
- `can(changeEmail)`: an active admin may change a non-admin; only the Primary Admin may change another admin or their own email, and any other admin is refused (`PRIMARY_ADMIN_REQUIRED`) on an admin target, themselves included; nobody may change the Primary Admin's email but the Primary Admin (`PRIMARY_ADMIN_PROTECTED`). A deactivated target is allowed, so an address can be fixed before reactivation; a deleted one is 409 `USER_DELETED`.
- Nothing on the user changes yet. A link goes to the **new** address and a notice (with the new address masked, and no link) to the old one. The old address keeps working until the new mailbox opens `/verify-email-change` and presses the button. That POST swaps the address in one transaction, recomputes `legacyEmail` (`false` only for a northeastern.edu address), signs the user out everywhere, voids reset, set-password and unlock links mailed to the old address, and writes `EMAIL_CHANGED` (actor `SYSTEM`, with `requestedById` in the metadata).
- A user has at most one open request: a new one cancels the old one, whose link then reads as invalid. A link lasts 24 hours.
- The request writes `EMAIL_CHANGE_REQUESTED`. Both audit events carry `fromEmail` and `toEmail`, which are listed in `AUDIT_PII_METADATA_FIELDS` and removed when the user is deleted.
- An address in use answers 409 `EMAIL_UNAVAILABLE` whoever owns it, and the body never names the owner. If the address is taken between the request and the confirm, the confirm page says it could not complete the change and the request expires on its own.
- If the mailer's caps refuse the link, the request is cancelled and the answer is 429 `EMAIL_SEND_LIMITED`; its audit row stays, since the log is append-only.

- **Force re-login is `revoke-sessions`.** They are the same operation. `deactivate` also revokes every session.
- `DELETE` and the eight `POST` actions take no body; anything sent is ignored.
- `GET /:id` returns tombstones. They hold no personal data.
- Every audit row has `actorType: "USER"`, the admin as `actorUserId`, `targetType: "USER"` and the user as `targetId`, plus the request's `ip` and `userAgent`. The exception is `USER_DELETED`, whose `ip` and `userAgent` are null because the row is about a scrubbed user.
- "Diff" means the event type plus its metadata. A profile edit records the changed field names, never the values.
- Creating a user does not restrict the email domain. The new account has no password; the invite email carries a 7-day set-password link. `sendInvite: false` creates the account and sends nothing.
- Deleting is a tombstone: status `DELETED`, personal data scrubbed, sessions, accounts, MFA, devices, unlock tokens, locks and positions removed, and the id kept. The audit rows for the user keep their types and metadata, with `ip` and `userAgent` nulled.
- Resetting MFA does not revoke the user's sessions. If compromise is suspected, also call `revoke-sessions`.

## Input

- `id` must be a UUID. A malformed id is answered as an unknown one: 404 `USER_NOT_FOUND`.
- `GET /` query, strict (an unknown key is a 400):

  | Key        | Rule                                                                    |
  | ---------- | ----------------------------------------------------------------------- |
  | `q`        | trimmed, 1 to 100 characters; matches email, name and preferred name    |
  | `position` | a position key, 2 to 64 characters; matches active positions only       |
  | `status`   | `ACTIVE`, `DEACTIVATED` or `DELETED`; without it, `DELETED` is excluded |
  | `isAdmin`  | `true` or `false`                                                       |
  | `page`     | integer from 1, default 1                                               |
  | `pageSize` | integer 1 to 100, default 25                                            |

  Results are newest first.

- `POST /` body, strict: `email` (any domain, lower-cased), `name` (1 to 100), optional `preferredName` (1 to 100), optional `sendInvite` (default `true`).
- `PATCH /:id` body, strict, at least one key: `name` (1 to 100), `preferredName` (1 to 100, or `null` to clear).

## The user

`AdminUser`: `id`, `email`, `name`, `preferredName`, `status`, `isAdmin`, `isPrimaryAdmin`, `emailVerified`, `twoFactorEnabled`, `hasPassword`, `legacyEmail`, `lastLoginAt`, `createdAt`, `deactivatedAt`, `deletedAt` (dates as ISO strings) and `positions: { key, name }[]` for active positions, sorted by key.

`AdminUserDetail` adds `activeSessions` (sessions that have not expired) and `lockedUntil` (null unless a lock is live).

Password hashes, session tokens, TOTP secrets, backup codes and verification values are never returned.

## Errors

Every error body is `{ code, message }`, plus the extra fields noted. A 500 is logged as `admin_user_action_failed` with the action and the error name only.

| Status | `code`                                               | When                                                                        |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| 400    | `INVALID_INPUT` (plus `issues: { path, message }[]`) | bad body or query; a body that is not JSON has `issues: []`                 |
| 401    | `UNAUTHENTICATED`                                    | no session, or the session's user is gone                                   |
| 403    | `NOT_ADMIN`, `ACTOR_INACTIVE`                        | the gate: the caller is not an active admin                                 |
| 403    | `MFA_REQUIRED` (plus `enrollmentUrl`)                | the calling admin has not enrolled MFA                                      |
| 403    | `REAUTH_REQUIRED`                                    | a fresh-auth action more than 10 minutes after re-authentication            |
| 403    | `SELF_MODIFICATION`                                  | `can()`: deactivate, reactivate, delete, grant or revoke admin on yourself  |
| 403    | `PRIMARY_ADMIN_PROTECTED`                            | `can()`: the Primary Admin as target of a protected action                  |
| 403    | `PRIMARY_ADMIN_REQUIRED`                             | `can()`: reset MFA on another admin by someone who is not the Primary Admin |
| 404    | `USER_NOT_FOUND`                                     | unknown or malformed id                                                     |
| 404    | `UNKNOWN_ACTION`                                     | the `[action]` segment is not one of the eight                              |
| 409    | `EMAIL_TAKEN`                                        | create: the address exists, in any case                                     |
| 409    | `USER_DELETED`                                       | any mutation on a tombstone                                                 |
| 400    | `EMAIL_UNCHANGED`                                    | email change: the address is the user's current one                         |
| 409    | `EMAIL_UNAVAILABLE`                                  | email change: the address is in use by any account                          |
| 429    | `EMAIL_SEND_LIMITED`                                 | email change: the mail caps refused the verification link                   |
| 409    | `ALREADY_DEACTIVATED`, `NOT_DEACTIVATED`             | deactivate, reactivate                                                      |
| 409    | `ALREADY_ADMIN`, `NOT_AN_ADMIN`                      | grant-admin, revoke-admin                                                   |
| 409    | `NOT_LOCKED`                                         | unlock: no live lock                                                        |
| 409    | `MFA_NOT_ENROLLED`                                   | reset-mfa: the user has no MFA                                              |
| 409    | `PASSWORD_ALREADY_SET`, `USER_DEACTIVATED`           | resend-invite                                                               |
| 429    | `TOO_MANY_REQUESTS`                                  | the admin mutation limit (100 a minute per admin)                           |
| 429    | `INVITE_LIMIT`                                       | resend-invite: 3 invites a day to one user                                  |
| 500    | `INTERNAL_ERROR`                                     | unexpected                                                                  |
