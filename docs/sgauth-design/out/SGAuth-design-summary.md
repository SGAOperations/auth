# SGAuth — Design Summary

**Date:** 2026-09-18 · **Status:** Design settled, red-teamed, tickets regenerated · **Owner:** SGA Digital Innovation

> Revision 2026-09-18 (Benedikt's review): lazy set-password instead of an import-day invite blast; separate Resend account for SGAuth; optional passkeys in Phase 4.
>
> Revision after the red-team review (see `SGAuth-red-team.md`): Neon stays on Free as an accepted, monitored risk; scheduled jobs run from GitHub Actions instead of Vercel cron; user deletion is a tombstone; the rate limiter fails open; the SDK is published to public npm; lockout has a known-device exemption; JWKS rotation is manual with a Management API push; emailed links consume tokens on POST (Safe Links); sign-up overwrites unverified accounts (pre-hijack); Chambers items are a checklist, not a Linear import; the Chambers `auth.users` export is Eli's manual action item.

SGAuth is the centralized authentication and identity service for Northeastern SGA. One login at `auth.northeasternsga.com` yields one session shared by every product on `*.northeasternsga.com`. **SGAuth is built on Neon serverless Postgres and does not use Supabase for any purpose.** SGAuth is the sole source of truth for credentials; no product keeps its own password store.

The companion files are `SGAuth-tickets.md` (readable ticket set) and `out/linear-import-*.csv` (one Linear CSV per team).

---

## 1. Decisions and rationale

| Area | Decision | Rationale |
|---|---|---|
| Repo | In-place migration of the existing `auth` repo: strip Supabase, add Neon + Better Auth; close or rebase the open Supabase branches | Keeps CI, shadcn, Prisma 7 setup, and Linear history; the existing code is a thin scaffold with no auth logic worth preserving |
| Database | Neon serverless Postgres: `main` (prod), `dev` (shared), `test` (CI), per-PR preview branches via the Neon–Vercel integration; pooled URL at runtime, direct URL for migrations. **Free plan, scale-to-zero, quota monitored (accepted risk)** | Hard requirement; branching gives isolated previews without Docker. Free suspends compute when 100 CU-hours are used, which would take every product's login down; alerts at 50/70/85% and an upgrade runbook to Launch ($0.106/CU-hour) mitigate. Recommendation on record: upgrade before the Chambers cutover |
| Auth framework | Self-managed Better Auth 1.7.x with `@better-auth/prisma-adapter` | Aplio already uses it on Neon; provides cross-subdomain cookies, JWT/JWKS plugin, two-factor, admin plugin, session APIs. Neon's Managed Better Auth is beta and pins an older version; hand-rolled auth is unjustified for a small team |
| Hosting | Vercel (Node runtime), `auth.northeasternsga.com` for production, `auth-dev.northeasternsga.com` for the dev deployment (DEV banner, synthetic users, separate secrets). **No Vercel cron**: scheduled jobs run from GitHub Actions calling secret-protected routes | Matches Aplio and Chambers; Neon integration; custom domains. Vercel Hobby limits cron to daily, so the scheduler is plan-independent |
| Login method | Email + password (12+ chars, no composition rules, no breached-password check), scrypt hashing; self-sign-up restricted to `@northeastern.edu` with verification (every student has one; no exceptions); admins can create/invite any address; a later sign-up overwrites an unverified account (pre-hijack defense); every emailed link consumes its token on POST (Microsoft Safe Links) | Resend free tier is nearly exhausted org-wide, so passwordless OTP would be fragile; passwords make SGAuth the credential store the requirement demands. Email OTP is a deferred backlog item |
| Northeastern SSO | Not a launch dependency; Phase 5 spike | Registering an app in Northeastern's Entra ID tenant needs ITS approval; a multi-tenant app in an SGA tenant may require Northeastern admin consent. Unknown timeline |
| Passkeys | Optional per-user sign-in method (Better Auth passkey plugin), Phase 4; password stays as fallback; does not satisfy the admin TOTP requirement in v1 | Suggested by Benedikt: no email cost, phishing-resistant, preferred by some users |
| SSO mechanism | Parent-domain cookie `Domain=northeasternsga.com`, `__Secure-` prefix, HttpOnly, Secure, SameSite=Lax, no cookie cache | Simplest true single session; logout is instant everywhere. `__Host-` is impossible with a Domain attribute. Any compromised subdomain can read the cookie, so subdomain hygiene is a security control |
| Session lookup | Products call `GET /api/sgauth/session` server-side with the forwarded cookie (SDK caches 60 s, serves a stale cached session for up to 5 min if SGAuth is unreachable); the Next.js proxy only checks cookie presence; Supabase products additionally mint a 10-minute ES256 JWT from `/api/auth/token` | DB-backed lookup keeps revocation and position changes immediate; stale-if-error keeps a SGAuth blip from logging every product out; JWTs only where Supabase needs a bearer token |
| Session lifetime | 30-day sliding (`updateAge` 1 day), 90-day absolute cap enforced by a daily purge on `createdAt` (so Better Auth's own endpoints cannot bypass it), 10-minute re-auth window via `lastReauthAt` (Better Auth `freshAge` left at default) | Matches semester usage while bounding stolen-cookie exposure |
| Logout | Global: any sign-out clears the shared cookie and deletes the session row; "sign out everywhere" for users; admin revoke; `/logout?redirect=` validated against the registry | One session means one logout |
| Supabase products | Supabase **third-party auth** (JWT trust) is the standard path; server-side JWT verification documented as a fallback; moving to Neon recommended where possible | See §2 |
| Identity key | Products store the SGAuth user id (UUID v7) as their foreign key; email/name come from the session | Stable across email changes; Supabase `auth.uid()` requires a UUID `sub` |
| Admin rules | Enforced in a pure `authz.ts` module, mirrored by Postgres constraints/triggers, and audited. Admins grant/revoke admin for others only; never self; never the Primary Admin | Server-side enforcement with a DB backstop; UI only hides controls |
| Primary Admin | Exactly one (partial unique index). Transfer: PA re-auth + typed recipient email → recipient (active admin with MFA) accepts with re-auth → 24-hour cooling window with an emailed cancel link → scheduled execution revokes both parties' sessions and emails all admins. PA cannot be deleted, deactivated, or de-admined; lockout applies but self-unlock by email exists | Protects the most powerful account against both mistakes and hijacking while still allowing graduation handoffs |
| Break-glass | Offline script run with production Neon credentials, confirmation phrase, `BREAK_GLASS` audit row, emails to all admins; no HTTP path; runbook with at least two credential holders | Infra access is the real control; no web backdoor |
| Positions | Flat list; immutable slug `key` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, 2–64) plus editable display `name` and optional `category`; max 50 per user; rename keeps holders; delete is soft with typed confirmation, keeps history, retires the key for 365 days | Products check keys so renames never break permissions; retirement prevents accidental privilege revival |
| Propagation | Immediate for Neon products (live DB read); ≤10 minutes for Supabase JWTs; "force re-login" admin action | Bounded staleness without forcing logouts on every change |
| Seed data | Curated SGA position list supplied by SGA on 2026-09-18: 81 offices in 9 categories plus `senator`; keys slugified from official names; product roles (`<product>-<role>`) created on demand by product owners, not seeded | Explicit choice over inferring from Chambers roles |
| User removal | Admin deactivate (soft, sessions revoked instantly, reactivatable); **tombstone** (status DELETED, PII scrubbed, id kept) 30 days after deactivation or on request; inactive 12 months → notice → tombstone (admins exempt for manual review); audit PII anonymized, events kept | Meets the retention policy without losing the audit trail or orphaning product rows keyed by SGAuth user id |
| Profile data | `name`, optional `preferredName`, `email`; no NUID, phone, pronouns, photo | Data minimization; products keep their own fields keyed by SGAuth id |
| User UI | Minimal account page: profile, positions (read-only), links to each product from the registry, sessions with revoke, sign out everywhere, password change, MFA enrollment | Users need a hub and self-service basics; nothing product-specific |
| Account creation | Admin-created or bulk CSV import as password-less accounts, plus `@northeastern.edu` self-sign-up with zero positions. Password-less accounts set a password lazily: entering the email on the login page sends a one-time set-password link; admins can still push an invite to one person | Avoids admin bottlenecks at turnover and avoids an import-day email blast; positions gate everything |
| Migration | Chambers: bcrypt hashes imported with a `bcrypt$` marker and lazily re-hashed to scrypt on first login (the `auth.users` export is Eli's manual action item, before the Supabase project is deleted). Aplio/SenatePath/SenatePortal: emails imported as password-less accounts, **no emails sent at import**, set-password on first sign-in; Aplio duplicates merge into the Chambers account; the few non-NU Aplio addresses are imported as `legacyEmail` and corrected by hand. Merge by lower-cased email | Chambers users keep their passwords; OTP users never had one; lazy set-password spreads email volume over time |
| MFA | TOTP + backup codes; optional for users, required for admins and the PA (enforced at admin-action time); required for the transfer recipient | No SMS/email cost; protects privileged accounts |
| Rate limiting | Upstash Redis sliding windows on sign-in, sign-up, reset, token, re-auth, and admin endpoints only (session endpoint excluded to stay within 500K commands/month); **fails open with an alert** on Upstash outage; Better Auth's DB limiter disabled | Team already runs Upstash (Chambers); a vendor outage must never become an org-wide login outage |
| Lockout | 5 failures/15 min → 15-minute lock, doubling to a 24-hour cap, never permanent; emailed unlock link (POST-consumed); applies to the PA; **known-device cookie exempts the owner's usual browser** so the lock cannot be used to deny admins service | Mitigates credential stuffing without permanent self-DoS or a lockout DoS lever |
| Email | **Separate Resend account** owned by an SGA shared mailbox, sending from `mail.northeasternsga.com`, provider-agnostic mailer interface, per-recipient and global caps | Resend's free quota is per account and Chambers sends almost all SGA email today, so only a separate account isolates SGAuth's small volume |
| Product registry | Admin-managed `Product` table (slug, name, base URL restricted to `https://*.northeasternsga.com`, visibility by positions); drives trusted origins, redirect allowlist, CORS, and account-page links | No deploy to add a product; one source for security allowlists |
| SDK | `@sgaoperations/sgauth` on **public npm** with trusted publishing: `getSession` (60 s cache, stale-if-error), cookie-presence proxy helper, position guards, URL builders, `getAccessToken` for Supabase | Five products, one place to fix bugs; GitHub Packages was rejected because it needs a personal token to install even public packages |
| Environments | Dev SGAuth on the real parent domain with a distinct cookie prefix; product previews on stable `<product>-dev.northeasternsga.com` branch domains; local `*.sga.localhost` hostnames; `*.vercel.app` previews cannot use SSO | A parent-domain cookie cannot reach `vercel.app` or bare `localhost`; the topology must be explicit |
| Observability | Append-only `AuditEvent` table with a typed catalog and coverage test; structured JSON logs; PostHog (funnel events without PII, error tracking); health endpoint + uptime monitor; threshold alerts; retention jobs | Audit is a product requirement; PostHog free tier chosen over Sentry |
| Tokens | ES256, **manual** JWKS rotation (annual or incident) with the new key pushed to each Supabase project via `custom_jwks` before signing switches, 7-day overlap, `kid` header, issuer `https://auth.northeasternsga.com`, audience `authenticated`, 10-minute TTL, claims `sub` (uuid), `email`, `name`, `role: "authenticated"`, `positions`, `is_admin` | ES256 is universally supported (Supabase, jose); automatic rotation would reject fresh tokens for up to 30 minutes until Supabase re-fetches keys |
| Security extras | Origin/Referer enforcement on all mutations (SameSite=Lax still sends the cookie on sibling-subdomain POSTs), security headers (HSTS without `includeSubDomains` until every subdomain is confirmed HTTPS), subdomain DNS hygiene policy, enumeration-resistant responses, secrets rotation runbook, Dependabot/CodeQL, STRIDE-lite threat model | Consequences of the shared-cookie design |
| Rollout | SGAuth MVP → VaultZ → Chambers (already a Neon product) → Aplio (hard cutover outside an application window) → SenatePath (migrated to Neon by its owner) → Attendance Manager (Supabase or Neon path pending their decision) | VaultZ has no auth to unwind and proves the SDK; Chambers has the most users and pre-imported credentials |
| Ticketing | Fibonacci estimates; one Linear CSV per team (AUTH, VaultZ, Aplio, SenatePath, Attendance Manager); Chambers has no Linear team so its items are a Markdown checklist; epics as Linear Projects with `epic:*` labels and Epic/Phase/Depends-on lines in every description | Linear's importer does not create projects or parent links |

## 2. Supabase compatibility findings

**Scopable, with one real limitation.**

**Path chosen: Supabase third-party auth (JWT trust).** Supabase's Management API endpoint `POST /v1/projects/{ref}/config/auth/third-party-auth` accepts a generic `oidc_issuer_url`, `jwks_url`, or inline `custom_jwks`, so a project can trust SGAuth-issued JWTs even though the dashboard advertises only Clerk, Firebase, Auth0, Cognito, and WorkOS. Requirements SGAuth meets: asymmetric signing (ES256), a `kid` header, a `role: "authenticated"` claim (maps the request to the `authenticated` Postgres role), a UUID `sub` (read by `auth.uid()`), and standard `iss`/`exp`. Positions ride in the token and are readable in RLS via `auth.jwt() -> 'positions'`. supabase-js takes an `accessToken` callback; the SDK supplies it.

**Limitations to plan around:**
1. Third-party users have **no `auth.users` row**. Foreign keys, triggers, or joins on `auth.users` break. Chambers had these (now moot, since Chambers is a Neon product); Attendance Manager has a `supabaseAuthId` column that must become `sgauthUserId`.
2. Supabase Auth features are unavailable to these users: no Supabase sessions/refresh, password reset, or MFA. All of that is SGAuth's job, by design.
3. JWT staleness of up to 10 minutes for position changes and revocations; "force re-login" in SGAuth bounds it. Supabase refreshes JWKS within ~30 minutes, so SGAuth keeps rotated keys valid for 7 days.
4. Billing: $0.00325 per third-party monthly active user beyond plan quota. Negligible at SGA scale.
5. Generic-issuer configuration is an API operation, not a dashboard toggle; the guide ships a script.

**Alternatives evaluated and rejected as the default:**
- *Supabase custom OIDC provider* (Supabase Auth as a relying party to SGAuth acting as an OpenID provider via Better Auth's OAuth 2.1 provider package). Keeps `auth.users` but creates a second session SGAuth cannot terminate, positions must be copied into `app_metadata` by a hook, and free projects are capped at three custom providers. Documented as an escape hatch only.
- *Server-side verification only* (verify SGAuth JWTs with `jose`, use the service-role key). Works everywhere but loses per-user RLS. Documented as a fallback for products that do not need RLS.

**Product-by-product:** Website Creation has no user login today and will be hosted on Neon if it ever needs auth. SenatePath is migrated to Neon by its owner. Attendance Manager gets both paths ticketed; exactly one proceeds after the team's decision.

## 3. Open inputs and flagged risks

- ~~Curated position list~~ Received 2026-09-18: 82 positions (81 offices plus `senator`) in `prisma/seed/positions.json`; product-specific roles are created by product owners in the admin UI.
- **Attendance Manager directive** (Supabase vs Neon) selects ATTENDANCE-M02 or M03.
- **Chambers `auth.users` export** (Eli, manual) must happen before that Supabase project is deleted, or every Chambers user resets their password.
- **Neon Free quota** is an accepted risk with monitoring; the recorded recommendation is to upgrade to Launch before the Chambers cutover.
- **Cookie tossing from any subdomain** (login CSRF) is inherent to the parent-domain cookie; DNS hygiene and the Phase 1 cookie spike are the controls.
- **HSTS at the apex** with `includeSubDomains` would affect every product; enabled only after all subdomains are confirmed HTTPS-only.
- **Northeastern SSO** remains a spike; do not plan around it.
- **Resend volume**: SGAuth's dedicated domain isolates it, but org-wide totals should be watched; the mailer has caps and an 80% alert.

Full red-team findings, dispositions, and accepted risks: `SGAuth-red-team.md`.

## 4. Ticket set overview

138 tickets across six teams (five with Linear CSVs): AUTH 103 tickets in 13 epics; VaultZ 8; Chambers 9 (checklist only); Aplio 8; SenatePath 4; Attendance Manager 6. Point totals are in the ticket-set header. Phases: 0 Foundation → 1 Core auth, sessions, SSO (MVP) → 2 Admin, Primary Admin, positions, UI, SDK, VaultZ → 3 Hardening, observability, Chambers → 4 Aplio, SenatePath, Attendance, retention → 5 Backlog/spikes. Every ticket has title, description, acceptance criteria, priority, Fibonacci estimate, labels, dependencies, and its parent epic.

**Linear CSV format (verified against Linear's own importer source):** headers `Title, Description, Priority, Estimate, Status, Labels`; priority as the words Urgent/High/Medium/Low; estimate as an integer; labels separated by ", "; descriptions in Markdown. Parent issues and projects are not importable via CSV, so each description begins with its Ticket id, Epic, Phase, and Depends-on lines, and each ticket carries an `epic:*` label for bulk assignment into projects after import.

## 5. Sources relied on

- Supabase third-party auth overview: https://supabase.com/docs/guides/auth/third-party/overview
- Supabase third-party auth with Clerk (required `role` claim, `accessToken` callback): https://supabase.com/docs/guides/auth/third-party/clerk
- Supabase Management API, create third-party auth integration (`oidc_issuer_url`, `jwks_url`, `custom_jwks`): https://supabase.com/docs/reference/api/v1-create-project-tpa-integration
- Supabase custom OAuth/OIDC providers: https://supabase.com/docs/guides/auth/custom-oauth-providers
- Supabase row level security (`auth.uid()`, `auth.jwt()`, roles, performance): https://supabase.com/docs/guides/database/postgres/row-level-security
- Better Auth JWT plugin (algorithms, JWKS, rotation, `definePayload`): https://better-auth.com/docs/plugins/jwt
- Better Auth cookies (cross-subdomain cookies, prefixes): https://better-auth.com/docs/concepts/cookies
- Better Auth session management (expiry, freshness, revocation, customSession): https://better-auth.com/docs/concepts/session-management
- Better Auth admin plugin: https://better-auth.com/docs/plugins/admin
- Better Auth OAuth 2.1 provider (evaluated alternative): https://better-auth.com/docs/plugins/oauth-provider
- Better Auth releases and Prisma adapter versions: https://github.com/better-auth/better-auth/releases, https://www.npmjs.com/package/@better-auth/prisma-adapter
- Neon with Prisma ORM (pooled vs direct, driver adapters): https://neon.com/docs/guides/prisma
- Neon plans and free-tier limits: https://neon.com/docs/introduction/plans, https://neon.com/faqs/free-plan-limits-and-quotas
- Neon Managed Better Auth (evaluated, not chosen): https://neon.com/docs/auth/overview
- Connecting to Neon from Vercel: https://neon.com/docs/guides/vercel-connection-methods
- Linear CSV importer source (columns, priority words, label splitting): https://github.com/linear/linear/tree/master/packages/import
- Linear export columns: https://linear.app/docs/exporting-data
- MDN Set-Cookie (Domain, `__Secure-`/`__Host-`, SameSite): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- Northeastern 1Login/SSO and Duo MFA: https://1login.its.northeastern.edu, https://security.its.northeastern.edu/mfa/
- Upstash rate limiting for Next.js: https://upstash.com/blog/edge-rate-limiting
- FERPA directory information: https://studentprivacy.ed.gov/content/directory-information
- Repos inspected: SGAOperations/auth, vaultz, chambers, aplio, website-development, senate-path, attendance-manager (package.json, auth modules, Prisma schemas, migrations).
