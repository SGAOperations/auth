# Email

How SGAuth sends email (AUTH-T20, #32). Code is in `src/lib/email/`. This is infrastructure only: a flow sends a template by calling `sendEmail`, and wiring each template into its flow belongs to that flow's ticket (AUTH-T18 verify, T19 reset, T22 set-password, T64 lock and unlock, T36 Primary Admin transfer, T78 inactivity, T23 security notice).

## Account

SGAuth sends through its **own Resend account**, owned by an SGA shared mailbox rather than a student's personal login, with the credentials in the team vault. Resend's free quota is per account, so a separate API key inside the Chambers/Aplio account would isolate nothing.

- Owner: _record the shared mailbox here once the account exists._
- Vault entry: _record the entry name here._
- Resend terms (a distinct account for a distinct sender): _post the answer on #32 and record it here._

The Chambers/Aplio account's usage page must show none of SGAuth's sends.

## DNS

The sending domain is `auth.northeasternsga.com`, verified only in the SGAuth account. Publish the records the Resend dashboard shows for it:

| Record  | Name                                         | Purpose                                               |
| ------- | -------------------------------------------- | ----------------------------------------------------- |
| MX, TXT | `send.auth.northeasternsga.com`              | SPF and the bounce path (values from Resend)          |
| TXT     | `resend._domainkey.auth.northeasternsga.com` | DKIM public key (value from Resend)                   |
| TXT     | `_dmarc.auth.northeasternsga.com`            | `v=DMARC1; p=quarantine; rua=mailto:<shared mailbox>` |

The `from` address is `SGAuth <no-reply@auth.northeasternsga.com>`. Check deliverability with the steps under "Previewing" below: `dmarc=pass` with `header.from=auth.northeasternsga.com` aligned with the DKIM `d=` domain.

## API keys

One **sending-only** key per environment, restricted to the domain: one for production and one for `dev`. Preview and local have none. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` together (see [ENVIRONMENTS.md](ENVIRONMENTS.md)). The env schema requires the pair on `production` and `dev`, so a deployment without it refuses to boot.

## Sending

```ts
import { sendEmail } from "@/lib/email/server";

const result = await sendEmail({
  to: user.email,
  template: "reset-password",
  data: { name: user.name, url, expiresInMinutes: 60 },
});
```

- **Input** is typed per template and validated at runtime: the template's zod schema, `z.email()` on the normalised address, and a check that every link sits on SGAuth's own origin. **A failure here throws.** It is a caller bug, and tests catch it.
- **Output** is a `SendResult`: `sent`, `capped` (with the `cap`) or `failed`. `capped` and `failed` are **never thrown and never shown to the user**, so a caller keeps its uniform response and the enumeration resistance in ENGINEERING §3. A caller that must react, such as the admin invite, reads `status`.
- The module is server-only. There is no HTTP route for it.

## Templates

Each template is a zod schema plus a pure `render(data)` that returns `{ subject, html, text }`, in `src/lib/email/templates.ts`. Fields named in `links` are origin-checked.

| Template                | Data                                                                                                               | Links       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- |
| `verify-email`          | `name?`, `url`, `expiresInMinutes`                                                                                 | `url`       |
| `reset-password`        | `name?`, `url`, `expiresInMinutes`                                                                                 | `url`       |
| `set-password`          | `name?`, `url`, `expiresInMinutes`, `kind`: `first-sign-in` or `admin-invite`                                      | `url`       |
| `account-locked`        | `name?`, `lockedUntil`                                                                                             | none        |
| `account-unlock`        | `name?`, `url`, `expiresInMinutes`                                                                                 | `url`       |
| `security-notice`       | `name?`, `event`: `password-changed`, `password-reset` or `admin-granted`, `occurredAt`                            | none        |
| `email-change-verify`   | `name?`, `url`, `expiresInMinutes`. Goes to the new address and never names the old one                            | `url`       |
| `email-change-notice`   | `name?`, `newEmail`. Goes to the old address, shows the new one masked (`j•••@gmail.com`), carries no link         | none        |
| `pa-transfer-initiated` | `role: "recipient"` with `url`, `fromName`, `acceptBy`; or `role: "initiator"` with `toName`, `acceptBy`           | `url`       |
| `pa-transfer-accepted`  | `role: "initiator"` with `cancelUrl`, `toName`, `executesAt`; or `role: "recipient"` with `fromName`, `executesAt` | `cancelUrl` |
| `pa-transfer-cancelled` | `role`, `otherName`, `reason`: `cancelled`, `declined`, `expired` or `recipient-ineligible`                        | none        |
| `pa-transfer-completed` | `role`: `initiator`, `recipient` or `admin`, `fromName`, `toName`, `completedAt`                                   | none        |
| `inactivity-notice`     | `name?`, `lastLoginAt`, `deactivateAfter`, `signInUrl`                                                             | `signInUrl` |
| `security-alert`        | `name?`, `checkedAt`, `items`: 1 to 7 of `rule`, `count`, `since?`, `jobs?`                                        | none        |

"Account locked" and "unlock" are two emails: a notice, and the single-use unlock link. Primary Admin "expired" is a `pa-transfer-cancelled` reason. Emailed links consume their token on POST, never on GET (ENGINEERING §3), so the consumer's page renders a confirm step.

Layout, escaping and the Eastern-time formatting live in `layout.ts`. Every interpolated value is escaped there, so templates never escape. `samples.ts` holds fixed sample data for every template and variant, shared by the snapshot test and the preview script.

## Emailed links (scanner-safe)

Northeastern mail is Microsoft 365, and Defender Safe Links pre-fetches every link in an incoming message. A link that acted on GET would be consumed by the scanner before the person clicks it (AUTH-T103, #114). So every emailed token link follows one rule: the URL opens a page that shows what is about to happen and a button. The token is validated for display on GET and never consumed. It is consumed only by the button's POST, which is same-origin and Origin-checked. **Every emailed token link is single use**: its side effects run once, and the token is dead afterwards.

The links are registered in `TOKEN_ACTIONS` in `src/lib/token-links/actions.ts`:

| Action               | Page                   | Owner          | Status  |
| -------------------- | ---------------------- | -------------- | ------- |
| `verify-email`       | `/verify-email`        | T103, T18, T24 | live    |
| `reset-password`     | `/reset-password`      | T19 #31        | pending |
| `set-password`       | `/set-password`        | T22 #34        | live    |
| `account-unlock`     | `/unlock`              | T64 #76        | live    |
| `email-change`       | `/verify-email-change` | T24 #36        | live    |
| `pa-transfer-cancel` | `/transfer/cancel`     | T37 #49        | live    |

`TEMPLATE_LINK_TARGETS` maps each template's `links` field to one of these actions, or to a plain link with no token and no side effect (`sign-in`, used by `inactivity-notice`, and `pa-transfer-accept`, the `/admin/transfer/accept` page that `pa-transfer-initiated` links to). The accept link carries no token because its authority is the recipient's session plus a fresh re-authentication, and only one transfer can be in flight. The cancel link is public, since the Primary Admin may have no session, so its page sits outside `/admin`. `tokenLinkUrl(origin, action, token)` builds the URL, and the mailer refuses any link whose path is not the live target registered for its field. A `pending` action has no page: `tokenLinkUrl` throws for it, and the mailer throws for its templates, so nothing can mail a link to a missing page. A test enumerates every template link and every live page.

**Adding a consumer.** Build `src/app/<path>/page.tsx` with `TokenActionPage`, and `src/app/<path>/confirm/route.ts` with `createTokenActionHandler` and a POST export only. Write a `consume` with an atomic single-use guard, add the route to `APP_ROUTE_AUDIT`, and flip the action from `pending` to `live`. A flip without both files fails `src/lib/token-links/templates.test.ts`.

**How verify links are single use.** Better Auth's verify token is a stateless signed JWT, so SGAuth records each used one in `UsedEmailVerificationToken`, keyed by the SHA-256 of the JWT. The POST claims the row atomically (`INSERT ... ON CONFLICT DO NOTHING`) before it calls `auth.api.verifyEmail`. A second POST finds the row and gets the `used` outcome with no Better Auth call. A failure Better Auth reports releases the claim, so the same link can be retried. A process that dies between the claim and the verification leaves the link burned, and the person requests a new one: the fail-closed direction. Rows past the JWT's `exp` are pruned on each successful claim. Better Auth's own `GET /api/auth/verify-email` is closed with `disabledPaths`, because it would bypass the record. This covers sign-up, sign-in and change-email tokens alike.

**HEAD and scanners.** The proxy answers HEAD on a token-link path, and GET with a known scanner User-Agent (or none), with a static 200 and no side effects. The User-Agent list is best effort, since Safe Links often fetches with a browser User-Agent. The guarantee is that GET never consumes.

**Logs.** A throw in a `consume` logs `token_link_failed` with `action` and `errorName`, never the token or the message, and the person sees the generic `error` card. Outcomes `invalid`, `used` and `rate` are not logged or audited, matching how the rate limiter treats denials.

## Set-password links (AUTH-T22)

Code is in `src/lib/set-password/`. Imported accounts and admin-created accounts start with `emailVerified = true` and **no password**, and nothing is mailed at import. The link is sent lazily, the first time the person tries to sign in.

**Password-less** means the user has no credential `Account` with a non-null `password`. `hasPassword` and `credentialPasswordWhere` in `service.ts` are the one definition. Better Auth already answers `401 INVALID_EMAIL_OR_PASSWORD` for this state, so no password works until one is set through the link.

**Three triggers, one service.** `createSetPasswordService` decides whether an account is ACTIVE and password-less, whether it is inside its limit, then issues the token, writes `PASSWORD_SET_REQUESTED { via }` and mails the link:

| Trigger                                                      | `via`          |
| ------------------------------------------------------------ | -------------- |
| `POST /api/sgauth/sign-in/email-step` (the login email step) | `sign_in`      |
| `POST /set-password/request` (the expired-link form)         | `link_request` |
| Self-sign-up with an existing password-less address          | `sign_up`      |

The self-sign-up trigger is Better Auth's `emailAndPassword.onExistingUserSignUp`, wired in `src/lib/auth/options.ts`. The sign-up answer is its generic duplicate response, unchanged.

**Uniform response.** The two request routes check the Origin (a missing one fails closed), validate the body, apply the `setPasswordRequest` IP and email limit, then hand the lookup, the token and the email to `after()` and return a fixed response: `200 { "ok": true }` for the JSON route and a `303` to `?result=sent` for the form. An unknown address, a password-less one, a password holder, a deactivated account and an account over its per-account limit all get the same status, body and timing. A malformed email is the only distinct answer (`400 INVALID_EMAIL`), and it says nothing about any account.

**Tokens** are rows of the `Verification` table, with no migration: `identifier` is `set-password:<sha256 hex of the raw token>`, `value` is the user id. The raw token is never stored or logged. A first-sign-in link lives 1 hour and an admin invite 7 days. Issuing a link deletes the user's earlier set-password rows, so **only the newest link works**, and a lazy request replaces an outstanding invite. The POST consumes the row with a conditional delete, so two concurrent POSTs give one winner. Setting the password also marks the email verified, writes `PASSWORD_SET`, then signs the person in through Better Auth, so the lockout, `lastLoginAt` and `LOGIN_SUCCESS` all run. A sign-in that Better Auth refuses (a lockout, a second factor) leaves the password set and shows "Password set".

**`issueAdminInvite(db, { userId, now })`** is a primitive for the admin endpoints (#48). It returns `{ ok: true, url, expiresInMinutes: 10080 }`, or `{ ok: false, reason: "RATE_LIMITED" }` over 3 a day per user. It writes no audit row and sends no email: the endpoint writes `USER_INVITED`, mails `set-password` with `kind: "admin-invite"` after its commit, and checks that the user is ACTIVE and password-less first. A stray invite to a user who already has a password is harmless, because the consumer refuses it.

**Email-step API for `/login` (#37).** `POST /api/sgauth/sign-in/email-step` takes `{ "email": string }` as JSON, same origin only, and answers `200 { "ok": true }` for every well-formed address, `400 { "code": "INVALID_EMAIL" }` for a malformed one and `429 TOO_MANY_REQUESTS`. The page therefore shows the password step for **every** address, with one line under it, "First time signing in? If your account doesn't have a password yet, we've emailed you a link to set one.", and learns nothing about the account. The sign-up success copy is "Check your email to finish signing up. If you already have an account, we've sent you a link to sign in or set your password instead."

**Logs.** `set_password_link_limited` (info, `via`) when the per-account limit refuses a link, and `set_password_request_failed` (error, `via`, `errorName`) when the deferred work throws. Neither carries the address or the message.

## Caps

Tune the numbers in `src/lib/email/caps.ts`, nowhere else.

| Cap           | Limit                                  | Window              |
| ------------- | -------------------------------------- | ------------------- |
| Per recipient | 10                                     | calendar hour (UTC) |
| Per recipient | 30                                     | UTC day             |
| Global        | `SGAUTH_EMAIL_DAILY_CAP` (default 500) | UTC day             |

- A send over a cap is **refused, not thrown**: `sendEmail` returns `capped` and logs `email_capped`. A recipient refusal leaves the global count alone.
- Counters are `INCR` plus `EXPIRE` pairs on the existing Upstash database, under the environment namespace (`sgauth:prod:`, `sgauth:dev:`): `email:rcpt:1h:<hash>:<yyyymmddHH>`, `email:rcpt:1d:<hash>:<yyyymmdd>` and `email:global:1d:<yyyymmdd>`. `<hash>` is the SHA-256 of the normalised address. Without Upstash (local, preview) the counters sit in memory, per instance.
- Fixed windows allow up to twice a cap across a boundary, and the UTC day resets at 8 PM ET. That is fine for bounding abuse, and it lets each alert fire once a day.
- **Set `SGAUTH_EMAIL_DAILY_CAP` at or under the Resend plan's daily limit.** The free plan's own limit (100 a day at the time of writing) is below the default, so on the free plan set the cap explicitly. Otherwise Resend refuses before the 80% alert fires, which logs as `email_failed` with `status: 429`.
- The caps **fail open**, like every other limit (ENGINEERING §3): an Upstash error or a 1 second timeout lets the send through and logs an alert. Sign-in rate limits and the AUTH-T64 lockout still bound the resend lever.

## Transports

| Configuration                                | Transport | Behaviour                                                                                                                                          |
| -------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY` and `RESEND_FROM_EMAIL` set | Resend    | `POST https://api.resend.com/emails`, 10 second timeout                                                                                            |
| Unset, `SGAUTH_ENV=local`                    | Console   | Prints To, Subject and the text body, so a developer can click the link. It bypasses the redacting logger on purpose and never runs outside local. |
| Unset, `SGAUTH_ENV=preview`                  | Discard   | Sends nothing. The mailer still logs `email_sent` with `transport: "discard"`, and boot logs one warning.                                          |

A Resend failure throws an `EmailTransportError` that carries the HTTP status only, never the response body, which can echo the address.

## Logs and alerts

Every line carries the template and a recipient hash. **No line carries the address, the subject or the body.**

| Line                              | Level | Fields                                                                   |
| --------------------------------- | ----- | ------------------------------------------------------------------------ |
| `email_sent`                      | info  | `template`, `recipientHash`, `transport`, `providerId`                   |
| `email_capped`                    | warn  | `template`, `recipientHash`, `cap`                                       |
| `email_failed`                    | error | `template`, `recipientHash`, `transport`, `errorName`, `status?`         |
| `[ALERT] email daily cap 80%`     | error | `count`, `dailyCap`                                                      |
| `[ALERT] email daily cap reached` | error | `dailyCap`                                                               |
| `[ALERT] email cap fail-open`     | error | `reason`, `errorName?`, `suppressed?`: at most one a minute per instance |

Recipient hashes are unsalted SHA-256, matching the rate limiter, so they correlate across both logs. They are not anonymous against someone who already holds a list of student addresses. AUTH-T77 should pick up the three `[ALERT]` lines.

## Previewing

```
npm run email:preview
```

Renders every sample into `.temp/email-preview/<template>[-<variant>].html` and `.txt` and prints the paths. Open several HTML files in a browser and read the text files.

For the deliverability check, with the SGAuth key in your local `.env`:

```
npm run email:preview -- --send you@gmail.com
npm run email:preview -- --send you@outlook.com --template reset-password
```

`--send` mails one sample through Resend (`security-notice` by default) and prints only the Resend id or `HTTP <status>`. It is an ops script with its own `fetch`, the same exception as `positions-sync.ts`. In "Show original" or the message headers, confirm `dmarc=pass`.

## Out of scope

`scripts/neon-quota-monitor.mjs` sends through Resend with its own GitHub secret, outside the mailer and the caps. Whether that key moves to the SGAuth account is a separate decision.
