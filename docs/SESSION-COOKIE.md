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
- `Max-Age` follows `session.expiresIn` (#39).
- No cookie name is overridden per cookie. Every name is `<__Secure->?<prefix>.<cookie>`.

## Why not `__Host-`

Browsers reject a `__Host-` cookie that has a `Domain` attribute (it also requires `Path=/` and `Secure`). A cookie shared across subdomains needs `Domain`, so `__Secure-` is the strongest prefix available.

`__Secure-` only guarantees that the cookie was set over HTTPS with `Secure`. It does not stop another subdomain from setting a cookie with that name.

Preview could technically use `__Host-`. It keeps `__Secure-` so every environment follows one naming rule, because Better Auth only auto-prefixes `__Secure-`. The preview-gate cookie `__Host-sgauth.preview-gate` (#134) is host-only by design and cannot collide with any Better Auth name.

## Threat model

- **Every `*.northeasternsga.com` host receives the production cookie** on every request. That includes `auth-dev`, product `<product>-dev` branch domains, and any subdomain pointed at a third party. HttpOnly keeps it from page scripts, but a host's server code sees it.
  - No SGAuth or product code logs `Cookie` headers.
  - Products forward only the session cookie to SGAuth (the SDK).
  - Dangling or third-party subdomains are the main exposure (#80).
- **Cookie tossing and login CSRF.** Any HTTPS subdomain can set `__Secure-sgauth.session_token` on `Domain=northeasternsga.com`, or set a more specific `Path` or host-only copy that the browser sends first. Values are signed, so it cannot forge another user's session. It can plant a valid session for an attacker-controlled account, which silently logs the victim in as the attacker. Controls:
  - subdomain hygiene (#80, AUTH-T68);
  - Origin enforcement on mutations (#77);
  - showing the signed-in identity on account pages;
  - real browser observation in #115.
- **SameSite=Lax** stops cross-site subresource and POST requests. Sibling subdomains are same-site, so their POSTs still carry the cookie, and #77's Origin checks are the control.
- **Dev and production coexist.** The names differ, so each server reads only its own cookie, and a dev session token means nothing to production's database, or the reverse. The dev cookie also reaches production hosts, where it is never read.
- **Preview** cookies never reach `northeasternsga.com`, which is why `*.vercel.app` previews cannot use product SSO.
