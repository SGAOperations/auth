# Supabase-backed products

Integration guide for a product whose app runs on Supabase and wants to trust SGAuth for sign-in. Supabase accepts SGAuth as a third-party auth provider: it verifies SGAuth's JWTs against SGAuth's published keys, and Postgres row-level security (RLS) then sees the SGAuth user id and positions.

Read [Limitations](#6-limitations) before you commit to this path. If your product does not depend on Supabase-only features, [moving to Neon](#8-move-to-neon-instead) is simpler.

SGAuth itself is built on Neon and uses no Supabase code. The script in this guide only calls the Supabase Management API about _your product's_ project.

## 1. Register SGAuth as a third-party auth provider

Prerequisites:

- A Supabase personal access token (account settings, access tokens), exported as `SUPABASE_ACCESS_TOKEN`.
- Your project ref: the 20 lowercase letters in the project URL.
- Your product registered in SGAuth's product registry.

The Supabase dashboard lists only Clerk, Firebase, Auth0, Cognito and WorkOS as third-party providers. A generic issuer is set through the Management API only.

### With the script

Node 22.6 or later:

```bash
export SUPABASE_ACCESS_TOKEN=...

# Default: Supabase discovers the keys from the issuer (oidc).
node --experimental-strip-types scripts/supabase-register-tpa.ts \
  --project-ref abcdefghijklmnopqrst

# Dev or a throwaway project: use the dev issuer.
node --experimental-strip-types scripts/supabase-register-tpa.ts \
  --project-ref abcdefghijklmnopqrst \
  --issuer https://auth-dev.northeasternsga.com

# Point Supabase straight at the key set.
node --experimental-strip-types scripts/supabase-register-tpa.ts \
  --project-ref abcdefghijklmnopqrst --mode jwks-url

# Fallback: inline the live keys. See Limitations.
node --experimental-strip-types scripts/supabase-register-tpa.ts \
  --project-ref abcdefghijklmnopqrst --mode custom-jwks
```

`--dry-run` prints the request body and sends nothing. Each mode sends exactly one field: `oidc_issuer_url`, `jwks_url` or `custom_jwks`.

The script is safe to re-run. If an integration already has the same issuer or JWKS URL it prints `Already registered: <id>` and goes straight to verification. It never matches a `custom_jwks` integration, so that mode always creates a new one.

| Exit code | Meaning                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| 0         | Registered and verified: Supabase resolved a key that SGAuth publishes.              |
| 1         | Bad input or an API error. One line says which.                                      |
| 2         | Not verified: Supabase has not resolved keys yet, or its keys do not match SGAuth's. |

Supabase resolves keys asynchronously. The script polls for up to 30 seconds. On exit 2 with unresolved keys, re-run in a few minutes. If it never resolves, use `--mode custom-jwks`.

### With curl

```bash
REF=abcdefghijklmnopqrst
BASE="https://api.supabase.com/v1/projects/$REF/config/auth/third-party-auth"

# Register.
curl -sS -X POST "$BASE" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"oidc_issuer_url":"https://auth.northeasternsga.com"}'

# Verify: read it back and check resolved_jwks.
curl -sS "$BASE/<id>" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
```

A resolved integration looks like this (abridged):

```json
{
  "id": "…",
  "oidc_issuer_url": "https://auth.northeasternsga.com",
  "resolved_jwks": {
    "keys": [{ "kty": "EC", "crv": "P-256", "alg": "ES256", "kid": "…" }]
  }
}
```

`resolved_jwks` must be non-null and contain a `kid` that is in SGAuth's own JWKS at `https://auth.northeasternsga.com/.well-known/jwks.json`.

### Removing the integration

The script does not delete. Use curl:

```bash
curl -sS -X DELETE "$BASE/<id>" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
```

## 2. Token requirements

What Supabase needs from a third-party token, and what SGAuth sends. SGAuth's discovery document is at `/.well-known/openid-configuration` and its key set at `/.well-known/jwks.json`; this guide does not restate them.

| Claim or header    | SGAuth sends                         | Why Supabase needs it                                                  |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------- |
| `alg` (header)     | `ES256`                              | Supabase third-party auth accepts asymmetric keys; SGAuth signs ES256. |
| `kid` (header)     | The signing key's id                 | Selects the key from the JWKS.                                         |
| `iss`              | The SGAuth origin                    | Must equal the registered issuer.                                      |
| `aud`              | `authenticated`                      | Matches Supabase's own convention, so any audience check passes.       |
| `sub`              | The user's UUID                      | Becomes `auth.uid()`.                                                  |
| `role`             | `authenticated`                      | Maps the request to the `authenticated` Postgres role.                 |
| `exp`              | 10 minutes after `iat`               | Tokens are short-lived; Supabase rejects an expired one.               |
| `email`, `name`    | The user's profile                   | Available through `auth.jwt()`.                                        |
| `positions`        | Sorted array of active position keys | Read in RLS through `auth.jwt() -> 'positions'`.                       |
| `is_admin`         | Boolean                              | Read in RLS through `auth.jwt()`.                                      |
| `is_primary_admin` | Boolean                              | Read in RLS through `auth.jwt()`.                                      |

Each requirement below is proved by a test in [`src/lib/auth/jwt-conformance.db.test.ts`](../../src/lib/auth/jwt-conformance.db.test.ts). The test title is given in quotes.

- [ ] ES256 signature, with a `kid` in the header that is published in the JWKS: "verifies through the remote JWKS, with an ES256 header that names a published kid".
- [ ] `role` is `authenticated`: "carries the claims Supabase reads".
- [ ] `sub` is the user's UUID: "carries the claims Supabase reads".
- [ ] `iss` equals the discovery document's `issuer`: "carries the claims Supabase reads".
- [ ] `aud` is `authenticated`: "carries the claims Supabase reads".
- [ ] Lifetime (`exp - iat`) is at most 10 minutes: "carries the claims Supabase reads".
- [ ] The discovery document is valid, and `jwks_uri` resolves to a key set: "names an issuer that is a bare origin, a jwks_uri under it, and ES256", "is served at the well-known path, and the key set at jwks.json", "points jwks_uri at a key set that answers with keys".
- [ ] The JWKS holds public keys only: "publishes public ES256 P-256 keys only, each with a unique kid".
- [ ] A rotated-out key stays published for 7 days, then is dropped: "keeps the retired key published for 7 days, then drops it".
- [ ] The token endpoint requires a live session: "refuses a request with no cookie", "refuses a cookie with a tampered signature", "refuses a session that was revoked", "refuses a session that has expired".

## 3. Client setup

Install the SDK (`@nusgaops/sgauth`) and `@supabase/supabase-js` in your product. Set `accessToken` on the client, so every request carries the SGAuth JWT instead of a Supabase session.

### Server side

`createSupabaseAccessTokenProvider` is bound to one request's cookies. It returns `null` for a signed-out user and caches the token until 60 seconds before it expires. Server side only.

```ts
import { headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAccessTokenProvider } from "@nusgaops/sgauth";

export async function supabaseForRequest() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      accessToken: createSupabaseAccessTokenProvider({
        headers: await headers(),
      }),
    },
  );
}
```

`getAccessToken({ headers })` returns the token string directly, for code that does not use supabase-js.

### Browser

Browser code must not read the SGAuth cookie. Add a same-origin product route that proxies to SGAuth, then give the browser client the browser-safe provider.

```ts
// app/api/sgauth/token/route.ts
import { createAccessTokenRouteHandler } from "@nusgaops/sgauth";

export const GET = createAccessTokenRouteHandler();
```

```ts
// Client component
import { createClient } from "@supabase/supabase-js";
import { createBrowserSupabaseAccessTokenProvider } from "@nusgaops/sgauth/browser";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { accessToken: createBrowserSupabaseAccessTokenProvider() },
);
```

The route answers 200 `{ token }`, 401 `{ token: null }` or 503 `{ error: "sgauth_unavailable" }`, and adds no CORS headers.

> **Do not call `supabase.auth.*`.** With `accessToken` set, those methods throw. Sign-in, sign-out and account pages go through SGAuth.

## 4. Row-level security

`auth.uid()` returns the SGAuth user id (the token's `sub`). Positions are in the `positions` claim.

Gate on position **keys**, never display names. Names can change; keys are stable.

```sql
create or replace function public.has_position(p text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'positions') ? p, false)
$$;
```

Example table and policies. Replace `treasurer` with your own position key.

> **Prerequisite:** `expense_reports.owner_id` references `public.users`. Create that table first, using the DDL in [section 5](#5-decoupling-from-authusers), or this SQL fails when applied in order.

```sql
create table public.expense_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users (id),
  amount_cents integer not null,
  created_at timestamptz not null default now()
);

alter table public.expense_reports enable row level security;

create index expense_reports_owner_id_idx
  on public.expense_reports (owner_id);

-- Owners see their own rows; treasurers see all of them.
create policy "read own or treasurer"
  on public.expense_reports
  for select
  to authenticated
  using (
    (select auth.uid()) = owner_id
    or (select public.has_position('treasurer'))
  );

-- Only treasurers may insert, and only as themselves.
create policy "treasurers insert"
  on public.expense_reports
  for insert
  to authenticated
  with check (
    (select auth.uid()) = owner_id
    and (select public.has_position('treasurer'))
  );
```

Performance:

- Wrap `auth.uid()`, `auth.jwt()` and `has_position(...)` in `(select …)`, as above. Postgres then evaluates them once per statement (an initPlan) instead of once per row.
- Index the owner column.
- Always set `to authenticated`, so the policy is skipped for `anon`.

## 5. Decoupling from `auth.users`

Third-party users have no row in `auth.users`. A foreign key or trigger on `auth.users` will not work for them. Keep your own users table, keyed by the SGAuth user id:

```sql
create table public.users (
  id uuid primary key,
  email text not null,
  name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;

create policy "own row"
  on public.users
  for all
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
```

On a user's first request, upsert the row from the token's claims (`sub`, `email`, `name`). Create it in the request path, not in a trigger.

Migration checklist:

- [ ] Replace every foreign key to `auth.users` with one to `public.users`.
- [ ] Drop triggers on `auth.users`. Move what they did into the first-request upsert.
- [ ] Rename columns such as `supabaseAuthId` to `sgauthUserId`, and backfill them with SGAuth ids.
- [ ] Never hard-delete a user row. SGAuth tombstones users and keeps their ids, so a deleted user's id is never reused.

## 6. Limitations

1. No Supabase sessions, refresh tokens, MFA or password features for these users. SGAuth owns all of them.
2. JWT staleness of up to 10 minutes. A position or admin change reaches RLS only when the user's token is replaced. SGAuth's "force re-login" bounds this.
3. Supabase refreshes the JWKS on its own schedule, which can take up to 30 minutes. That is why a rotated-out SGAuth key stays published for 7 days. See [`docs/runbooks/rotate-secrets.md`](../runbooks/rotate-secrets.md) (SGAOperations/auth#81).
4. **Billing: $0.00325 per third-party monthly active user (MAU) beyond the plan quota.**
5. If discovery fails, use the `custom_jwks` fallback (`--mode custom-jwks`). The keys are inlined, so they must be pushed again on every rotation.

## 7. Alternative: verify with `jose`

If your product does not need RLS, skip third-party auth. Verify the token on your server and use the service-role client.

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = "https://auth.northeasternsga.com";
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export async function verifySgauthToken(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    audience: "authenticated",
    algorithms: ["ES256"],
  });
  return payload;
}
```

Then query with a service-role client built from your server-only secrets.

> **The service-role key bypasses RLS.** Keep it server-only, never in a `NEXT_PUBLIC_` variable, and do your own authorization checks from the verified claims.

## 8. Move to Neon instead

**Recommendation:** move to Neon if your product does not depend on Supabase Storage, Realtime or Edge Functions. You drop the third-party MAU charge and the JWKS timing limits, and you follow the standard guide in [`docs/integration/neon-products.md`](neon-products.md) (SGAOperations/auth#92).

Checklist:

- [ ] Inventory the Supabase-only features you use (Storage, Realtime, Edge Functions). If any are essential, stay on Supabase.
- [ ] `pg_dump` the app schemas only. Exclude `auth`, `storage`, `realtime` and `supabase_*`.
- [ ] Restore the dump into a Neon branch.
- [ ] Rewrite the RLS policies, or move authorization into server code.
- [ ] Replace `supabase-js` data calls with your Neon client.
- [ ] Follow [`docs/integration/neon-products.md`](neon-products.md).
- [ ] Cut over. Delete the Supabase project only after you have exported anything you still need from `auth.users`.

## Verification record

Filled in by the operator after a live run against a throwaway Supabase project, before this guide's pull request merges.

| Date             | SGAuth issuer | Supabase project (throwaway) | Script mode | Token accepted | `auth.uid()` policy | Position policy | Verified by |
| ---------------- | ------------- | ---------------------------- | ----------- | -------------- | ------------------- | --------------- | ----------- |
| Not yet verified |               |                              |             |                |                     |                 |             |
