# Browser calls from registered products (CORS)

Server-side calls with the forwarded session cookie remain the recommended way to reach SGAuth. Browser calls are for client components that need them.

## Endpoints

Call these with `fetch(url, { credentials: "include" })`. Without `credentials: "include"` the browser sends no cookie and drops the response.

| Method | Path                          |
| ------ | ----------------------------- |
| GET    | `/api/sgauth/session`         |
| GET    | `/api/sgauth/session/minimal` |
| POST   | `/api/auth/sign-out`          |

The two session response bodies are in [`SESSION-ENDPOINT.md`](SESSION-ENDPOINT.md).

## The token is not browser-reachable

SGAuth sends no CORS headers on `/api/auth/token`, so a direct browser `fetch` is blocked. A browser reaches the token only through a product-side server proxy route. The route calls SGAuth server-to-server with the forwarded cookie and returns what the client needs (the browser-safe `getAccessToken` in auth-sdk).

## Rules

- Only active registry origins are allowed. The match is exact: no wildcard, no pattern, and a different case, port, scheme or trailing slash does not match. A registry change takes effect within 60 s.
- `Access-Control-Allow-Origin` echoes the registry entry, with `Access-Control-Allow-Credentials: true` and `Vary: Origin`.
- The only allowed request header is `Content-Type`. `Retry-After` is exposed, so a client can read a 429's back-off.
- Preflights are answered with `204` and cached for 600 s.
- From an unregistered origin the request may still reach SGAuth, but the response carries no `Access-Control-*` header, so the browser blocks the read.
- `Origin` enforcement on mutations is separate: Better Auth covers `/api/auth/*`, and the origin guard covers `/api/sgauth/*`.
- Preview gate 401s and origin guard 403s come from the proxy without CORS headers. A browser sees them as network errors, so treat them as "SGAuth unreachable", not as signed out.
