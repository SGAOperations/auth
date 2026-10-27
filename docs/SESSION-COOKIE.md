# Session cookie

The cookie contract for SGAuth's session, why it cannot use the `__Host-` prefix, and what a compromised subdomain can do with it. The source of truth is `src/lib/auth/cookies.ts`, and `src/lib/auth/cookies.test.ts` pins every name below.

## Contract

The policy comes from `SGAUTH_ENV`, not from separate environment variables, so a mistyped Vercel variable cannot put production and dev on one cookie name.

| `SGAUTH_ENV` | Session cookie                          | Domain                                           | Secure | HttpOnly | SameSite | Path | Read by                             |
| ------------ | --------------------------------------- | ------------------------------------------------ | ------ | -------- | -------- | ---- | ----------------------------------- |
| `production` | `__Secure-sgauth.session_token`         | `northeasternsga.com`                            | yes    | yes      | Lax      | `/`  | SGAuth and every production product |
| `dev`        | `__Secure-sgauth-dev.session_token`     | `northeasternsga.com`                            | yes    | yes      | Lax      | `/`  | SGAuth dev and every dev product    |
| `preview`    | `__Secure-sgauth-preview.session_token` | host-only (the deployment's `*.vercel.app` host) | yes    | yes      | Lax      | `/`  | SGAuth's own testing only           |
| `local`      | `sgauth-local.session_token`            | `sga.localhost`                                  | no     | yes      | Lax      | `/`  | local development                   |

- Better Auth's other cookies share the same prefix and attributes: `dont_remember`, and `session_data` and `account_data`, which are never set here.
- There is no cookie cache, so no `session_data` cookie. Every request reads the session from the database, and revocation and sign-out take effect on the next request.
- `Max-Age` follows `session.expiresIn`: 30 days, see [Session lifetime](#session-lifetime).
- No cookie name is overridden per cookie. Every name is `<__Secure->?<prefix>.<cookie>`.

## Session lifetime

The source of truth is `src/lib/auth/session-lifetime.ts`.

- A 30-day sliding window, refreshed at most once a day (`updateAge`). Each refresh resets the cookie's `Max-Age` to 30 days.
- A 90-day absolute cap from `createdAt`. It is enforced by clamping `expiresAt` to `absoluteExpiresAt` in `session.create.before` and in the `clamp_session_expiry` trigger, so every Better Auth endpoint honours it, `/token` included. The daily purge (#90) deletes the expired rows.
- The cookie can outlive the cap by up to 30 days. That is harmless, because the database row is authoritative.
- `freshAge` is Better Auth's default. Re-auth uses `lastReauthAt` (#44).

## Self-service sessions

The source of truth is `src/lib/sessions/own-sessions.ts`.

- `GET /api/sgauth/sessions` returns the caller's live sessions: `200 { sessions: [{ id, createdAt, lastActiveAt, ip, device, isCurrent }] }`, or `401`. It never returns the token.
- `DELETE /api/sgauth/sessions/:id` revokes one of the caller's sessions: `204`, `401`, `403` (untrusted or missing Origin) or `404`. The `404` is identical for another user's id, an unknown id, an expired id and a malformed id, so ids cannot be probed.
- Revoking the current session also expires `session_token`, `session_data` and `dont_remember`, using the live cookie names and attributes from Better Auth's context.
- `lastActiveAt` is `Session.updatedAt`, which Better Auth bumps only on the daily sliding refresh, so it is accurate to about a day.
- DELETE checks `Origin` (or the origin of `Referer`) locally against Better Auth's trusted origins, until #77 generalizes it.

## Known-device cookie

A second cookie lets the real owner past an account lockout (docs/LOCKOUT.md). It is set after every completed login and carries no session.

| Environment | Name                             |
| ----------- | -------------------------------- |
| production  | `__Secure-sgauth.device`         |
| dev         | `__Secure-sgauth-dev.device`     |
| preview     | `__Secure-sgauth-preview.device` |
| local       | `sgauth-local.device`            |

- **Host-only.** No `Domain`, even where the session cookie is parent-domain. Only the auth host ever reads it, and a product site must never see it, so it is not set through Better Auth's cross-subdomain machinery. `HttpOnly`, `Secure` (except local), `SameSite=Lax`, `Path=/`.
- **Signed.** The value is `<token>.<HMAC>` under the auth secret (Better Auth's signed-cookie helpers), so a forged or edited cookie is rejected before any database read.
- **Hashed at rest.** The token is 32 random bytes, base64url. `KnownDevice.tokenHash` stores its lower-case hex SHA-256, and the lookup is by hash alone, never by email.
- **One year, rolling.** Each login re-sets the cookie, so the year restarts. A device idle for a year, and any beyond a user's 20 most recent, are pruned when a new one is created.
- **Bound to an account.** A cookie counts only for the account whose `KnownDevice` row holds it. Another user's cookie is treated as no cookie.
- **Earned by a login.** An attacker who knows an address cannot get one without the password, so it cannot be used to dodge a lock they caused. A second user signing in on a shared browser replaces the cookie, and the first user loses the exemption on that browser only.

## Why not `__Host-`

Browsers reject a `__Host-` cookie that has a `Domain` attribute (it also requires `Path=/` and `Secure`). A cookie shared across subdomains needs `Domain`, so `__Secure-` is the strongest prefix available.

`__Secure-` only guarantees that the cookie was set over HTTPS with `Secure`. It does not stop another subdomain from setting a cookie with that name.

Preview could technically use `__Host-`. It keeps `__Secure-` so every environment follows one naming rule, because Better Auth only auto-prefixes `__Secure-`. The preview-gate cookie `__Host-sgauth.preview-gate` (#134) is host-only by design and cannot collide with any Better Auth name.

## Threat model

- **Every `*.northeasternsga.com` host receives the production cookie** on every request. That includes `auth-dev`, product `<product>-dev` branch domains, and any subdomain pointed at a third party. HttpOnly keeps it from page scripts, but a host's server code sees it.
  - No SGAuth or product code logs `Cookie` headers.
  - Products forward only the session cookie to SGAuth (the SDK).
  - Dangling or third-party subdomains are the main exposure ([SUBDOMAIN-POLICY.md](SUBDOMAIN-POLICY.md)).
- **Cookie tossing and login CSRF.** Any HTTPS subdomain can set `__Secure-sgauth.session_token` on `Domain=northeasternsga.com`, or set a more specific `Path` or host-only copy that the browser sends first. Values are signed, so it cannot forge another user's session. It can plant a valid session for an attacker-controlled account, which silently logs the victim in as the attacker. Controls:
  - subdomain hygiene ([SUBDOMAIN-POLICY.md](SUBDOMAIN-POLICY.md), #80, AUTH-T68);
  - Origin enforcement on mutations (see **Origin enforcement** below);
  - showing the signed-in identity on account pages;
  - real browser observation in the [cross-subdomain cookie spike](ENVIRONMENTS.md#cross-subdomain-cookie-spike-auth-t104) (#115);
  - refusing a request that carries more than one session cookie (see **Duplicate session cookies** below, #213).
- **SameSite=Lax** stops cross-site subresource and POST requests. Sibling subdomains are same-site, so their POSTs still carry the cookie, and Origin enforcement is the control.
- **Dev and production coexist.** The names differ, so each server reads only its own cookie, and a dev session token means nothing to production's database, or the reverse. The dev cookie also reaches production hosts, where it is never read.
- **Preview** cookies never reach `northeasternsga.com`, which is why `*.vercel.app` previews cannot use product SSO.

### Duplicate session cookies

A sibling host can plant a second copy of the session cookie beside the victim's, as a `Path` copy or a host-only copy ([#115](ENVIRONMENTS.md#cross-subdomain-cookie-spike-auth-t104)). The browser sends both. A product that forwards raw pairs could be confused about which one it holds.

**The rule:** a request whose `Cookie` header carries the session-token name (`sessionCookieName`, for example `__Secure-sgauth-dev.session_token`) more than once is signed out. Every copy counts, an empty value included. The name is trimmed and compared exactly, case-sensitively and without decoding, so a near name such as `__Secure-sgauth.session_token` against `__Secure-sgauth-dev.session_token` is not a copy. A repeated `dont_remember` cookie beside one session token is ignored.

| Endpoint                                                    | With two or more copies                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /api/sgauth/session` and `/api/sgauth/session/minimal` | `401 {"error":"unauthenticated"}`, before any rate limit, Better Auth or database call   |
| `GET` or `POST /api/auth/get-session`                       | `200` with body `null`. The session row is not read and the sliding window does not move |
| `GET /api/auth/token`                                       | `401`, rate limited as today                                                             |

On the Better Auth route, `createDuplicateCookieGuard` (`src/lib/security/duplicate-cookie.ts`) strips every session-token pair before Better Auth sees the request, so Better Auth gives its own signed-out answer. Other Better Auth endpoints are not guarded: refusing sign-out could stop a victim from signing out. In-process `auth.api.getSession` callers are not guarded either.

- **Log:** one `warn` line, `Refused duplicate session cookie`, with `data: { path, copies }` and the request context. Never a cookie name or value, the header or the query string.
- **No `AuditEvent`:** any sibling host can trigger a refusal at will, so an audit row would put attacker-driven database writes on the session hot path. The Origin rejection above follows the same rule.
- **Cookies are not cleared:** a host-only copy on a sibling host cannot be cleared from SGAuth, and a `Set-Cookie` could only remove the victim's own copy.
- **Not covered:** `parent-root`, where the planted cookie replaces the victim's so only one copy exists. That is login CSRF, which pre-login binding would address and this rule does not.
- **SDK:** `getSession()` and `getAccessToken()` apply the same rule before forwarding or consulting their cache. It ships separately in `SGAOperations/auth-sdk#19`.

### Origin enforcement

`src/proxy.ts` runs `createOriginGuard` (`src/lib/security/origin.ts`) after the preview gate on every request whose path is `/api/sgauth` or under `/api/sgauth/`. It covers routes by path, so a new route cannot forget to opt in.

- **Checked:** every method except GET, HEAD and OPTIONS.
  - `Sec-Fetch-Site: cross-site` is rejected whatever the Origin says. Every registered product is same-site with SGAuth, and sibling subdomains are `same-site`, so only Origin tells them apart.
  - The `Origin` header must be a bare http(s) origin. `null` is rejected. A missing Origin falls back to `Referer`, reduced to its origin. Neither present is rejected.
  - The origin must match a registry-derived trusted origin exactly (`getTrustedOrigins()`). There is no wildcard or pattern matching.
  - A registry failure fails closed.
- **Answer:** 403 `{ "code": "INVALID_ORIGIN", "message": "Invalid origin." }`, identical for every reason. The reason, method, path and origin are logged at `warn`, never the cookie, query string or full Referer. A rejection writes no `AuditEvent`.
- **Not covered here:** `/api/auth/*` (Better Auth checks Origin itself, fed by the same registry), server actions (Next rejects an Origin that does not match Host), `/api/csp-report` and `/preview-gate/unlock`.
- **Non-browser callers** (product servers, scripts, curl) must send `Origin: <their registered product origin>` on mutations, or get a 403. The check does not depend on a cookie being present. Origin is not a boundary against a non-browser caller, which can send any value.
- **Limit:** Origin does not stop a compromised registered subdomain. Subdomain hygiene (#80) does.
