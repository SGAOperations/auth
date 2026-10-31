# Re-authentication (sudo mode)

Sensitive actions need proof of presence within the last 10 minutes. The proof is a fresh password check (and a second factor for an MFA user) that stamps `Session.lastReauthAt`. Tracked in AUTH-T32 (#44).

## The rule

- A session is **fresh** when `lastReauthAt` is set and no more than `REAUTH_WINDOW_MS` (10 minutes) old. A stamp in the future is not fresh. The rule is `isFresh` in `src/lib/auth/reauth-policy.ts`.
- It is **independent of Better Auth's `freshAge`**, which is left at its default. `lastReauthAt` is not a Better Auth session field, so every check reads it from the database.
- **Signing in does not stamp it.** A user who has just signed in is prompted once before their first sensitive action.
- The stamp is per session. Re-authenticating in one browser does not make another session fresh.

## `POST /api/sgauth/reauth`

Body: `{ "password": string, "code"?: string }`. Unknown keys are rejected. `code` is a six-digit TOTP or a backup code, and is required when the user has MFA.

| Step              | Rule                                                                               | Failure                                         |
| ----------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| Origin            | The proxy's registry check, which covers `/api/sgauth/*`                           | 403 `INVALID_ORIGIN`                            |
| Session           | The Better Auth session cookie                                                     | 401 `UNAUTHORIZED`                              |
| Rate limit        | `reauth:user:1m`, 5 a minute per user, fails open                                  | 429 `TOO_MANY_REQUESTS` with `Retry-After`      |
| Body              | `reauthBodySchema`                                                                 | 400 `INVALID_REQUEST`                           |
| Enrolled, no code | Checked before anything is verified or counted                                     | 400 `TWO_FACTOR_CODE_REQUIRED`                  |
| Lock              | `checkSignIn`. A known-device cookie bypasses the account lock, not a device lock  | 403 `REAUTH_LOCKED`                             |
| Credentials       | The password and, if enrolled, a TOTP (replay-claimed) or a backup code (consumed) | 400 `INVALID_REAUTH_CREDENTIALS`                |
| Success           | The stamp, the counter reset and the audit row in one transaction                  | 200 `{ "status": true, "freshUntil": "<ISO>" }` |

- The credential check is the Better Auth plugin endpoint `sgauthReauthenticate` (`/sgauth/reauth`, `src/lib/auth/reauth-plugin.ts`). It is `SERVER_ONLY`, so Better Auth's router never serves it at `/api/auth/*`. The route file is its only way in.
- A wrong password and a wrong code give the same 400. The code is checked even when the password is already wrong, so both cost the same and the answer never says which one failed.
- Unexpected failures (a database error, an audit write failure) are a 500, and nothing is stamped.
- Access is self-only: the route acts on the caller's own session, so there is no `can()` decision.

### Lockout and replay

- Every wrong password or code counts toward the same account lock as a wrong sign-in (`docs/LOCKOUT.md`). On a known device it counts toward that device's lock. The failure that takes the lock sends the unlock link and the notice email, as at sign-in.
- A refused attempt (locked) is not counted again.
- The TOTP step is shared with sign-in (`claimTotpStep`, `src/lib/auth/second-factor.ts`), so a code accepted at one cannot be replayed at the other. A user who signs in and then re-authenticates inside the same 30 second step has to wait for the next code.
- Nothing is claimed until the credentials have passed, so a wrong password never burns a code. A backup code is consumed with a compare-and-swap on the stored list, so it works once even under concurrency.

### Audit

| Event                         | When                                                      |
| ----------------------------- | --------------------------------------------------------- |
| `REAUTH_SUCCEEDED { method }` | Each success, in the stamp's transaction                  |
| `REAUTH_FAILED { reason }`    | Each wrong password or code, and each refusal when locked |
| `MFA_BACKUP_USED`             | A backup code is used at re-auth                          |
| `ACCOUNT_LOCKED`              | A re-auth failure takes the lock                          |

## Guarding a route

**An SGAuth route handler** calls `requireFreshAuth()` from `@/lib/auth/server` after the session and the Origin check and **before `can()`**:

```ts
const fresh = await requireFreshAuth(request.headers);
if (!fresh.ok) return fresh.response; // 401 UNAUTHORIZED or 403 REAUTH_REQUIRED
```

`hasFreshAuth(db, sessionId)` is for code that already holds the session.

**A Better Auth endpoint** is gated by adding its path to `FRESH_AUTH_AUTH_PATHS` in `src/lib/auth/reauth-policy.ts`. The `sgauth-reauth` plugin's `before` hook answers 403 `REAUTH_REQUIRED` before the endpoint runs. Do not add a second gate to the same endpoint. The gated paths are:

| Path                                 | Why                          |
| ------------------------------------ | ---------------------------- |
| `/change-password`                   | Changing the password        |
| `/revoke-sessions`                   | Revoking every session       |
| `/revoke-other-sessions`             | Revoking every other session |
| `/two-factor/enable`                 | Starting MFA enrollment      |
| `/two-factor/disable`                | Turning MFA off              |
| `/two-factor/get-totp-uri`           | Reveals the TOTP secret      |
| `/two-factor/generate-backup-codes`  | Replaces the backup codes    |
| `/passkey/generate-register-options` | Starting passkey enrollment  |
| `/passkey/verify-registration`       | Finishing passkey enrollment |
| `/passkey/delete-passkey`            | Removing a passkey           |

The plugin runs after `sgauth-mfa`, so an admin's refusal on `/two-factor/disable` answers before the re-auth prompt. Server-side `auth.api` calls with no session headers have no session and are unaffected.

`POST /api/auth/verify-password` is disabled over HTTP (`disabledPaths`): it was a password oracle for any session holder, with no rate limit and no lockout. In-process `auth.api.verifyPassword` still works.

## In the browser

A request that fails with 403 `REAUTH_REQUIRED` should open the dialog and retry once:

```tsx
// Once, high in the tree of an authenticated page.
<ReauthProvider twoFactorEnabled={user.twoFactorEnabled}>
  {children}
</ReauthProvider>;

// Where the action runs.
const { fetch } = useReauth();
const response = await fetch("/api/sgauth/...", { method: "POST", body: "{}" });
```

- `useReauth().fetch` is `fetchWithReauth` (`src/lib/auth/reauth-client.ts`) wired to the dialog (`src/components/reauth-dialog.tsx`). On a 403 `REAUTH_REQUIRED` it opens the dialog, and when the user confirms it **retries once**. A second `REAUTH_REQUIRED` goes back to the caller, with no loop. If the user cancels, the caller gets the original 403 and shows nothing extra.
- `init.body` must be re-sendable, because the request can go out twice: a string or `FormData`, never a stream.
- The provider has no consumer yet. The first page to mount it is the account security page (#66) or the admin users page (#56).
