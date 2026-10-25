# Integrating a Neon product (Next.js)

For a Next.js 15+ App Router product on Neon, served from a `*.northeasternsga.com` subdomain. A product on Supabase follows [the Supabase guide](supabase-products.md) instead (#93).

> Written against `@nusgaops/sgauth`. Last checked against `@nusgaops/sgauth` 0.2.0. This guide is a how-to: it shows each call in use. Signatures are in the [SDK README](https://github.com/SGAOperations/auth-sdk#readme) and the [generated API reference](https://sgaoperations.github.io/auth-sdk/).

How it works:

- SGAuth sets one session cookie on `northeasternsga.com`, so every product subdomain receives it.
- The proxy only checks that the cookie is present. It makes no network call.
- Server code validates the cookie through `getServerSession()` or `requireSession()`, which call `GET {SGAUTH_URL}/api/sgauth/session` ([SESSION-ENDPOINT.md](../SESSION-ENDPOINT.md)).
- The user's positions arrive in the session.
- The product decides what each position means.

## Prerequisites

Confirm each of these before writing code.

- The product is served from a `northeasternsga.com` subdomain over HTTPS only. See [SUBDOMAIN-POLICY.md](../SUBDOMAIN-POLICY.md#rules).
- The product is in the SGAuth product registry on both SGAuth environments: slug, name and base URL `https://<product>.northeasternsga.com` on production, and `https://<product>-dev.northeasternsga.com` on SGAuth dev. An SGAuth admin adds them under `/admin`. Without the entry, `/login?redirect=` drops the redirect and lands on `/account`, and SGAuth rejects mutations from the product's origin (see [Troubleshooting](#troubleshooting)). The order for adding a subdomain is in [SUBDOMAIN-POLICY.md](../SUBDOMAIN-POLICY.md#adding-a-subdomain).
- Node 20 or later, which is the SDK's floor.
- The product owner has a list of the position keys the product will check. Take them from [`prisma/seed/positions.json`](../../prisma/seed/positions.json), or ask an SGAuth admin to create `<product>-<role>` keys in the admin UI.

## Install

Add the package from the public npm registry. No `.npmrc` change or token is needed.

```sh
npm install @nusgaops/sgauth
```

Pin an exact version for the cutover. The SDK supports the latest two minor releases; see [Versioning and support policy](https://github.com/SGAOperations/auth-sdk#versioning-and-support-policy).

## Environment variables

Set the SGAuth URL and cookie name per Vercel scope and in `.env.local`.

- `SGAUTH_URL` is required. The SDK has no default and throws `SgauthConfigError` when it is missing.
- `SGAUTH_COOKIE_NAME` defaults to the production name, so production does not need it. Dev and local do.
- Take both values from [ENVIRONMENTS.md, Cookies and SDK values](../ENVIRONMENTS.md#cookies-and-sdk-values). That table is the source of truth, so it is not copied here.
- **The two values always come from the same row.** A dev URL with the production cookie name is the most common cause of a redirect loop.
- Do not set `NEXT_PUBLIC_SGAUTH_URL` unless client code must build SGAuth links. Build the URLs on the server and pass the `href` down, as in [Account page and logout](#account-page-and-logout).

## Protect routes with `proxy.ts`

Add a proxy that sends signed-out visitors to sign-in. Next 16 reads `src/proxy.ts`. In Next 15, name the file `src/middleware.ts` and export `middleware` instead.

```ts
// src/proxy.ts
import { createSgaProxy } from "@nusgaops/sgauth/proxy";

export const proxy = createSgaProxy({
  publicPaths: ["/", "/health", "/api/uploadthing"],
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- A string in `publicPaths` matches that path and everything beneath it. `"/"` matches only the home page. A `RegExp` is tested against the pathname.
- Put health checks, inbound webhooks, upload callbacks and public pages in `publicPaths`. The paths above are VaultZ's.
- The proxy checks only that the cookie is present. It never calls SGAuth: it runs on every request, so a round trip would slow every page and bypass the SDK's session cache.
- Signed-out `GET` and `HEAD` requests are redirected to sign-in. Other methods get `401 {"error":"unauthenticated"}`, so a Server Action is never redirected to an HTML page.

To combine it with the product's own proxy logic, call the SGAuth handler first and return its response when it redirects or rejects:

```ts
// src/proxy.ts
import { createSgaProxy } from "@nusgaops/sgauth/proxy";
import type { NextRequest } from "next/server";
import { productProxy } from "@/lib/product-proxy";

const sgaProxy = createSgaProxy({ publicPaths: ["/health"] });

export function proxy(request: NextRequest) {
  const response = sgaProxy(request);
  // A redirect (307) or a 401 means the visitor is signed out.
  if (response.status !== 200) return response;
  return productProxy(request);
}
```

> **The proxy is not authorization.** A request that carries any cookie value gets through. Every page, action and route handler still calls `requireSession()` or `getServerSession()`.

## Read the session

Validate the cookie in server code, in whichever of these three places the request lands.

### Server component

`requireSession()` returns the session, or redirects to sign-in when the cookie is invalid or revoked. Use `getServerSession()`, which returns `null` instead, on a page that renders differently when signed out. One request resolves the session once, because both are wrapped in React's `cache()`.

```tsx
// src/app/dashboard/page.tsx
import { requireSession } from "@nusgaops/sgauth/next";

export default async function DashboardPage() {
  const session = await requireSession();
  return <h1>Hello, {session.user.preferredName ?? session.user.name}</h1>;
}
```

### Server action

Call `requireSession()` inside the action. Never trust a user id passed from the client. Check the capability ([next section](#gate-features-by-position)) before any write.

```ts
// src/app/budgets/actions.ts
"use server";
import { requireSession } from "@nusgaops/sgauth/next";

export async function renameBudget(budgetId: string, name: string) {
  const session = await requireSession();
  // Use session.user.id, never an id taken from the arguments.
  // ...
}
```

### Route handler

The caller is code, not a browser, so answer `401` instead of redirecting. Use `getSession` from the root entry with the request headers.

```ts
// src/app/api/budgets/route.ts
import { getSession } from "@nusgaops/sgauth";

export async function GET(request: Request) {
  const session = await getSession({ headers: request.headers });
  if (session === null) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  return Response.json({ userId: session.user.id });
}
```

### The session object

- `user.id`: the SGAuth user id, a UUID. This is the key to store.
- `user.email`, `user.name` and `user.preferredName` (`null` when unset).
- `user.isAdmin` and `user.isPrimaryAdmin`.
- `positions`: an array of `{ key, name }`, sorted by key.
- `session.expiresAt`, `session.absoluteExpiresAt`, `session.createdAt` and `session.id`, as ISO strings.

The full shape is in [SESSION-ENDPOINT.md](../SESSION-ENDPOINT.md) and in the SDK's exported `SgaSession` type.

> **Rules.** Never log the `Cookie` header or the session token. Never forward any cookie other than the session cookie, which the SDK already does. The threat model is in [SESSION-COOKIE.md](../SESSION-COOKIE.md#threat-model).

## Gate features by position

Map the product's capabilities to position keys in one file, so position keys appear nowhere else in the product. The keys below are an example, taken from VaultZ's proposal.

```ts
// src/lib/permissions.ts
import { hasAnyPosition, type MaybeSession } from "@nusgaops/sgauth/next";

const CAPABILITIES = {
  "manage-budgets": [
    "vice-president-of-operational-affairs",
    "comptroller",
    "finance-manager",
  ],
} as const satisfies Record<string, readonly string[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(session: MaybeSession, capability: Capability): boolean {
  return hasAnyPosition(session, CAPABILITIES[capability]);
}
```

Use it in a server action, after `requireSession()` and before the write:

```ts
// src/app/budgets/actions.ts
"use server";
import { requireSession } from "@nusgaops/sgauth/next";
import { can } from "@/lib/permissions";

export async function approveBudget(budgetId: string) {
  const session = await requireSession();
  if (!can(session, "manage-budgets")) {
    return { error: "forbidden" } as const;
  }
  // ...
}
```

- **Check keys, never display names.** A name can be edited. A key does not change.
- A user with no positions gets no access, unless the product decides otherwise. `hasAnyPosition` returns `false` for an empty list of keys.
- Do not grant product capabilities from `isAdmin` by default. It means "SGAuth administrator", not "administrator of this product". Map it only if the product owner chooses to.
- Hiding a button is not enforcement. The check runs on the server.
- If no office covers a role, ask an SGAuth admin for a `<product>-<role>` position. Never hardcode user ids or emails.

## Key product tables by SGAuth user id

Store the SGAuth user id on the product's user table and create the row on first login.

- Add `sgauthUserId` as a unique string column and use it as the foreign key. Never key on email: an email can change and the id never does. Read the email and name from the session, and store them only for display.
- Concurrent first requests can race on the unique index. Catch Prisma `P2002` and read the row once more.

```ts
// src/lib/current-user.ts
// Adjust the Prisma imports to the product's own client location.
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@nusgaops/sgauth/next";
import { cache } from "react";

export const getCurrentUser = cache(async () => {
  const { user } = await requireSession();
  const data = { email: user.email, name: user.name };
  try {
    return await prisma.user.upsert({
      where: { sgauthUserId: user.id },
      create: { sgauthUserId: user.id, ...data },
      update: data,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return prisma.user.findUniqueOrThrow({
        where: { sgauthUserId: user.id },
      });
    }
    throw error;
  }
});
```

SGAuth never hard-deletes a user. A deactivated user's session returns `401`. A tombstoned user keeps their id with the personal data removed. So product rows never orphan, and a product must not delete its own rows when it sees a `401`.

## Account page and logout

Show who is signed in, link to the SGAuth account page, and add a sign-out link.

```tsx
// src/components/account-menu.tsx
import { accountUrl, logoutUrl, requireSession } from "@nusgaops/sgauth/next";

export async function AccountMenu() {
  const { user } = await requireSession();
  return (
    <nav>
      <span>{user.preferredName ?? user.name}</span>
      <a href={accountUrl()}>Your SGA account</a>
      <a href={logoutUrl("https://myproduct.northeasternsga.com/")}>
        Sign out of all SGA tools
      </a>
    </nav>
  );
}
```

- Logout is global. There is one session, so signing out of one product signs the user out of every SGA product. Say so in the product's copy.
- Render `logoutUrl` as a plain `<a>`, never a prefetching `<Link>`. A prefetch is answered with `204` and signs nobody out, so the link would do nothing.
- A `redirect` is honoured only for SGAuth itself or a registered product origin. Anything else lands on `/login`. A logout started from a cross-site page gets a `403`; sibling subdomains are same-site and work. See [LOGOUT.md](../LOGOUT.md#for-products).
- There is no "sign out of this product only". Remove any product-local session.

## Dev, preview and local

Each topic is covered in [ENVIRONMENTS.md](../ENVIRONMENTS.md). This is the short version.

- **Production** needs `SGAUTH_URL` only.
- **Product dev and previews** use a stable branch domain, `<product>-dev.northeasternsga.com`, with the dev row's values. See [Product previews](../ENVIRONMENTS.md#product-previews).
- **Ad-hoc `*.vercel.app` previews cannot use SSO.** The browser never sends a `northeasternsga.com` cookie to `vercel.app`. Show an "SSO unavailable on this host" page there instead of redirecting. Compare the request host with the host the product is configured for, and render the page when they differ.
- **SGAuth dev has a password gate.** Each tester unlocks it once per browser. See [Pre-production gates](../ENVIRONMENTS.md#pre-production-gates).
- **Local:** run the product on `<product>.sga.localhost:<port>` against `http://auth.sga.localhost:3000`, with the cookie name `sgauth-local.session_token`. Never browse to bare `localhost`. Name resolution per browser is in [Local development](../ENVIRONMENTS.md#local-development).
- `node scripts/sso-stub.mjs` in this repository stands in for a product. It shows whether the cookie reaches a sibling host before any product code exists.
- Dev and local use synthetic accounts only.

## Propagation and staleness

How quickly a change in SGAuth reaches the product (required by #57).

- SGAuth reads positions, deactivation and revocation live on every session lookup.
- The SDK caches each session for 60 s by default (`cacheTtlSeconds`, at most 300 s). A product sees a change within that time.
- A rejected cookie (`401`) is remembered for 10 s.
- If SGAuth is unreachable or answers with a `5xx`, the SDK serves the last cached session for that token for up to `staleIfErrorSeconds` more (default 300 s, at most 900 s) and calls `onError`. With nothing cached it fails closed and returns `null`.
- **The worst case** is the cache TTL while SGAuth is reachable, and the TTL plus `staleIfErrorSeconds` after the last good lookup during an outage. With the defaults that is 60 s, then 6 minutes. A product that cannot accept the outage window lowers `staleIfErrorSeconds`.
- "Force re-login" and admin revocation take effect in a product within the same bound.
- Wire `onError` to the product's logging, and never log the token:

```ts
// src/lib/sgauth.ts
import { createSgauthClient } from "@nusgaops/sgauth";

export const sgauth = createSgauthClient({
  staleIfErrorSeconds: 120,
  onError: ({ kind, status, servedStale }) =>
    console.warn("sgauth upstream failure", { kind, status, servedStale }),
});
```

`requireSession()` and `getServerSession()` use the SDK's default client, which has the defaults above and the default `onError` (none). A product that sets options calls `sgauth.getSession({ headers: await headers() })` itself.

The Supabase JWT staleness window (10 minutes) does not apply to a Neon product. See [the Supabase guide](supabase-products.md).

## Migrating a product that already has users

Follow these steps in order. Each is additive until the last.

1. Add a nullable, unique `sgauthUserId` column. This is the expand step.
2. Make sure the product's users exist in SGAuth. The import (AUTH-T87, #99) creates password-less accounts by lower-cased email.
3. On a user's first SGAuth login, link the session user to the existing row by lower-cased email, when `sgauthUserId` is null and exactly one row matches. Otherwise create a new row and flag it for an admin to link by hand.
4. Put the cutover behind a `SGAUTH_ENABLED` flag for one release, so rollback is a flag flip.
5. Add the registry entries, DNS, environment variables per scope and a pinned SDK version. Smoke-test on the `-dev` branch domain.
6. Announce the change through the [rollout plan](../ROLLOUT.md) (#102). This guide covers the technical steps only.
7. Rehearse the rollback on dev.
8. After one stable release, drop the product's own passwords and sessions, its passphrase or login pages, its auth environment variables and the flag. This is the contract step.

After step 8, SGAuth is the only credential store. The product keeps no password column.

## Troubleshooting

| Symptom                                                                                                                         | Likely cause                                                                                                                                                                                                                                                                                             | Fix                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cookie missing.** Every request redirects to sign-in, and DevTools shows no `...session_token` cookie on the product's host.  | The product is on `*.vercel.app` or bare `localhost`. Or `SGAUTH_COOKIE_NAME` does not match the environment. Or the user signed in on a different environment: dev and production cookies have different names.                                                                                         | Use the branch domain or `<product>.sga.localhost`. Take `SGAUTH_URL` and `SGAUTH_COOKIE_NAME` from the same row. Sign in on the environment the product points at. |
| **Redirect loop** between the product and SGAuth sign-in.                                                                       | The proxy looks for a cookie name SGAuth never sets, or `getSession()` fails while SGAuth considers the user signed in. The usual case is the production URL with the dev cookie name, or the reverse.                                                                                                   | Fix the pair, then clear the product's cookies.                                                                                                                     |
| **401 loop.** The cookie is present, `requireSession()` keeps redirecting, and SGAuth shows the user as signed in.              | `SGAUTH_URL` points at an SGAuth environment that does not own this cookie. Or the call to SGAuth is blocked: check for Vercel Deployment Protection on `auth-dev` (the session endpoint is exempt from the gate). Or an outbound network failure or the 3 s timeout, which shows up as `onError` calls. | Check the `onError` logs, then `curl -sI "$SGAUTH_URL/api/auth/ok"` from the same network.                                                                          |
| **Origin rejected.** A request from the product to SGAuth returns `403`, or login ignores `?redirect=` and lands on `/account`. | The product's exact origin is not an active registry row, or it was added less than 60 s ago. Origins match exactly: no wildcard and no `*.vercel.app`.                                                                                                                                                  | Ask an SGAuth admin to add the origin, then wait 60 s. See [Product previews](../ENVIRONMENTS.md#product-previews).                                                 |
| **Signed out everywhere** after clicking sign out in one product.                                                               | Expected: logout is global, because there is one session.                                                                                                                                                                                                                                                | Say so in the product's copy.                                                                                                                                       |
| **A position change does not show up.**                                                                                         | The SDK is still serving the cached session.                                                                                                                                                                                                                                                             | Wait for the cache TTL (60 s by default). See [Propagation and staleness](#propagation-and-staleness).                                                              |
| **`SgauthConfigError`** on every request.                                                                                       | `SGAUTH_URL` is missing or not a valid URL.                                                                                                                                                                                                                                                              | Set it for that Vercel scope, and redeploy.                                                                                                                         |

## Related docs

- [ENVIRONMENTS.md](../ENVIRONMENTS.md): URLs, cookie names, gates and the preview topology.
- [SESSION-COOKIE.md](../SESSION-COOKIE.md): the cookie contract and the threat model.
- [SESSION-ENDPOINT.md](../SESSION-ENDPOINT.md) and [LOGOUT.md](../LOGOUT.md): what the SDK calls.
- The [SDK README](https://github.com/SGAOperations/auth-sdk#readme) and the [API reference](https://sgaoperations.github.io/auth-sdk/).
- [Supabase-backed products](supabase-products.md) (#93).
- [The design summary](../sgauth-design/SGAuth-design-summary.md).

Validated by: VaultZ integration (VAULTZ-V01 to V08): pending.
