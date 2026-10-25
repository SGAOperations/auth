# PostHog

Server-side product analytics and error tracking for SGAuth (AUTH-T75, #87). Code lives in `src/lib/analytics/` and `src/lib/auth/analytics-hooks.ts`. `POSTHOG_KEY`, `POSTHOG_HOST` and `POSTHOG_DISABLED` are server-only, and nothing here is `NEXT_PUBLIC_`. See [ENVIRONMENTS.md](ENVIRONMENTS.md) for where each is set.

## Event catalog

`ANALYTICS_EVENTS` in `src/lib/analytics/events.ts` is the single definition: one strict schema per event, the same approach as `AUDIT_CATALOG`. An event whose properties fail its schema is dropped and logged as `analytics.event_rejected`, never sent. Every event also carries `sgauth_env` and, inside a request, `request_id` (the id the log lines carry).

Other tickets emit through `analytics.capture` and never call `posthog-node` directly.

| Event                    | Emitted by                                                                   | Properties                                                                     | Distinct id                        |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `login_succeeded`        | `databaseHooks.session.create.after` (every login path)                      | `method`: `password`, `email_verification`, `other`                            | user id                            |
| `login_failed`           | `hooks.after` on `/sign-in/email` errors                                     | `reason`: the audit `LOGIN_FAILED` reason enum                                 | anonymous                          |
| `signup_started`         | `databaseHooks.user.create.after`, `/sign-up/email` only                     | none                                                                           | user id                            |
| `signup_completed`       | `emailVerification.afterEmailVerification`                                   | none                                                                           | user id                            |
| `reset_requested`        | `hooks.after` on `/request-password-reset` success                           | none                                                                           | anonymous                          |
| `reset_completed`        | `emailAndPassword.onPasswordReset`                                           | none                                                                           | user id                            |
| `mfa_enrolled`           | AUTH-T67 (#79), with the twoFactor plugin                                    | none                                                                           | user id                            |
| `account_locked`         | AUTH-T64 (#76), on lockout                                                   | none                                                                           | user id                            |
| `session_endpoint_error` | `withSessionEndpointErrorCapture`; `/api/sgauth/session` from AUTH-T28 (#40) | `status`: 500 to 599 or null, `kind`: `server_error`, `exception`              | anonymous                          |
| `$exception`             | `onRequestError` and Better Auth's error-level log lines                     | sanitized error, `source`: `request`, `better-auth`; `route`, `path`, `method` | user id when known, else anonymous |

Notes:

- `signup_completed` means the email was verified, so it also fires if a future invite flow verifies an email. Whichever ticket adds invites decides whether to filter it.
- `reset_requested` counts requests, including ones for unknown emails. Better Auth returns the same success either way, so the count reveals nothing about which accounts exist.
- Failed logins and reset requests stay anonymous on purpose: there is no user lookup by email for analytics.

## Privacy rules

- No email, name, IP address, user agent, token or free text, in any property or in an error.
- The distinct id is the SGAuth user id (a UUID), or a fresh random UUID with `$process_person_profile: false` when there is no user. There is no `identify()` and no `$set`.
- Errors go through `sanitizeError`: redacted message and stack, no `cause`, no own properties (a Prisma `meta`, for one), no headers, no query string. A path is scrubbed with `scrubPath`. A value that is not an `Error` is never stringified.
- A new property needs a change to its schema in `events.ts`, reviewed like a change to the audit catalog.
- Analytics never fails a request. Sends run in Next's `after()` and every failure is swallowed and logged at `warn` with the event name and error name only.
- `POSTHOG_DISABLED=true`, `NODE_ENV=test`, or a missing key or host turns capture off. The server logs one `analytics.disabled` line at boot.

## Client script rules

This ticket ships no client script, because the pages it attaches to do not exist yet: the `/admin` and `/account` shell is AUTH-T47 (#59), and the auth pages are AUTH-T25 (#37). Those tickets must follow these rules:

- The PostHog script loads only under the authenticated `(app)` layout for `/admin` and `/account`. Never in the root layout, and never on login, sign-up, reset or verification pages (the `(auth)` group). A third-party script on a credential form is a supply-chain risk.
- It uses its own `NEXT_PUBLIC_POSTHOG_KEY`, read through `publicEnv`, never the server key.
- The Content Security Policy adds the PostHog host to `script-src` and `connect-src` only for those paths.
- Autocapture, session replay and surveys stay off, and `persistence: "memory"` is used.
- Auth pages report errors to a first-party endpoint, never to PostHog directly.

## Project settings

- One PostHog project for every environment. Events are separated by the `sgauth_env` property. If the plan allows more projects, use one per environment and keep the property.
- Enable "Discard client IP data". Disable session replay.
- The server client sets `disableGeoip: true`.

## Dashboard

Create a dashboard named "SGAuth auth health". Every insight filters `sgauth_env = production`; switch the filter to `dev` to check test traffic.

| Insight      | Definition                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------- |
| Daily logins | Trends, unique users of `login_succeeded`, daily.                                           |
| Failure rate | Trends formula `A / (A + B)`, A = total `login_failed`, B = total `login_succeeded`, daily. |
| Lockouts     | Trends, total `account_locked`, daily. Empty until AUTH-T64 (#76) lands.                    |
| Error volume | Trends, total `$exception`, daily.                                                          |
