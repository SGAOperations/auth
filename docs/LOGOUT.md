# Logout and session revocation

How a user, a product and an admin end sessions. Cookie attributes are in [`SESSION-COOKIE.md`](SESSION-COOKIE.md); the audit catalog is in `src/lib/audit.ts`.

## Contract

Every endpoint below deletes the session row and expires the session cookie: `<__Secure->?<prefix>.session_token` with `Domain=northeasternsga.com`, `Path=/` and `Max-Age=0` (the prefix and domain per environment are in `SESSION-COOKIE.md`). Because the row is gone and there is no cookie cache, every subdomain that shares the cookie is logged out on its next request.

| Endpoint                               | Deletes                | Audit event                  | Responses                                                                                       |
| -------------------------------------- | ---------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /api/auth/sign-out`              | the current session    | `LOGOUT`, when a row existed | 200 `{ success: true }`, always, even with no session. Better Auth's origin check applies.      |
| `POST /api/sgauth/sessions/revoke-all` | all of the user's rows | `SESSIONS_REVOKED` (`all`)   | 200 `{ status: true }`; 400 `INVALID_BODY`; 401 with no session; 403 for an untrusted `Origin`. |
| `GET /logout?redirect=<url>`           | the current session    | `LOGOUT`, when a row existed | 303 to the target or `/login`; 403 when `Sec-Fetch-Site` is `cross-site`; 204 for a prefetch.   |

`revoke-all` takes an empty body or `{}`. It forwards to Better Auth's `/revoke-sessions`, so the origin check (fed by the product registry), the session middleware and the audit adapter all apply. An `after` hook expires the cookie, because that endpoint deletes the caller's own row too.

## For products

Send the user to:

```
https://auth.northeasternsga.com/logout?redirect=<absolute URL on your registered origin>
```

- Use a plain `<a href>`. Never a prefetching `<Link>`: a prefetch is answered with 204 and does not sign out, so the link would do nothing.
- A `redirect` that is not SGAuth itself or a registered product origin lands on `/login`. So does anything malformed: userinfo, a backslash, `//host`, a non-`https:` scheme or a target over 2048 characters.
- A logout started from a cross-site page (for example a link in webmail) gets a 403 and changes nothing. Sibling subdomains are same-site and work. A request with no `Sec-Fetch-Site` header (older browsers, curl) is allowed.

## Revocation semantics

- Sign-out and revoke-all take effect on every subdomain at once, on its next request.
- Admin revocation is `revokeAllSessionsForUser()` in `src/lib/auth/revocation.ts`. It deletes the rows and writes `SESSIONS_REVOKED` in one transaction, and it does not authorize: the admin users endpoint (#48) must run `can()` first. The target's browser keeps a dead cookie that resolves to no session.

## Supabase-backed products

ES256 JWTs already issued by `/api/auth/token` stay valid until `exp`, up to 10 minutes after a logout or revocation, because Supabase verifies them offline against the JWKS. A product that needs an instant cut-off must check the session endpoint ([`SESSION-ENDPOINT.md`](SESSION-ENDPOINT.md)). This section is the text the Supabase integration guide links to or copies when it is written.
