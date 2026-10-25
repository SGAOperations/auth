# Account lockout

Repeated wrong passwords lock the account for a growing time. A browser that has already logged in to the account is exempt, so someone who only knows an address cannot lock the owner out. Code: `src/lib/auth/lockout-policy.ts` (the rules), `lockout.ts` (rows), `lockout-hooks.ts` (Better Auth wiring), `known-device.ts`, `unlock.ts`.

## Policy

| Rule            | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| Threshold       | 5 failed passwords inside a 15 minute window                                           |
| Lock duration   | 15 min, then each later lock doubles: 30 min, 1 h, 2 h, 4 h, 8 h, 16 h, capped at 24 h |
| Never permanent | The longest lock is 24 h                                                               |
| Level decay     | The level resets to 0 after 24 h with no failure and no active lock                    |
| Applies to      | Every account, the Primary Admin included. There is no role-based exemption            |
| Lock counts     | A failure while already locked changes nothing, and a refused attempt is not counted   |

The policy is pure: state in, state out, with `now` injected, so the escalation ladder is a plain unit test (`lockout-policy.test.ts`).

## What a refusal looks like

A locked sign-in returns `401 INVALID_EMAIL_OR_PASSWORD`, the same status and body as a wrong password or an unknown email. The refusal runs one password hash first, the cost Better Auth spends on an unknown user, so the three paths cost the same. The sign-in UI does not say the account is locked: the email does.

Counting is deferred until after the response (Next `after()` in production, inline in tests): the counter write, the lock, the unlock token, both emails and the audit row. The synchronous path for an unknown and a known address is therefore the same: one user lookup plus Better Auth's own hash. The cost is that a burst of parallel guesses can pass 5 before the deferred write lands; the per-IP limit bounds that, and the lock is the backstop when the limiter is down.

## Known-device exemption

After every completed login SGAuth sets a signed, HttpOnly, host-only cookie and stores its hash in `KnownDevice` (details in `SESSION-COOKIE.md`, "Known-device cookie").

- A sign-in that carries a valid cookie **for that account** is exempt from the account lock. It succeeds while an unknown browser is locked out.
- It keeps its own counter on the `KnownDevice` row. 5 wrong passwords in 15 minutes pause that device for 15 minutes. This lock is flat, never escalates, and sends no email. It never touches the account's counter.
- It is still subject to the IP rate limits.
- A successful login does **not** clear an active account lock: a known-device success shows the owner is present, not that the attacker stopped. Unknown browsers stay locked until the lock expires or one of the unlock paths below runs.
- A stolen cookie and the password are both needed to use the exemption. A password reset does not revoke known devices.

## What resets what

| Event                        | Failure counter | Active lock | Lock level | Outstanding unlock links |
| ---------------------------- | --------------- | ----------- | ---------- | ------------------------ |
| Successful login             | reset           | kept        | kept       | kept                     |
| Unlock link (`/unlock`)      | reset           | cleared     | kept       | revoked                  |
| Password reset               | reset           | cleared     | kept       | revoked                  |
| Admin unlock (#48)           | reset           | cleared     | kept       | revoked                  |
| 24 h clean after a lock ends | n/a             | n/a         | reset to 0 | n/a                      |

`clearAccountLock(db, { userId, now })` implements the three unlock paths and does not audit: the caller does, because the method differs. The admin endpoint (#48) and its button (#56) call it with `method: "admin"`.

## The unlock link

When a failure takes the lock, one transaction writes the lock, issues a single-use unlock token valid for one hour (`UnlockToken`, hashed), and writes `ACCOUNT_LOCKED`. After it commits, two emails go out: `account-locked` (what happened and when it unlocks) and `account-unlock` (the link). Each lock sends them once, never per refused attempt, and the recipient caps in `EMAIL.md` bound them. A send that fails or is capped is logged by the mailer and the lock stands.

The link follows the scanner-safe pattern in `EMAIL.md`: `GET /unlock?token=` only reads and shows a button, and `POST /unlock/confirm` consumes the token, clears the lock and writes `ACCOUNT_UNLOCKED` in one transaction. Unknown, used and expired tokens all show "This link isn't valid", and the response never names the account.

## Audit events

| Event                                   | When                                                        | Metadata                                          |
| --------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| `ACCOUNT_LOCKED`                        | A failure takes the lock, written in the lock's transaction | `lockLevel`, `durationMinutes`                    |
| `ACCOUNT_UNLOCKED`                      | Unlock link, password reset, admin                          | `method`: `email_link`, `password_reset`, `admin` |
| `LOGIN_FAILED` `reason: ACCOUNT_LOCKED` | Each refused attempt                                        | `reason`                                          |

No metadata carries an address.

## Operations

- A deferred task that throws logs `lockout_task_failed` with `step` and `errorName` only: never the address, the token or the error message. Steps: `count_failure`, `refused_audit`, `send_locked_email`, `send_unlock_email`, `session_created`, `password_reset`.
- A failed lock transaction (including a failed audit write) rolls back, so the failure that should have locked is lost. The next failure counts again.
- `recordFailedSignIn` and `clearAccountLock` are exported for the re-authentication and change-password paths and the admin unlock endpoint.
