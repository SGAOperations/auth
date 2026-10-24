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
| `pa-transfer-initiated` | `role: "recipient"` with `url`, `fromName`, `acceptBy`; or `role: "initiator"` with `toName`, `acceptBy`           | `url`       |
| `pa-transfer-accepted`  | `role: "initiator"` with `cancelUrl`, `toName`, `executesAt`; or `role: "recipient"` with `fromName`, `executesAt` | `cancelUrl` |
| `pa-transfer-cancelled` | `role`, `otherName`, `reason`: `cancelled`, `declined`, `expired` or `recipient-ineligible`                        | none        |
| `pa-transfer-completed` | `role`: `initiator`, `recipient` or `admin`, `fromName`, `toName`, `completedAt`                                   | none        |
| `inactivity-notice`     | `name?`, `lastLoginAt`, `deactivateAfter`, `signInUrl`                                                             | `signInUrl` |

"Account locked" and "unlock" are two emails: a notice, and the single-use unlock link. Primary Admin "expired" is a `pa-transfer-cancelled` reason. Emailed links consume their token on POST, never on GET (ENGINEERING §3), so the consumer's page renders a confirm step.

Layout, escaping and the Eastern-time formatting live in `layout.ts`. Every interpolated value is escaped there, so templates never escape. `samples.ts` holds fixed sample data for every template and variant, shared by the snapshot test and the preview script.

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
