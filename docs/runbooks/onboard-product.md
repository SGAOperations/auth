# Runbook: onboard a new product

The admin-side checklist for adding a product to SGAuth. Developer integration
steps live in the integration guides, and DNS rules live in
`docs/SUBDOMAIN_POLICY.md` (lands with #80).

> Status: the registry pages land with #62. Check labels against the merged UI
> during the dev walkthrough.

## Who is authorized

Any admin.

## Before you start

The product owner gives you a **slug** and a **base URL**. The URL must be
`https://<x>.northeasternsga.com`.

## Procedure

1. Confirm the slug and base URL with the owner.
2. Create the DNS record as `docs/SUBDOMAIN_POLICY.md` says (lands with #80). No
   wildcard records, and only registry products get a subdomain.
3. Create the registry entry from the admin product pages. Fill in the name, slug,
   base URL, description, icon URL, **visible-to-positions** and the login
   redirect path. Audit event: `PRODUCT_CREATED`.
4. On the registry page, confirm the origin is now trusted and the product URL
   appears on the account page. No deploy is needed.
5. Create the product's prefixed positions, for example `<slug>-admin`. See
   [positions.md](positions.md).
6. Hand the developer the matching integration guide: Neon products
   (`docs/integration/neon-products.md`, lands with #92) or Supabase products
   (`docs/integration/supabase-products.md`, lands with #93).
7. Smoke test on dev: sign in through `/login?redirect=<product URL>` and confirm
   you land back on the product signed in.

## Verify afterwards

- [ ] The audit log shows `PRODUCT_CREATED`.
- [ ] The origin is trusted and the URL shows on the account page.
- [ ] The smoke test passed on dev.
