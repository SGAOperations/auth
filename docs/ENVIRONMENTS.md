# Environments

How SGAuth is hosted on Vercel and which database each environment uses. This document describes the **end state**: `auth-dev` public at the Vercel level and gated in code by #134. #134 has merged; until its gate is verified on `auth-dev`, `auth-dev` stays behind Standard Protection (see [Protection](#protection)).

## Environments

| Environment | Branch      | Domain                         | Vercel env      | Neon branch  | `SGAUTH_ENV` | Protection                                                                       |
| ----------- | ----------- | ------------------------------ | --------------- | ------------ | ------------ | -------------------------------------------------------------------------------- |
| Production  | `main`      | `auth.northeasternsga.com`     | Production      | `main`       | `production` | public (production domain)                                                       |
| Dev         | `dev`       | `auth-dev.northeasternsga.com` | Preview (`dev`) | `dev` shared | `dev`        | public at Vercel (Deployment Protection Exception); gated in code (#134)         |
| Preview     | PR branches | `*.vercel.app`                 | Preview         | `dev` shared | `preview`    | Vercel Authentication, plus #134's gate; automation bypass for CI and Playwright |
| Local       | any         | `auth.sga.localhost:3000`      | n/a             | personal     | `local`      | n/a                                                                              |

The `*.vercel.app` deployment URLs generated for `dev` stay protected. Only the `auth-dev.northeasternsga.com` domain is excepted.

There is one Vercel project, `sgauth`, linked to `SGAOperations/auth`.

## Environment variables

Every variable set in Vercel, by scope. "Preview (`dev`)" is the branch-specific override for git branch `dev`; it replaces the "Preview (all branches)" value for that branch only.

| Variable                                                                                  | Purpose                                                                                                                                                   | Production                          | Preview (`dev`)                     | Preview (all branches) | Development   | Source | Secret |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------- | ---------------------- | ------------- | ------ | ------ |
| `DATABASE_URL`                                                                            | Pooled runtime role. `sslmode=verify-full`.                                                                                                               | Neon `main`                         | inherited (Neon `dev`)              | Neon `dev`             | empty         | manual | yes    |
| `DIRECT_URL`                                                                              | Direct migration role. `sslmode=verify-full` (fallback below).                                                                                            | Neon `main`                         | inherited (Neon `dev`)              | Neon `dev`             | empty         | manual | yes    |
| `SGAUTH_ENV`                                                                              | Selects Better Auth's `baseURL` (`src/lib/auth/settings.ts`).                                                                                             | `production`                        | `dev`                               | `preview`              | `local`       | manual | no     |
| `BETTER_AUTH_SECRET`                                                                      | Better Auth signing secret. Generate with `npx @better-auth/cli secret`.                                                                                  | distinct value                      | distinct value                      | distinct value         | its own value | manual | yes    |
| `SGAUTH_PREVIEW_GATE_PASSWORD` ([#134](https://github.com/SGAOperations/auth/issues/134)) | Password for the browser-route gate outside production.                                                                                                   | not set                             | distinct value                      | distinct value         | not set       | manual | yes    |
| `SGAUTH_SIGNUP_ALLOWLIST` ([#134](https://github.com/SGAOperations/auth/issues/134))      | Comma-separated exact emails and `@domain` suffixes allowed to sign up outside production. Lists people, so it stays out of the repo.                     | not set                             | set                                 | set                    | not set       | manual | no     |
| `UPSTASH_REDIS_REST_URL` ([#75](https://github.com/SGAOperations/auth/issues/75))         | Upstash Redis REST endpoint for rate limiting. Required on `production` and `dev`. See [RATE-LIMITING.md](RATE-LIMITING.md).                              | its own database                    | its own database, not production's  | not set                | not set       | manual | no     |
| `UPSTASH_REDIS_REST_TOKEN` ([#75](https://github.com/SGAOperations/auth/issues/75))       | Token for that database. Required on `production` and `dev`.                                                                                              | its own token                       | its own token                       | not set                | not set       | manual | yes    |
| `RESEND_API_KEY` ([#32](https://github.com/SGAOperations/auth/issues/32))                 | Sending-only Resend key, restricted to `auth.northeasternsga.com`, from the SGAuth account. Required on `production` and `dev`. See [EMAIL.md](EMAIL.md). | its own key                         | its own key, not production's       | not set                | not set       | manual | yes    |
| `RESEND_FROM_EMAIL` ([#32](https://github.com/SGAOperations/auth/issues/32))              | Bare sender address. The `SGAuth` display name is added in code. Required on `production` and `dev`.                                                      | `no-reply@auth.northeasternsga.com` | `no-reply@auth.northeasternsga.com` | not set                | not set       | manual | no     |
| `SGAUTH_EMAIL_DAILY_CAP` ([#32](https://github.com/SGAOperations/auth/issues/32))         | Optional global daily send cap (default 500). Set it at or under the Resend plan's daily limit.                                                           | optional                            | optional                            | not set                | not set       | manual | no     |
| `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_ENV`, `VERCEL_GIT_COMMIT_REF`                  | Read by `settings.ts` (preview `baseURL`, the `local`-on-Vercel assertion) and by `scripts/vercel-build.mjs`.                                             | system                              | system                              | system                 | n/a           | Vercel | no     |
| `VERCEL_AUTOMATION_BYPASS_SECRET`                                                         | Exposes one bypass secret. Listed for reference only. Never copied into another product.                                                                  | system                              | system                              | system                 | n/a           | Vercel | yes    |

Notes:

- The `VERCEL_*` variables require "Automatically expose System Environment Variables" to stay on.
- `TEST_DATABASE_URL` and `TEST_DIRECT_URL` are local and CI only. They are never set in Vercel.
- The Development scope is either filled as shown or left empty. Local development uses `.env`.
- Later tickets add their own rows (PostHog, `CRON_SECRET`).

Rules:

- **No secret value is shared across scopes.** `auth-dev` is reachable from the internet, so none of its secrets (`BETTER_AUTH_SECRET`, `SGAUTH_PREVIEW_GATE_PASSWORD`, database credentials) may equal production's or the Preview (all branches) value. The Neon `dev` roles have no access to Neon `main`.
- Nothing secret is `NEXT_PUBLIC_`.
- Every connection string uses `sslmode=verify-full`. The one exception is `DIRECT_URL`, which may use `sslmode=require&sslaccept=strict` if the migration CLI rejects `verify-full`. If that happens, note it on #12.
- The `dev` branch override must set `SGAUTH_ENV`, `BETTER_AUTH_SECRET`, `SGAUTH_PREVIEW_GATE_PASSWORD`, `SGAUTH_SIGNUP_ALLOWLIST`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. The build refuses to run without the right `SGAUTH_ENV`. #134's validation refuses to start without the gate password, and the env validation (#75, #32) refuses to start on `production` or `dev` without the Upstash pair and the Resend pair.
- Never set `SGAUTH_PREVIEW_GATE=off` in a Vercel scope.

## Cookies and SDK values

One row per environment. Products set `SGAUTH_URL` and `SGAUTH_COOKIE_NAME` from it. The names come from `resolveCookiePolicy` in `src/lib/auth/cookies.ts`, and `cookies.test.ts` pins them. The full cookie contract is in [SESSION-COOKIE.md](SESSION-COOKIE.md).

| Environment | SGAuth URL / `SGAUTH_URL`              | Session cookie (`SGAUTH_COOKIE_NAME`)   | `Domain`              | Secure | Neon branch | Who may use it                                        |
| ----------- | -------------------------------------- | --------------------------------------- | --------------------- | ------ | ----------- | ----------------------------------------------------- |
| Production  | `https://auth.northeasternsga.com`     | `__Secure-sgauth.session_token`         | `northeasternsga.com` | yes    | `main`      | every production product (these are the SDK defaults) |
| Dev         | `https://auth-dev.northeasternsga.com` | `__Secure-sgauth-dev.session_token`     | `northeasternsga.com` | yes    | `dev`       | product dev and preview environments                  |
| Preview     | the deployment's `*.vercel.app` host   | `__Secure-sgauth-preview.session_token` | none (host-only)      | yes    | `dev`       | SGAuth's own testing only, no product SSO             |
| Local       | `http://auth.sga.localhost:3000`       | `sgauth-local.session_token`            | `sga.localhost`       | no     | personal    | developers on their own machine                       |

## Product previews

- Each product adds a Vercel branch domain `<product>-dev.northeasternsga.com` on its own dev branch, with `SGAUTH_URL=https://auth-dev.northeasternsga.com` and `SGAUTH_COOKIE_NAME=__Secure-sgauth-dev.session_token`.
- The product registers that origin in SGAuth's product registry once AUTH-T56 (#68) exists.
- Ad-hoc `*.vercel.app` product previews **cannot use SSO**. The browser never sends a `northeasternsga.com` cookie to `vercel.app`, so use the branch domain.
- Testers unlock the [gate](#pre-production-gates) on `auth-dev` once per browser (7 days). Product servers call the exempt machine endpoints and need no gate cookie or Vercel header once the Deployment Protection Exception is on. Until then, product previews cannot redirect a browser to `auth-dev`.

## Local development

- Run `npm run dev` with `SGAUTH_ENV=local`, then browse to `http://auth.sga.localhost:3000`, never `http://localhost:3000`. On bare `localhost` the browser rejects the `Domain=sga.localhost` cookie, and the origin is not trusted.
- Products run on `<product>.sga.localhost:<port>` (VaultZ on `vaultz.sga.localhost:3001`) with `SGAUTH_URL=http://auth.sga.localhost:3000` and `SGAUTH_COOKIE_NAME=sgauth-local.session_token`.
- Name resolution by browser:
  - Chrome and Edge resolve `*.localhost` natively.
  - Firefox: add the hostnames to `network.dns.localDomains` in `about:config`.
  - Safari, or any tool that does not: add a hosts-file line `127.0.0.1 auth.sga.localhost vaultz.sga.localhost`.
- Safari's handling of `Domain=sga.localhost` is unverified. AUTH-T104 (#115) confirms it or switches to `sga.test` through the hosts file, and records the result here.
- **Product stub.** `node scripts/sso-stub.mjs` serves `http://vaultz.sga.localhost:3001`. It reads the session cookie and asks SGAuth who it belongs to, so it shows whether the cookie reached a sibling host. It reads `SGAUTH_URL`, `SGAUTH_COOKIE_NAME` and `PORT` (the defaults match the values above) and listens on loopback only. It forwards the session cookie to `SGAUTH_URL`, so it refuses to start when `SGAUTH_URL` is `http` on any host other than `localhost`, `*.localhost` or loopback.
- **Manual SSO test.** Sign in at `http://auth.sga.localhost:3000` with a synthetic account, then reload `http://vaultz.sga.localhost:3001`: it shows "Signed in as ...". In DevTools, the `sgauth-local.session_token` cookie has Domain `.sga.localhost`, HttpOnly, SameSite=Lax, and no Secure flag. Sign-in needs a sign-in method (#29); the Playwright job in AUTH-T96 (#108) automates this check.

## Dev environment rules

- Every non-production environment shows the "DEVELOPMENT ENVIRONMENT" banner (`LOCAL ENVIRONMENT` locally) and is `noindex`, through a robots meta tag and an `X-Robots-Tag` header. `dev` and `preview` show the same text on purpose, so the gate page does not reveal which one it is.
- **Build-time behaviour.** The banner and the `noindex` header and meta tag are fixed by the `SGAUTH_ENV` present at **build** time: `/` is statically rendered and the header comes from `next.config.ts`. A server started from a build made with a different `SGAUTH_ENV` keeps the banner and `noindex` of the build, not of the runtime value. Vercel builds each deployment with its own environment, so this holds there. Never serve a build made for one environment as another.
- **Synthetic users only.** Never run a real-user import (AUTH-T87, #99) or copy production data into Neon `dev`.
- Every secret is separate from production: `BETTER_AUTH_SECRET`, the Resend key (AUTH-T20, #32) and the Upstash database (AUTH-T63, #75): `dev` has its own database and token, and its keys sit under `sgauth:dev:`. See [RATE-LIMITING.md](RATE-LIMITING.md). The Resend ticket adds its own row to the variable table.
- **Startup assertion.** `assertSecureCookieConfig` checks the options handed to Better Auth at boot and refuses to start with:
  - `SGAUTH_ENV=local` while Vercel's `VERCEL_ENV` is set, with a base URL host that does not end in `.localhost`, with `useSecureCookies` on, or with cross-subdomain cookies not enabled on `sga.localhost`;
  - outside `local`: a non-`https` base URL, `useSecureCookies` off, a non-Secure or non-HttpOnly cookie, or `SameSite` other than `lax`;
  - on `production` and `dev`: cross-subdomain cookies not enabled on `northeasternsga.com`, or a cookie prefix other than `sgauth` (production) or `sgauth-dev` (dev).

  It prints `Insecure cookie configuration for SGAUTH_ENV=<env>:` followed by one `- <rule>` line per failure, and never a secret.

## SDK dev mode

Products set `SGAUTH_URL` and `SGAUTH_COOKIE_NAME` from the [table above](#cookies-and-sdk-values). The defaults target production. The SDK implements them (#69/#70) on top of the [session endpoint](SESSION-ENDPOINT.md), and the integration guide (AUTH-T80, #92) links back here.

## Build pipeline

`vercel.json` runs `npm ci`, then `node scripts/vercel-build.mjs`. The script:

1. Works out the expected `SGAUTH_ENV` from `VERCEL_ENV` and `VERCEL_GIT_COMMIT_REF`: `production` for Production, `dev` for Preview on branch `dev`, `preview` for any other Preview ref. Anything else is not a Vercel build and the script exits.
2. Exits if `SGAUTH_ENV` differs from that value. This catches a missing `dev` branch override before any migration runs.
3. Requires `DATABASE_URL` and `DIRECT_URL`, and checks their `sslmode`.
4. Logs `SGAUTH_ENV`, `VERCEL_ENV`, the ref and the database host name. Nothing else about the connection is logged.
5. Runs `prisma generate`, `prisma migrate deploy`, then `next build`, stopping at the first failure.

Migrations apply while the previous deployment is still serving, so every migration follows expand/contract ([MIGRATIONS.md](MIGRATIONS.md#expandcontract)). Nothing in the build log may contain a credential or connection string. There are no Vercel cron jobs: scheduled work runs from GitHub Actions (AUTH-T38), so do not add a `crons` section to `vercel.json`.

## Shared pre-production database

`dev` and every PR preview use the one Neon `dev` branch. There is no Neon-Vercel integration, and opening or closing a PR never creates or deletes a Neon branch. The daily hygiene job (#20) deletes only stale `tmp-*` branches.

Consequences:

- A PR's migration is applied, as soon as its preview builds, to the database that `auth-dev` and every other preview use.
- A destructive or incompatible migration in an open PR breaks `auth-dev` and other previews immediately.
- An abandoned PR leaves its migration applied with no matching folder on `dev`.
- Two PRs that both add migrations interleave on one database.

The rule: **PR migrations must be additive (expand only).** Contract steps land on `dev` only after merge.

Recovery: `prisma migrate resolve` for a failed or stray migration, or reset the Neon `dev` branch from `main` before launch (see [MIGRATIONS.md](MIGRATIONS.md#recovery)).

Pre-production data is shared and disposable. Never copy production data into it.

## Protection

- **Production domain:** public. Vercel's Standard Protection never covers production domains.
- **`auth-dev.northeasternsga.com`:** public at the Vercel level through a Deployment Protection Exception (Project Settings, Deployment Protection, Deployment Protection Exceptions, Add Domain). No header or Vercel account is needed. Strangers are kept out in code by #134: sign-up is invite-only, and browser routes sit behind the gate password. Machine endpoints are exempt, so product servers need no header. See #134 for the gate's behaviour.
- **Ordering:** the exception is enabled only after #134 has merged and its gate is verified on `auth-dev`. Until then `auth-dev` is protected like any preview.
- **PR previews:** Vercel Authentication. Team members signed in to Vercel can open them.
- **Protection Bypass for Automation**, for automated tools only (CI, Playwright). Send `x-vercel-protection-bypass: <secret>`. Create the secret under Project Settings, Deployment Protection, Protection Bypass for Automation. Multiple secrets are allowed, one per tool, so each can be revoked alone. Store each in that tool's secret store (a GitHub Actions secret), never in code and never `NEXT_PUBLIC_`.
- **Testing a protected preview in a browser:** send the bypass header together with `x-vercel-set-bypass-cookie: true`, or put `x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true` in the query string of the first request. Vercel sets a cookie and later requests in that browser pass. Use `samesitenone` as the cookie value only when the preview is loaded in a cross-site iframe. A URL carrying the secret leaks it into history and logs, so use it only from your own machine and rotate the secret if it is shared.
- Rotating a bypass secret requires a redeploy before the new value works. Update the consuming tool's secret at the same time.

## Pre-production gates

Two gates keep SGAuth's non-production deployments useless to strangers. Both are keyed off `SGAUTH_ENV` and validated at boot through `src/lib/env.ts` and `toAuthSettings`, so a bad value stops the server from starting.

| `SGAUTH_ENV` | Sign-up allowlist                   | Preview password gate                         |
| ------------ | ----------------------------------- | --------------------------------------------- |
| `production` | not active                          | not active                                    |
| `dev`        | enforced (empty list allows nobody) | enforced, password required unless gate `off` |
| `preview`    | enforced (empty list allows nobody) | enforced, password required unless gate `off` |
| `local`      | enforced (empty list allows nobody) | not active                                    |

### Variables

- `SGAUTH_SIGNUP_ALLOWLIST`: comma-separated exact emails and/or `@domain` entries. `@northeastern.edu` matches `a@northeastern.edu` only, not `a@sub.northeastern.edu`. Sign-in for existing accounts is unaffected. A malformed entry stops boot, naming its position.
- `SGAUTH_PREVIEW_GATE_PASSWORD`: 16 or more characters. Required on `dev` and `preview` unless `SGAUTH_PREVIEW_GATE=off`. Ignored on `production` and `local`. In Vercel, give the Preview (all branches) scope and the `dev` branch override each their own password.
- `SGAUTH_PREVIEW_GATE`: set to `off` to disable the password gate explicitly on `dev` or `preview`.

The gate fails closed: on `dev` or `preview`, a missing password without `SGAUTH_PREVIEW_GATE=off` refuses to start.

### What the password gate covers

Every browser route answers with a redirect to `/preview-gate` until the visitor enters the password. Non-page requests (anything under `/api/` and any non-GET method) get `401 {"error":"preview_gate"}`.

These machine endpoints are exempt, matched exactly and on any method, because product servers call them server-to-server:

- `/api/auth/ok`
- `/api/auth/jwks`
- `/api/auth/token`
- `/api/auth/get-session`
- `/api/sgauth/session`
- `/api/sgauth/session/minimal`
- `/api/health`
- `/.well-known/jwks.json`
- `/.well-known/openid-configuration`

Everything else, including every other `/api/auth/*` endpoint, needs the cookie.

### The cookie

`__Host-sgauth.preview-gate` is signed, HttpOnly, Secure, SameSite=Lax, host-only, and valid for 7 days. Rotating the gate password or `BETTER_AUTH_SECRET` invalidates every issued cookie.

### Automated tools

Playwright and CI must first `POST /preview-gate/unlock` (form-urlencoded `password`, with a same-origin `Origin` header) to obtain the cookie on gated environments. On Vercel previews they also need the Vercel bypass header. Unlock attempts are limited to 10 per IP per 15 minutes per instance.

The limiter's client IP is the `x-real-ip` header, then the first `x-forwarded-for` hop, then a shared `unknown` bucket. It assumes Vercel's header handling, where the platform overwrites both headers so a client cannot spoof them. On any other host (including `npm start`), a client can set those headers and sidestep the limit, and a request with neither header shares one bucket with every other such caller. The 16 or more character password is what protects the gate there.

### Deployment Protection Exception

The Deployment Protection Exception for `auth-dev` must not be enabled until this gate is deployed on `dev`.

## Console settings

To reproduce the Vercel project from scratch:

- Node 22.x, region `iad1`, root directory `.`, Git integration on, system environment variables exposed.
- Production branch `main`.
- Domains: `auth.northeasternsga.com` (production), and `auth-dev.northeasternsga.com` assigned to git branch `dev`.
- Standard Protection with Vercel Authentication on. Deployment Protection Exception for `auth-dev.northeasternsga.com` once #134's gate is live. Bypass secret(s) created.
- Environment variables as in the table above.
- No Neon-Vercel integration.
