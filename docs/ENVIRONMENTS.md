# Environments

## Pre-production gates

Two gates keep SGAuth's non-production deployments useless to strangers. Both are keyed off `SGAUTH_ENV` and validated at boot by `parseAuthEnv`, so a bad value stops the server from starting.

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
