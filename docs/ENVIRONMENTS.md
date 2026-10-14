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

| Variable                                                                                  | Purpose                                                                                                                               | Production     | Preview (`dev`)        | Preview (all branches) | Development   | Source | Secret |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------- | ---------------------- | ------------- | ------ | ------ |
| `DATABASE_URL`                                                                            | Pooled runtime role. `sslmode=verify-full`.                                                                                           | Neon `main`    | inherited (Neon `dev`) | Neon `dev`             | empty         | manual | yes    |
| `DIRECT_URL`                                                                              | Direct migration role. `sslmode=verify-full` (fallback below).                                                                        | Neon `main`    | inherited (Neon `dev`) | Neon `dev`             | empty         | manual | yes    |
| `SGAUTH_ENV`                                                                              | Selects Better Auth's `baseURL` (`src/lib/auth/settings.ts`).                                                                         | `production`   | `dev`                  | `preview`              | `local`       | manual | no     |
| `BETTER_AUTH_SECRET`                                                                      | Better Auth signing secret. Generate with `npx @better-auth/cli secret`.                                                              | distinct value | distinct value         | distinct value         | its own value | manual | yes    |
| `SGAUTH_PREVIEW_GATE_PASSWORD` ([#134](https://github.com/SGAOperations/auth/issues/134)) | Password for the browser-route gate outside production.                                                                               | not set        | distinct value         | distinct value         | not set       | manual | yes    |
| `SGAUTH_SIGNUP_ALLOWLIST` ([#134](https://github.com/SGAOperations/auth/issues/134))      | Comma-separated exact emails and `@domain` suffixes allowed to sign up outside production. Lists people, so it stays out of the repo. | not set        | set                    | set                    | not set       | manual | no     |
| `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_ENV`, `VERCEL_GIT_COMMIT_REF`                  | Read by `settings.ts` (preview `baseURL`) and by `scripts/vercel-build.mjs`.                                                          | system         | system                 | system                 | n/a           | Vercel | no     |
| `VERCEL_AUTOMATION_BYPASS_SECRET`                                                         | Exposes one bypass secret. Listed for reference only. Never copied into another product.                                              | system         | system                 | system                 | n/a           | Vercel | yes    |

Notes:

- The `VERCEL_*` variables require "Automatically expose System Environment Variables" to stay on.
- `TEST_DATABASE_URL` is local and CI only. It is never set in Vercel.
- The Development scope is either filled as shown or left empty. Local development uses `.env`.
- Later tickets add their own rows (Resend, Upstash, PostHog, `CRON_SECRET`).

Rules:

- **No secret value is shared across scopes.** `auth-dev` is reachable from the internet, so none of its secrets (`BETTER_AUTH_SECRET`, `SGAUTH_PREVIEW_GATE_PASSWORD`, database credentials) may equal production's or the Preview (all branches) value. The Neon `dev` roles have no access to Neon `main`.
- Nothing secret is `NEXT_PUBLIC_`.
- Every connection string uses `sslmode=verify-full`. The one exception is `DIRECT_URL`, which may use `sslmode=require&sslaccept=strict` if the migration CLI rejects `verify-full`. If that happens, note it on #12.
- The `dev` branch override must set `SGAUTH_ENV`, `BETTER_AUTH_SECRET`, `SGAUTH_PREVIEW_GATE_PASSWORD` and `SGAUTH_SIGNUP_ALLOWLIST`. The build refuses to run without the right `SGAUTH_ENV`. #134's validation refuses to start without the gate password.
- Never set `SGAUTH_PREVIEW_GATE=off` in a Vercel scope.

## Build pipeline

`vercel.json` runs `npm ci`, then `node scripts/vercel-build.mjs`. The script:

1. Works out the expected `SGAUTH_ENV` from `VERCEL_ENV` and `VERCEL_GIT_COMMIT_REF`: `production` for Production, `dev` for Preview on branch `dev`, `preview` for any other Preview ref. Anything else is not a Vercel build and the script exits.
2. Exits if `SGAUTH_ENV` differs from that value. This catches a missing `dev` branch override before any migration runs.
3. Requires `DATABASE_URL` and `DIRECT_URL`, and checks their `sslmode`.
4. Logs `SGAUTH_ENV`, `VERCEL_ENV`, the ref and the database host name. Nothing else about the connection is logged.
5. Runs `prisma generate`, `prisma migrate deploy`, then `next build`, stopping at the first failure.

Migrations apply while the previous deployment is still serving, so every migration follows expand/contract (AUTH-T16). Nothing in the build log may contain a credential or connection string. There are no Vercel cron jobs: scheduled work runs from GitHub Actions (AUTH-T38), so do not add a `crons` section to `vercel.json`.

## Shared pre-production database

`dev` and every PR preview use the one Neon `dev` branch. There is no Neon-Vercel integration, and opening or closing a PR never creates or deletes a Neon branch. The daily hygiene job (#20) deletes only stale `tmp-*` branches.

Consequences:

- A PR's migration is applied, as soon as its preview builds, to the database that `auth-dev` and every other preview use.
- A destructive or incompatible migration in an open PR breaks `auth-dev` and other previews immediately.
- An abandoned PR leaves its migration applied with no matching folder on `dev`.
- Two PRs that both add migrations interleave on one database.

The rule: **PR migrations must be additive (expand only).** Contract steps land on `dev` only after merge.

Recovery: `prisma migrate resolve` for a failed or stray migration, or reset the Neon `dev` branch from `main` before launch (AUTH-T16).

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
