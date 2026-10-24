# Session endpoint

How a product resolves the shared SGAuth cookie (AUTH-T28, #40). Products call SGAuth **server-side** with the user's cookie and get back who the user is, their positions and their admin flags. Code is in `src/lib/sgauth-session/`. The cookie itself is described in [SESSION-COOKIE.md](SESSION-COOKIE.md).

## Endpoints

Both are `GET` only. Any other method gets `405`.

- `GET /api/sgauth/session` returns the full response.
- `GET /api/sgauth/session/minimal` returns only the user id and positions, for hot paths.

Example `200` from `/api/sgauth/session`:

```json
{
  "user": {
    "id": "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
    "email": "sam@northeastern.edu",
    "name": "Sam Example",
    "preferredName": null,
    "isAdmin": false,
    "isPrimaryAdmin": false
  },
  "positions": [{ "key": "vp-finance", "name": "Vice President of Finance" }],
  "session": {
    "id": "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c",
    "expiresAt": "2026-02-01T00:00:00.000Z",
    "absoluteExpiresAt": "2026-04-01T00:00:00.000Z",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
}
```

Example `200` from `/api/sgauth/session/minimal`:

```json
{
  "user": { "id": "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b" },
  "positions": [{ "key": "vp-finance", "name": "Vice President of Finance" }]
}
```

- `positions` are the user's active, non-deleted positions, read live from the database on every call, sorted by `key` in code-unit order (not locale or database collation, so `vp-finance` comes before `vpa`). At most 50.
- All dates are ISO 8601 in UTC.
- The minimal response is a strict subset of the full one, so code that reads `user.id` and `positions` works on either.

## Status codes

| Status | Body                                           | When                                                                                                                                                                        |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | the response above                             | a valid session                                                                                                                                                             |
| `401`  | `{"error":"unauthenticated"}`                  | no session cookie, a bad signature, an unknown, revoked, idle-expired or past-the-cap session, or a user who is deactivated, deleted or missing. The body never says which. |
| `429`  | `{"code":"TOO_MANY_REQUESTS","message":"..."}` | more than 120 calls a minute for one session token on one instance. Carries `Retry-After`. See [RATE-LIMITING.md](RATE-LIMITING.md).                                        |
| `5xx`  | none promised                                  | an unexpected error. It is never turned into a `401`, so a product's stale-if-error path can tell "SGAuth is down" from "the user is signed out".                           |

Deactivation and revocation show up on the very next call: nothing is cached on SGAuth's side.

## Headers

Every `200`, `401` and `429` carries `Cache-Control: no-store` and `Vary: Cookie`. Never cache a response in a shared cache keyed on anything but the cookie.

## Calling it

- Send the session cookie in the `Cookie` header, server-side. **Nothing else is read**: a token in the query string, a body or an `Authorization` header is ignored and gets a `401`.
- Forward only the session cookie, and `dont_remember` when the browser has it (so SGAuth does not extend a "don't remember me" session). Never forward the whole browser `Cookie` header. SGAuth drops every other cookie by exact name, but a product should not rely on that.
- Never log the cookie or the response.
- A call slides the session window, as a `/api/auth/get-session` call does, up to the 90-day absolute cap.
- The refreshed `Set-Cookie` goes to the product server, not the browser. Whether the SDK forwards it is the SDK's decision (#70).

## Published schemas

JSON Schema 2020-12, with `additionalProperties: false` at every level. They are generated from `src/lib/sgauth-session/contract.ts` by `contract.test.ts` and shipped in the SDK (#69/#70):

- [`api/sgauth-session.schema.json`](api/sgauth-session.schema.json): the `200` body of `/api/sgauth/session`.
- [`api/sgauth-session-minimal.schema.json`](api/sgauth-session-minimal.schema.json): the `200` body of `/minimal`.
- [`api/sgauth-session-unauthenticated.schema.json`](api/sgauth-session-unauthenticated.schema.json): the `401` body.

To regenerate after a contract change: `npx vitest run src/lib/sgauth-session/contract.test.ts -u`.

**Changing a field is a breaking change for products.** Add fields only, and tell the SDK owners: because the schemas are strict, an SDK that validates responses strictly would reject a new field, so it should validate leniently or pin the schema version.

## Never in a response

Password hashes, session tokens, MFA secrets and backup codes, IP addresses, user agents, and the account status. The strict schemas make adding one a failing test, and the database test walks a real response for them.
