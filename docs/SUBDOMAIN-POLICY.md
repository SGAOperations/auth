# Subdomain policy

Who may have a `northeasternsga.com` subdomain, and what keeps every one of them safe. Owner: the SGAuth lead.

## Why

Every host that can serve HTTPS under `northeasternsga.com` receives the production session cookie, and can set one with the same name (see [SESSION-COOKIE.md](SESSION-COOKIE.md#threat-model)). A dangling record lets someone else become that host. The scope is every record in the `northeasternsga.com` zone, plus any delegated subzone.

## Rules

The review and the exceptions cite these by number.

- **R1. Web hostnames are allowlisted.** A, AAAA, CNAME, ALIAS/ANAME, HTTPS/SVCB and NS records may exist only for:
  - SGAuth's own hosts, `auth` and `auth-dev` ([ENVIRONMENTS.md](ENVIRONMENTS.md#environments));
  - the host of each active product's `baseUrl` in the production registry (`Product`, #68), and its `<slug>-dev` branch domain registered in the dev registry;
  - the apex and `www`, only when served from an SGA-owned account.

  Anything else is not allowed. A product that is not registered yet (pre-cutover, per the rollout order) is an exception until it is registered.

- **R2. Every target is SGA-owned.** It lives in an SGA team or shared-mailbox account (the SGA Vercel team, the SGAuth Resend account), with credentials in the team password manager. A student's personal account is never a target, because it leaves when they graduate.
- **R3. No wildcards.** No `*` record at any level, no Vercel wildcard domain, and no wildcard trusted origin (#68 enforces the origin side in code).
- **R4. Third-party services get a separate domain.** A third-party service is any host whose content comes from software SGA does not write and deploy. Examples: website builders, forms, link shorteners, status pages, docs hosts, ticketing. Such a service never gets a `northeasternsga.com` name, so it never receives the cookie. Vercel-hosted SGA products are not third-party: SGA deploys their code.
- **R5. Email and verification records are allowed** to point at third parties: MX, TXT (SPF, DMARC, site verification), and any record whose name has a label starting with `_` (`_dmarc`, `resend._domainkey.mail`, `_vercel`, `_acme-challenge`). Publicly trusted CAs do not issue certificates for underscore names, so those names cannot serve the HTTPS that a `__Secure-` cookie needs. `mail` and `send.mail` (#32) carry email records only, never A, AAAA or CNAME.
- **R6. No dangling records.** A record whose target no longer exists, or is not claimed by an SGA account, is deleted the day it is found. There is no exception for this rule.
- **R7. HTTPS only.** Every R1 host serves HTTPS and redirects HTTP. The inventory's HTTPS column is the evidence AUTH-T66 (#78) needs before it can consider `includeSubDomains`.

## Adding a subdomain

In this order, so the name never points at an unclaimed target:

1. The SGAuth lead approves.
2. Add the registry entry (prod or dev).
3. Attach the domain to the product's project in the SGA Vercel team.
4. Create the DNS record.
5. Add the row to the inventory.

## Removing a subdomain

In this order:

1. Deactivate the registry entry.
2. Delete the DNS record.
3. Wait one TTL.
4. Remove the domain from the Vercel project, or delete the resource.
5. Update the inventory.

Releasing the hosting before the record is gone is how dangling records are made.

## Exceptions

A record that breaks R1, R2, R4 or R7 but is owned and resolves goes on the inventory's Exceptions tab with the rule, a reason, an owner and a target date. The SGAuth lead approves it, and the quarterly review re-checks it. R3 and R6 have no exceptions.

## Change control

Only people listed in the password-manager entry for the DNS host may edit the zone. Every change is logged in the inventory's Changes tab with the date, who made it, and why.

## Inventory

The inventory is a spreadsheet in the team drive, linked from the latest review issue. It is not committed here: a copy in the repository would go stale between reviews and would publish every verification token in one file. Its columns:

- `name`, `type`, `value`, `TTL`;
- `class`: SGAuth, product prod, product dev, apex/www, email, verification, other;
- `owner`, `target account`, `HTTPS-only`, `status` (ok, removed, exception), `evidence`, `checked on`.

## Review

Quarterly, per [runbooks/subdomain-review.md](runbooks/subdomain-review.md). A scheduled workflow opens the review issue on the 1st of January, April, July and October.
