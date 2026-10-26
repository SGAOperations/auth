# Rate limiting

How SGAuth limits mutating and expensive endpoints (AUTH-T63, #75). Code is in `src/lib/rate-limit/`. Limits are enforced with `@upstash/ratelimit` (sliding window) on Upstash Redis, inside the route handlers. Better Auth's own limiter is off (`rateLimit: { enabled: false }` in `src/lib/auth/config.ts`).

## Policies

Every number lives in `POLICIES` in `src/lib/rate-limit/policies.ts`. Tune limits there, never inline. A rule id is part of the Redis key, so renaming one resets its counters.

| Rule id                     | Endpoint                                                               | Keyed by      | Limit | Window     |
| --------------------------- | ---------------------------------------------------------------------- | ------------- | ----- | ---------- |
| `sign-in:ip:1m`             | `POST /api/auth/sign-in/email`                                         | IP            | 10    | 1 minute   |
| `sign-in:ip:1h`             | `POST /api/auth/sign-in/email`                                         | IP            | 50    | 1 hour     |
| `sign-up:ip:1h`             | `POST /api/auth/sign-up/email`                                         | IP            | 5     | 1 hour     |
| `reset:ip:10m`              | `POST /api/auth/request-password-reset`                                | IP            | 3     | 10 minutes |
| `reset:email:10m`           | `POST /api/auth/request-password-reset`                                | email         | 3     | 10 minutes |
| `verify:email:1h`           | `POST /api/auth/send-verification-email`                               | email         | 3     | 1 hour     |
| `token:session:1m`          | `/api/auth/token` (any method)                                         | session token | 60    | 1 minute   |
| `session-lookup:session:1m` | `GET /api/sgauth/session` and `/minimal` (in-memory only, never Redis) | session token | 120   | 1 minute   |
| `token-link:ip:10m`         | `POST /<token-link>/confirm` (AUTH-T103)                               | IP            | 20    | 10 minutes |
| `reauth:user:1m`            | re-auth handler (AUTH-T32)                                             | user id       | 5     | 1 minute   |
| `admin:user:1m`             | admin mutation handlers (AUTH-T36)                                     | user id       | 100   | 1 minute   |
| `set-password:ip:10m`       | `POST /api/sgauth/sign-in/email-step`, `POST /set-password/request`    | IP            | 10    | 10 minutes |
| `set-password:email:10m`    | `POST /api/sgauth/sign-in/email-step`, `POST /set-password/request`    | email         | 5     | 10 minutes |
| `set-password-link:user:1h` | set-password links emailed to one account (AUTH-T22)                   | user id       | 3     | 1 hour     |
| `invite:user:1d`            | admin invites to one user, `issueAdminInvite` (AUTH-T22)               | user id       | 3     | 1 day      |

- A request is blocked when any rule of its policy denies it. The response is `429` with `Retry-After` (whole seconds, at least 1), `Cache-Control: no-store` and the body `{"code":"TOO_MANY_REQUESTS","message":"Too many requests. Try again later."}`. The request never reaches Better Auth.
- Emails are normalised (`normalizeEmail`) and hashed with SHA-256, and session tokens are hashed, before they become part of a key. IPs and user ids are used as they are. Per-email buckets count a request whether or not the account exists, so the 429 is identical either way.
- The Better Auth routes are limited by `withAuthRateLimit` in `src/app/api/auth/[...all]/route.ts`. A route that cannot supply its identifier falls back to the IP: a verification resend with no parseable email, and a token call with no session cookie. A reset with no email runs only its IP rule.
- **Re-auth and admin handlers do not exist yet.** AUTH-T32 and AUTH-T36 must call `limitRequest("reauth" | "adminMutation", userId)` from `@/lib/rate-limit/server` first in each handler, and return the response when it is not `null`.
- The jwt plugin (AUTH-T29) mounts `/token`, and `matchAuthRoute` matches that path. If the plugin is ever moved to another path, update `matchAuthRoute`.

## What is not limited

- **The session endpoints** (`/api/auth/get-session`, `/api/sgauth/session` and `/api/sgauth/session/minimal`, see [SESSION-ENDPOINT.md](SESSION-ENDPOINT.md)). They are the hot path, and the Upstash free tier is 500,000 commands a month, so they make no Redis call at all. `/api/auth/get-session` relies on the SDK cache and Vercel's platform protections. The two `/api/sgauth/session` routes add an **in-process** bucket, `session-lookup:session:1m` (120 per minute, keyed by the hashed session token, per instance). It stops one stolen cookie from hammering Neon. It is keyed by token and never by IP, because product servers share Vercel egress IPs and an IP bucket would throttle whole products. The policy is in-memory only and is never sent to Redis. The key is the raw cookie value, checked before Better Auth verifies its signature, so the bucket also holds junk tokens. The memory backend keeps at most 10,000 keys and evicts the oldest, so an attacker who rotates junk tokens can push a legitimate token's counter out and reset it. A junk request costs only an HMAC check and no database read, so this does not expose Neon, but the bucket is a best-effort brake on one stolen valid cookie and not a guarantee.
- **Trusted server-side calls** to `auth.api.*` (the seed, admin code, tests). Only HTTP traffic goes through the wrapper.

## Namespaces and environments

Keys are `<namespace><rule id>:<identifier>`, with one namespace per `SGAUTH_ENV`:

| `SGAUTH_ENV` | Namespace         | Store                         |
| ------------ | ----------------- | ----------------------------- |
| `production` | `sgauth:prod:`    | its own Upstash database      |
| `dev`        | `sgauth:dev:`     | its own Upstash database      |
| `preview`    | `sgauth:preview:` | in-memory fallback unless set |
| `local`      | `sgauth:local:`   | in-memory fallback unless set |

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are required on `production` and `dev`: the app refuses to start without them. Production and dev use separate databases and tokens ([ENVIRONMENTS.md](ENVIRONMENTS.md): no secret is shared across scopes). On `preview` and `local` they are optional. When unset, limits fall back to a per-instance in-memory sliding log, which the app announces once at boot. That store is not shared between serverless instances, so it is a development convenience and not a control.

## Failing open

An Upstash outage must never become an org-wide login outage, so every limit **fails open**:

- Each Upstash call has a 1 second timeout. A timeout or any error lets the request through.
- Each failure logs one line at error level, `[ALERT] rate-limit fail-open`, with `policy`, `rule` and `reason` (`timeout` or `error`). Search Vercel logs for that text. A line is written at most once per rule per minute per instance, and the next line carries a `suppressed` count. It never carries the identifier, the key, a token or the error message.
- While Redis is down the IP and email limits are off. The DB-backed account lockout (AUTH-T64) remains the brute-force backstop. AUTH-T77 (threshold alerts) lists these events and will need a durable signal; this ticket writes a log line only, to avoid a database write for every failed check during an outage.

## Command budget

The free tier allows 500,000 commands a month. The alert threshold is **80%, which is 400,000 commands a month**. The operator sets it as a usage alert on the production database in the Upstash console.

**Cost per check.** `@upstash/ratelimit` 2.2.0 runs `slidingWindow` as one Lua script: `EVALSHA`, two `GET`s and an `INCRBY` when the request is allowed (plus a `PEXPIRE` on the first request of a window), and `EVALSHA` plus two `GET`s when it is denied. Counted conservatively, that is **4 commands per allowed rule check**. Confirm it against the Upstash usage graph after launch and update this section if billing counts differently. A policy with two rules costs twice that.

**Monthly estimate** = sum over routes of (requests a month × rules × commands per check). Assumptions, to be replaced with measured numbers:

| Route                  | Assumption                                                                               | Requests / month | Rules  | Commands                |
| ---------------------- | ---------------------------------------------------------------------------------------- | ---------------- | ------ | ----------------------- |
| `token`                | 300 monthly active users, 20 active days, 1.5 h a day, one refresh about every 9 minutes | 60,000           | 1      | 240,000                 |
| `sign-in`              | 8 sign-ins per user per month                                                            | 2,400            | 2      | 19,200                  |
| sign-up, reset, resend | new users and the occasional reset                                                       | about 1,000      | 1 to 2 | about 6,000             |
| `token-link`           | one confirm POST per emailed link, about 1,500 a month                                   | about 1,500      | 1      | about 6,000             |
| `set-password`         | email step and link requests, plus the per-account link and invite checks                | about 500        | 2 to 3 | about 5,000             |
| email caps             | about 2,000 sends a month, 6 commands per send (see [EMAIL.md](EMAIL.md))                | about 2,000      | n/a    | about 12,000            |
| **Total**              |                                                                                          |                  |        | **about 282,000 (56%)** |

The product SDK refreshes the JWT about every 9 minutes per active session (AUTH-T29, AUTH-T60). **The token endpoint dominates.** On these assumptions about 870 commands a month per active user, the 80% threshold is reached at roughly 460 monthly active users, and the free tier at roughly 570. If real usage projects past 80%, raise it on the ticket rather than quietly lowering a policy: the choices are a longer JWT lifetime, an Upstash paid plan, or a different token limit.

## Known limits

- **Shared campus NAT.** Per-IP sign-in and sign-up limits can hit many users behind one egress IP, for example at an onboarding event. The numbers come from the ticket, and the DB lockout (AUTH-T64) is the per-account control.
- **IP trust.** `clientIp` trusts `x-real-ip` and `x-forwarded-for`, which is correct only behind Vercel. Off Vercel a client can rotate those headers to dodge the IP rules; the email, session and user rules are unaffected.
- **Exact path matching.** `matchAuthRoute` matches exact paths and strips one trailing slash. If Better Auth also routes another spelling of a limited path, add a test and normalise it. Do not loosen matching to a prefix.
