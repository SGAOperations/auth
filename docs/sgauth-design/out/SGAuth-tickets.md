# SGAuth ticket set

Generated from `tickets-auth.mjs` and `tickets-products.mjs`. 138 tickets across 6 teams (5 with Linear CSVs; Chambers has no Linear team and is a checklist only). CSVs in `out/` use Linear's importer columns (Title, Description, Priority, Estimate, Status, Labels); each ticket's description carries its epic, phase, and dependencies because the importer does not create projects or parent links. Red-team revisions are folded in; see `SGAuth-red-team.md`.

**Manual action item (not a ticket):** Eli exports the Chambers Supabase `auth.users` table (with `encrypted_password`) joined to `public.users` before that Supabase project is deleted, and stores the file in the team secrets vault. AUTH-T86 validates the file; AUTH-T87 imports it.

## Import instructions

1. In Linear, create the projects listed under **Epics** below (one per epic) in the AUTH team, and one "SGAuth integration" project in each product team.
2. Settings → Import/Export → Import → CSV. Import `linear-import-AUTH.csv` into team AUTH; import each product file into that product's team. Map columns as-is (headers match Linear's expected names).
3. After import, filter by label `epic:*` and bulk-move issues into the matching project. Dependencies are written as text (`Depends on: AUTH-T03 (...)`); add "blocked by" relations while triaging.
4. Estimates are Fibonacci points (1/2/3/5/8). Set each team's estimate scale to Fibonacci before importing so values map cleanly.

## Phases

- **Phase 0 — Foundation**
- **Phase 1 — Core auth, sessions, SSO (MVP)**
- **Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ**
- **Phase 3 — Hardening, observability, Chambers**
- **Phase 4 — Aplio, SenatePath, Attendance Manager, retention**
- **Phase 5 — Backlog / spikes**

## Epics (Linear Projects)

### Team AUTH

- **E1 Foundation & Neon Migration** (label `epic:foundation`, 10 tickets, 23 points): Replace the Supabase foundation with Neon serverless Postgres, Better Auth, Vercel hosting, CI, and environment tooling. SGAuth MUST run on Neon and MUST NOT use Supabase for auth or data.
- **E2 Data Model & Migrations** (label `epic:data-model`, 7 tickets, 16 points): Prisma 7 schema on Neon: users, Better Auth tables, positions, admin/Primary Admin invariants, audit log, product registry, security tables, and the migration workflow.
- **E3 Authentication Core** (label `epic:auth-core`, 12 tickets, 29 points): Email + password authentication with Better Auth: sign-up restricted to northeastern.edu, verification, reset, invites, imported bcrypt hashes, and the login UI.
- **E4 Sessions & SSO** (label `epic:sessions`, 10 tickets, 24 points): One session across *.northeasternsga.com via a parent-domain cookie, the session endpoint products call, ES256 JWTs + JWKS for Supabase products, logout propagation, redirects, re-authentication, and the non-production topology.
- **E5 Admin & Primary Admin** (label `epic:admin`, 7 tickets, 23 points): Server-enforced admin rules, the single transferable Primary Admin with a guarded transfer flow, break-glass recovery, and bulk user administration.
- **E6 Positions** (label `epic:positions`, 5 tickets, 11 points): Flat, admin-managed positions (stable key + display name) carried in every session; assignment, soft delete, retirement, propagation, and history.
- **E7 Admin UI & Account UI** (label `epic:ui`, 9 tickets, 27 points): Light admin UI (users, positions, products, audit, PA transfer) and a minimal account page for every user (profile, positions, product links, sessions, password, MFA).
- **E8 Product Registry & SDK** (label `epic:sdk`, 7 tickets, 17 points): Admin-managed product registry that drives trusted origins and redirects, and the published @sgaoperations/sgauth package products use to read sessions and tokens.
- **E9 Security Hardening** (label `epic:security`, 10 tickets, 26 points): Upstash rate limiting, escalating account lockout, CSRF and origin enforcement, headers, TOTP MFA (required for admins), subdomain hygiene, secrets, enumeration resistance, scanning, and a threat model.
- **E10 Observability & Audit** (label `epic:observability`, 6 tickets, 13 points): Append-only audit log with full coverage, structured logs, PostHog analytics and error tracking, health and uptime, alerts, and retention/deletion jobs.
- **E11 Integration Guides & Docs** (label `epic:docs`, 7 tickets, 18 points): Architecture doc (Neon mandate), Neon-product and Supabase-product integration guides, admin runbooks, privacy notice, SDK reference, contributor guide.
- **E12 User Migration & Rollout** (label `epic:rollout`, 7 tickets, 14 points): Export/import of existing product users (Chambers hashes, Aplio/SenatePath/Attendance emails), launch checklist, rollout comms, cutover and rollback plans.
- **E13 Testing & QA** (label `epic:testing`, 6 tickets, 20 points): Test harness on a Neon test branch, integration tests for every auth flow, authorization matrix, Playwright SSO end-to-end, JWT/JWKS conformance, and load sanity.

### Product teams

- **SGAuth integration — VaultZ** (team VaultZ, 8 tickets, 17 points, Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ): Replace the shared-passphrase gate with SGAuth sessions via the SDK. First product integrated; proves the SDK and the Neon-product guide.
- **SGAuth integration — Chambers** (team Chambers, 9 tickets, 26 points, Phase 3 — Hardening, observability, Chambers): Chambers has no Linear team; these items are a Markdown checklist only (no CSV). Chambers is a Neon product (migration completes before integration). Replace Supabase Auth, live-role checks, and session revocation with SGAuth sessions and positions; users and password hashes are imported into SGAuth. The auth.users export is Eli's manual action item, not a ticket.
- **SGAuth integration — Aplio** (team Aplio, 8 tickets, 23 points, Phase 4 — Aplio, SenatePath, Attendance Manager, retention): Hard cutover from Aplio's local Better Auth (email OTP) to SGAuth via the SDK; users pre-imported and invited to set passwords.
- **SGAuth integration — SenatePath** (team SenatePath, 4 tickets, 12 points, Phase 4 — Aplio, SenatePath, Attendance Manager, retention): Migrate SenatePath's database from Supabase to Neon and gate the admin area with SGAuth positions.
- **SGAuth integration — Attendance Manager** (team Attendance Manager, 6 tickets, 17 points, Phase 4 — Aplio, SenatePath, Attendance Manager, retention): Decision pending from the team: either stay on Supabase and consume SGAuth via third-party auth (JWT trust), or move to Neon and use the SDK. Both paths are ticketed; only one will be executed.

## Summary table

| ID | Title | Team | Phase | Priority | Est. | Depends on |
|---|---|---|---|---|---|---|
| AUTH-T01 | Provision the Neon project, branches, and roles for SGAuth | AUTH | 0 | Urgent | 2 | — |
| AUTH-T02 | Remove Supabase from the auth repo (in-place migration to Neon) | AUTH | 0 | Urgent | 3 | — |
| AUTH-T03 | Install Better Auth 1.7 with the Prisma adapter and mount the handler | AUTH | 0 | Urgent | 3 | AUTH-T02, AUTH-T04 |
| AUTH-T04 | Configure Prisma 7 for Neon (pooled runtime, direct migrations) | AUTH | 0 | High | 2 | AUTH-T01 |
| AUTH-T05 | Create the Vercel project, custom domains, environments, and Neon preview branching | AUTH | 0 | High | 3 | AUTH-T01, AUTH-T03 |
| AUTH-T06 | Update CI: typecheck, lint, format, migrations check, and tests on a Neon test branch | AUTH | 0 | High | 3 | AUTH-T03, AUTH-T93 |
| AUTH-T07 | Validate environment variables at startup with zod | AUTH | 0 | Medium | 1 | AUTH-T02 |
| AUTH-T08 | Rewrite README and developer bootstrap for Neon branches | AUTH | 0 | Medium | 2 | AUTH-T10, AUTH-T44 |
| AUTH-T09 | Automate Neon branch hygiene to stay under plan limits | AUTH | 0 | Medium | 2 | AUTH-T05 |
| AUTH-T10 | Core schema: User plus Better Auth Session, Account, and Verification tables | AUTH | 0 | High | 3 | AUTH-T03, AUTH-T04 |
| AUTH-T11 | Positions schema: Position, UserPosition, and retired keys | AUTH | 1 | High | 3 | AUTH-T10 |
| AUTH-T12 | Primary Admin invariants at the database level and the PrimaryAdminTransfer table | AUTH | 1 | High | 3 | AUTH-T10 |
| AUTH-T13 | Append-only AuditEvent table | AUTH | 1 | High | 2 | AUTH-T10 |
| AUTH-T14 | Product registry schema | AUTH | 2 | Medium | 2 | AUTH-T10 |
| AUTH-T15 | Security tables: AccountLock, UnlockToken, Jwks, TwoFactor | AUTH | 1 | Medium | 2 | AUTH-T10 |
| AUTH-T16 | Migration workflow: deploy in build, never migrate dev against production | AUTH | 0 | Medium | 1 | AUTH-T04, AUTH-T05 |
| AUTH-T17 | Email + password sign-in and self-sign-up restricted to northeastern.edu | AUTH | 1 | Urgent | 3 | AUTH-T03, AUTH-T10 |
| AUTH-T18 | Email verification for self-sign-up with resend limits | AUTH | 1 | High | 2 | AUTH-T17, AUTH-T20, AUTH-T103 |
| AUTH-T19 | Password reset flow | AUTH | 1 | High | 3 | AUTH-T17, AUTH-T20, AUTH-T103 |
| AUTH-T20 | Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps | AUTH | 1 | High | 3 | AUTH-T07 |
| AUTH-T21 | Accept imported Chambers bcrypt hashes with lazy re-hash to scrypt | AUTH | 3 | High | 2 | AUTH-T17 |
| AUTH-T22 | Invite flow: admin-created users receive a set-password link | AUTH | 2 | Medium | 2 | AUTH-T20, AUTH-T17, AUTH-T103 |
| AUTH-T23 | Change password (current password + re-auth), revoke other sessions | AUTH | 2 | Medium | 2 | AUTH-T17, AUTH-T32 |
| AUTH-T24 | Admin-initiated email change with re-verification and privilege rules | AUTH | 3 | Low | 2 | AUTH-T36, AUTH-T20 |
| AUTH-T25 | Login, sign-up, forgot/reset, and verify pages | AUTH | 1 | High | 3 | AUTH-T17, AUTH-T18, AUTH-T19, AUTH-T31 |
| AUTH-T26 | Parent-domain session cookie for *.northeasternsga.com | AUTH | 1 | Urgent | 2 | AUTH-T03 |
| AUTH-T27 | Session lifetime: 30-day sliding, 90-day absolute cap, no cookie cache | AUTH | 1 | High | 2 | AUTH-T10, AUTH-T26 |
| AUTH-T28 | Session endpoint for products: user, email, positions, admin flags | AUTH | 1 | Urgent | 3 | AUTH-T27, AUTH-T11 |
| AUTH-T29 | ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products | AUTH | 2 | High | 3 | AUTH-T28, AUTH-T15 |
| AUTH-T30 | Global logout, sign out everywhere, and admin revocation | AUTH | 1 | High | 2 | AUTH-T26, AUTH-T56 |
| AUTH-T31 | Safe post-login redirects validated against the product registry | AUTH | 1 | High | 2 | AUTH-T56 |
| AUTH-T32 | Re-authentication (sudo mode) for sensitive actions | AUTH | 2 | High | 3 | AUTH-T27, AUTH-T67 |
| AUTH-T33 | List and revoke the user's own sessions | AUTH | 2 | Medium | 2 | AUTH-T27 |
| AUTH-T34 | Non-production SSO topology: dev deployment, local hostnames, product preview domains | AUTH | 1 | High | 3 | AUTH-T05, AUTH-T26 |
| AUTH-T35 | Authorization module with the admin/Primary Admin rule matrix | AUTH | 2 | Urgent | 3 | AUTH-T10, AUTH-T12 |
| AUTH-T36 | Admin user-management endpoints | AUTH | 2 | High | 5 | AUTH-T35, AUTH-T13, AUTH-T32, AUTH-T22 |
| AUTH-T37 | Primary Admin transfer flow (re-auth, recipient acceptance, 24-hour cancel window) | AUTH | 2 | High | 5 | AUTH-T12, AUTH-T35, AUTH-T32, AUTH-T20, AUTH-T67, AUTH-T103, AUTH-T38 |
| AUTH-T38 | Scheduled-job runner: GitHub Actions schedules calling secret-protected routes | AUTH | 1 | High | 2 | AUTH-T05, AUTH-T07 |
| AUTH-T39 | Break-glass Primary Admin recovery script and runbook | AUTH | 2 | High | 3 | AUTH-T12, AUTH-T13 |
| AUTH-T40 | Primary Admin protection tests across API and database layers | AUTH | 2 | High | 2 | AUTH-T12, AUTH-T36 |
| AUTH-T41 | Bulk user import (CSV) with position assignment and batched invites | AUTH | 2 | Medium | 3 | AUTH-T36, AUTH-T43 |
| AUTH-T42 | Positions CRUD: create, edit name/category, soft delete with retirement | AUTH | 2 | High | 3 | AUTH-T11, AUTH-T35, AUTH-T13 |
| AUTH-T43 | Position assignment endpoints (assign, unassign, bulk) | AUTH | 2 | High | 3 | AUTH-T42 |
| AUTH-T44 | Seed the curated SGA position list | AUTH | 1 | Medium | 1 | AUTH-T11 |
| AUTH-T45 | Position propagation tests and forced re-login | AUTH | 2 | Medium | 2 | AUTH-T43, AUTH-T28, AUTH-T29 |
| AUTH-T46 | Position history queries | AUTH | 3 | Low | 2 | AUTH-T42, AUTH-T73 |
| AUTH-T47 | App shell, navigation, and route guards for /admin and /account | AUTH | 2 | High | 3 | AUTH-T25, AUTH-T28 |
| AUTH-T48 | Admin: users list and user detail pages | AUTH | 2 | High | 5 | AUTH-T47, AUTH-T36, AUTH-T43 |
| AUTH-T49 | Admin: positions pages | AUTH | 2 | High | 3 | AUTH-T47, AUTH-T42 |
| AUTH-T50 | Admin: product registry pages | AUTH | 2 | Medium | 2 | AUTH-T47, AUTH-T56 |
| AUTH-T51 | Admin: audit log viewer with filters and CSV export | AUTH | 3 | Medium | 3 | AUTH-T47, AUTH-T73 |
| AUTH-T52 | Admin: Primary Admin transfer wizard, status, acceptance, and cancel pages | AUTH | 2 | High | 3 | AUTH-T47, AUTH-T37 |
| AUTH-T53 | Account page: profile, positions, product links, sessions, sign out everywhere | AUTH | 2 | High | 3 | AUTH-T47, AUTH-T33, AUTH-T56 |
| AUTH-T54 | Account security page: change password, MFA enrollment, backup codes | AUTH | 3 | High | 3 | AUTH-T23, AUTH-T67 |
| AUTH-T55 | Accessibility, responsive, and empty/error state pass | AUTH | 3 | Medium | 2 | AUTH-T48, AUTH-T49, AUTH-T53, AUTH-T54 |
| AUTH-T56 | Product registry service: trusted origins and redirect allowlist at runtime | AUTH | 1 | High | 2 | AUTH-T14 |
| AUTH-T57 | Scaffold the @sgaoperations/sgauth package and publish pipeline (public npm) | AUTH | 2 | High | 3 | AUTH-T28 |
| AUTH-T58 | SDK: getSession() with cookie forwarding and a 60-second cache | AUTH | 2 | High | 3 | AUTH-T57 |
| AUTH-T59 | SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs) | AUTH | 2 | High | 3 | AUTH-T58 |
| AUTH-T60 | SDK: getAccessToken() for Supabase clients | AUTH | 3 | Medium | 2 | AUTH-T58, AUTH-T29 |
| AUTH-T61 | SDK documentation, example app, and versioning policy | AUTH | 2 | Medium | 2 | AUTH-T59 |
| AUTH-T62 | CORS for browser-side calls from registered products | AUTH | 3 | Medium | 2 | AUTH-T56, AUTH-T28 |
| AUTH-T63 | Upstash Redis rate limiting on auth and token endpoints | AUTH | 1 | High | 3 | AUTH-T03, AUTH-T07 |
| AUTH-T64 | Escalating account lockout with emailed unlock and known-device exemption | AUTH | 1 | High | 5 | AUTH-T15, AUTH-T17, AUTH-T20, AUTH-T103 |
| AUTH-T65 | CSRF and origin enforcement across subdomains | AUTH | 1 | High | 2 | AUTH-T56, AUTH-T26 |
| AUTH-T66 | Security headers (CSP, HSTS, frame, referrer) | AUTH | 2 | Medium | 2 | AUTH-T05 |
| AUTH-T67 | TOTP multi-factor authentication (optional for users, required for admins and the Primary Admin) | AUTH | 2 | High | 5 | AUTH-T15, AUTH-T17 |
| AUTH-T68 | Subdomain hygiene: DNS inventory, dangling-record removal, and policy | AUTH | 2 | Medium | 2 | AUTH-T26 |
| AUTH-T69 | Secrets management and rotation procedures | AUTH | 2 | Medium | 1 | AUTH-T05, AUTH-T29 |
| AUTH-T70 | Account-enumeration resistance and timing uniformity | AUTH | 1 | Medium | 2 | AUTH-T17, AUTH-T19 |
| AUTH-T71 | Dependency and code scanning | AUTH | 3 | Low | 1 | AUTH-T06 |
| AUTH-T72 | Threat model and pre-launch security review checklist | AUTH | 2 | Medium | 3 | AUTH-T26, AUTH-T29, AUTH-T35 |
| AUTH-T73 | Audit event catalog, emitter, and coverage test | AUTH | 1 | High | 3 | AUTH-T13 |
| AUTH-T74 | Structured JSON logging with request IDs and redaction | AUTH | 1 | High | 2 | AUTH-T03 |
| AUTH-T75 | PostHog: server-side auth funnel events and error tracking | AUTH | 2 | Medium | 2 | AUTH-T74 |
| AUTH-T76 | Health endpoint and uptime monitor | AUTH | 1 | Medium | 1 | AUTH-T04, AUTH-T29 |
| AUTH-T77 | Threshold alerts for security events | AUTH | 3 | Low | 2 | AUTH-T73, AUTH-T20, AUTH-T38 |
| AUTH-T78 | Retention jobs: tombstone deactivated (30 d) and inactive (12 mo) users, purge sessions and PII | AUTH | 3 | Medium | 3 | AUTH-T13, AUTH-T36, AUTH-T20, AUTH-T38 |
| AUTH-T79 | ARCHITECTURE.md: Neon mandate, components, session and token flows | AUTH | 1 | High | 3 | AUTH-T26, AUTH-T28, AUTH-T29 |
| AUTH-T80 | Integration guide for Neon-based products (Next.js) | AUTH | 2 | High | 3 | AUTH-T61, AUTH-T34 |
| AUTH-T81 | Integration guide for Supabase-backed products (third-party auth) plus the move-to-Neon alternative | AUTH | 3 | High | 5 | AUTH-T29, AUTH-T60 |
| AUTH-T82 | Admin runbooks | AUTH | 2 | Medium | 3 | AUTH-T37, AUTH-T39, AUTH-T64, AUTH-T41 |
| AUTH-T83 | Privacy notice and data-handling document | AUTH | 3 | Medium | 2 | AUTH-T78 |
| AUTH-T84 | Generated SDK API reference and changelog discipline | AUTH | 3 | Low | 1 | AUTH-T61 |
| AUTH-T85 | CLAUDE.md and CONTRIBUTING.md for agents and humans | AUTH | 1 | Low | 1 | AUTH-T02, AUTH-T06 |
| AUTH-T86 | Receive the Chambers auth.users export and define the import file format | AUTH | 3 | High | 2 | — |
| AUTH-T87 | Import script: Chambers users with bcrypt hashes and position mapping | AUTH | 3 | High | 3 | AUTH-T86, AUTH-T21, AUTH-T44, AUTH-T13 |
| AUTH-T88 | Aplio user import (emails and names, no passwords) with invites and id mapping | AUTH | 4 | High | 2 | AUTH-T87, AUTH-T22 |
| AUTH-T89 | SenatePath and Attendance Manager user import | AUTH | 4 | Medium | 2 | AUTH-T88 |
| AUTH-T90 | Rollout plan and user communications | AUTH | 3 | Medium | 2 | AUTH-T80, AUTH-T87 |
| AUTH-T91 | Production launch checklist and Primary Admin bootstrap | AUTH | 2 | High | 2 | AUTH-T72, AUTH-T66, AUTH-T76, AUTH-T39, AUTH-T64 |
| AUTH-T92 | Post-launch review and legacy cleanup tracking | AUTH | 4 | Low | 1 | AUTH-T90 |
| AUTH-T93 | Test harness: vitest, Neon test branch, factories, and test mailer | AUTH | 0 | High | 3 | AUTH-T01, AUTH-T04 |
| AUTH-T94 | Integration tests for authentication flows | AUTH | 1 | High | 5 | AUTH-T93, AUTH-T17, AUTH-T18, AUTH-T19, AUTH-T27, AUTH-T64 |
| AUTH-T95 | Authorization, admin, positions, and transfer integration tests | AUTH | 2 | High | 3 | AUTH-T93, AUTH-T36, AUTH-T37, AUTH-T42, AUTH-T43 |
| AUTH-T96 | Playwright end-to-end SSO test across subdomains | AUTH | 2 | High | 5 | AUTH-T34, AUTH-T59, AUTH-T30 |
| AUTH-T97 | JWT and JWKS conformance tests for Supabase requirements | AUTH | 2 | Medium | 2 | AUTH-T29 |
| AUTH-T98 | Load sanity for the session endpoint on Neon | AUTH | 3 | Low | 2 | AUTH-T28, AUTH-T05 |
| AUTH-T99 | Spike: Northeastern Microsoft Entra ID sign-in feasibility | AUTH | 5 | Low | 3 | AUTH-T91 |
| AUTH-T100 | Backlog: optional email OTP login (deferred due to email volume) | AUTH | 5 | Low | 2 | AUTH-T91 |
| AUTH-T101 | Neon Free-plan quota monitoring, alerts, and upgrade runbook | AUTH | 0 | High | 2 | AUTH-T01 |
| AUTH-T103 | Scanner-safe email links: land on a page, consume the token on POST | AUTH | 1 | Urgent | 2 | AUTH-T20 |
| AUTH-T104 | Spike: validate cross-subdomain cookies, prefixes, and local hostnames on the real domain before building on them | AUTH | 1 | Urgent | 2 | AUTH-T05, AUTH-T26 |
| VAULTZ-V01 | Install @sgaoperations/sgauth and protect all routes with the SGAuth proxy | VAULTZ | 2 | High | 3 | AUTH-T59, AUTH-T80, AUTH-T34 |
| VAULTZ-V02 | Remove the shared passphrase gate | VAULTZ | 2 | High | 2 | VAULTZ-V01 |
| VAULTZ-V03 | Link VaultZ purchaser records to SGAuth user ids | VAULTZ | 2 | Medium | 3 | VAULTZ-V01 |
| VAULTZ-V04 | Position-based permissions map for VaultZ | VAULTZ | 2 | High | 3 | VAULTZ-V01, AUTH-T44 |
| VAULTZ-V05 | Account and sign-out links in the VaultZ header | VAULTZ | 2 | Low | 1 | VAULTZ-V01 |
| VAULTZ-V06 | Dev and preview topology for VaultZ | VAULTZ | 2 | Medium | 2 | VAULTZ-V01, AUTH-T34 |
| VAULTZ-V07 | VaultZ cutover checklist and rollback | VAULTZ | 2 | Medium | 1 | VAULTZ-V02, VAULTZ-V04, AUTH-T91 |
| VAULTZ-V08 | Tests for SGAuth guards and permissions in VaultZ | VAULTZ | 2 | Medium | 2 | VAULTZ-V04 |
| CHAMBERS-C01 | Inventory every auth and authorization touchpoint in Chambers | CHAMBERS | 3 | High | 3 | — |
| CHAMBERS-C02 | Replace Supabase Auth with the SGAuth SDK (proxy, session helpers, login removal) | CHAMBERS | 3 | High | 5 | CHAMBERS-C01, AUTH-T59, AUTH-T80 |
| CHAMBERS-C03 | Key Chambers users by SGAuth user id | CHAMBERS | 3 | High | 3 | CHAMBERS-C02, AUTH-T87 |
| CHAMBERS-C04 | Map admin_role / iems_role to SGAuth positions; keep body memberships internal | CHAMBERS | 3 | High | 5 | CHAMBERS-C02, AUTH-T44 |
| CHAMBERS-C05 | Remove live-role-check and session-revocation mechanisms | CHAMBERS | 3 | Medium | 3 | CHAMBERS-C04 |
| CHAMBERS-C06 | Approve the Chambers role-to-position mapping file | CHAMBERS | 3 | High | 1 | — |
| CHAMBERS-C07 | Chambers cutover, comms, and rollback plan | CHAMBERS | 3 | High | 2 | CHAMBERS-C03, CHAMBERS-C04, CHAMBERS-C05, AUTH-T91 |
| CHAMBERS-C08 | Verify kiosk display key, Slack reminders, and cron routes are unaffected | CHAMBERS | 3 | Low | 1 | CHAMBERS-C02 |
| CHAMBERS-C09 | Tests for SGAuth-based authorization in Chambers | CHAMBERS | 3 | Medium | 3 | CHAMBERS-C04 |
| APLIO-P01 | Export Aplio users for the SGAuth import and receive the id mapping | APLIO | 4 | High | 2 | AUTH-T88 |
| APLIO-P02 | Replace local Better Auth with the SGAuth SDK | APLIO | 4 | High | 5 | APLIO-P01, AUTH-T59, AUTH-T80 |
| APLIO-P03 | Key Aplio users by SGAuth user id | APLIO | 4 | High | 5 | APLIO-P02 |
| APLIO-P04 | Derive Aplio admin from an SGAuth position; managers stay product-level | APLIO | 4 | High | 2 | APLIO-P02, AUTH-T44 |
| APLIO-P05 | Applicant flow on SGAuth accounts (northeastern.edu required) | APLIO | 4 | High | 3 | APLIO-P02 |
| APLIO-P06 | Local dev bypass and preview topology | APLIO | 4 | Low | 1 | APLIO-P02, AUTH-T34 |
| APLIO-P07 | Aplio hard cutover outside an application window | APLIO | 4 | High | 2 | APLIO-P03, APLIO-P04, APLIO-P05, AUTH-T91 |
| APLIO-P08 | Update Aplio tests for SDK-based auth | APLIO | 4 | Medium | 3 | APLIO-P04 |
| SENATEPATH-S01 | Migrate SenatePath's database from Supabase to Neon | SENATEPATH | 4 | High | 5 | — |
| SENATEPATH-S02 | Gate the SenatePath admin area with SGAuth positions | SENATEPATH | 4 | High | 3 | SENATEPATH-S01, AUTH-T59, AUTH-T80 |
| SENATEPATH-S03 | Import SenatePath admins into SGAuth and cut over | SENATEPATH | 4 | Medium | 2 | SENATEPATH-S02, AUTH-T89 |
| SENATEPATH-S04 | Tests for the SGAuth admin gate | SENATEPATH | 4 | Low | 2 | SENATEPATH-S02 |
| ATTENDANCE-M01 | Decision: stay on Supabase (third-party auth) or move to Neon (SDK) | ATTENDANCE | 4 | High | 1 | — |
| ATTENDANCE-M02 | (Supabase path) Consume SGAuth via Supabase third-party auth | ATTENDANCE | 4 | High | 5 | ATTENDANCE-M01, AUTH-T81, AUTH-T60 |
| ATTENDANCE-M03 | (Neon path) Migrate to Neon and integrate with the SDK | ATTENDANCE | 4 | High | 5 | ATTENDANCE-M01, AUTH-T59, AUTH-T80 |
| ATTENDANCE-M04 | Map roles to SGAuth positions; keep NUID product-side | ATTENDANCE | 4 | Medium | 2 | ATTENDANCE-M01, AUTH-T44 |
| ATTENDANCE-M05 | User import and cutover | ATTENDANCE | 4 | Medium | 2 | ATTENDANCE-M04, AUTH-T89 |
| ATTENDANCE-M06 | Update auth and middleware tests | ATTENDANCE | 4 | Low | 2 | ATTENDANCE-M04 |

---

# Team AUTH

## E1 Foundation & Neon Migration

### AUTH-T01 — Provision the Neon project, branches, and roles for SGAuth

**Priority:** Urgent · **Estimate:** 2 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, infra, neon  
**Depends on:** none

Create the production Neon project that SGAuth is built on. **SGAuth is built on Neon serverless Postgres and MUST NOT use Supabase in any form** (no Supabase Auth, no Supabase Postgres, no Supabase client libraries).

Set up:
- Project `sgauth` in the SGAOperations Neon org, region closest to Vercel's default (us-east-1 / iad1).
- Branches: `main` (production), `dev` (shared non-production deployment), `test` (CI integration tests). Preview branches are created automatically later (AUTH-T05).
- A least-privilege application role for runtime queries and a separate migration role for `prisma migrate deploy`.
- Record the pooled connection string (host contains `-pooler`) as `DATABASE_URL` and the direct string as `DIRECT_URL` in a secrets store (Vercel env + the team password manager). Use `sslmode=verify-full`.
- Enable point-in-time restore on `main` (Neon history retention) and note the restore procedure.

**Plan decision (red-team, accepted risk):** SGAuth launches on the Neon **Free** plan with scale-to-zero. Free suspends the compute for the rest of the month once 100 CU-hours are used, which would take every SGA product's login down; history/restore window is only 6 hours. AUTH-T101 adds quota monitoring and the upgrade runbook (Launch plan, pay-as-you-go at $0.106/CU-hour). Keep the SDK's 60-second cache so idle periods let the compute suspend.

Reference: Neon Prisma guide (pooled vs direct URLs), Neon free plan limits (10 branches/project, 100 CU-hours/project/month, 0.5 GB storage per project, 6-hour history).

**Acceptance criteria**
- [ ] Neon project exists with `main`, `dev`, and `test` branches; history retention set to the Free maximum on `main`.
- [ ] Two roles exist: runtime (no DDL) and migration (DDL); credentials stored in the team secrets store, not in git.
- [ ] `DATABASE_URL` (pooled) and `DIRECT_URL` (direct) connection strings are documented in `.env.example` with placeholder values and `sslmode=verify-full`.
- [ ] A short section in README states the Neon mandate and that Supabase is not used anywhere in SGAuth.

### AUTH-T02 — Remove Supabase from the auth repo (in-place migration to Neon)

**Priority:** Urgent · **Estimate:** 3 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, neon, chore  
**Depends on:** none

The current repo scaffolds Supabase auth and DB. Strip it entirely so the codebase reflects the Neon mandate.

Remove:
- Dependencies: `@supabase/ssr`, `@supabase/supabase-js`, `supabase` (CLI).
- `supabase/` directory (config.toml), `src/app/auth/callback/route.ts` (Supabase OTP callback), Supabase env vars from `.env.example`, and the Supabase steps in README.
- The `supabaseUserId` column and any Supabase-shaped assumptions in `prisma/schema.prisma` and `prisma/seed.ts` (the schema is replaced in AUTH-T10; this ticket only removes Supabase references so the repo builds).

Also triage open branches that build on Supabase (AUTH-7, AUTH-8, auth-9, auth-10, auth-11, AUTH-14): close them with a comment pointing at this design, or cherry-pick any UI-only work that is still useful. Do not merge Supabase code.

**Acceptance criteria**
- [ ] `grep -ri supabase` across the repo (excluding the design doc folder) returns nothing.
- [ ] `npm ci && npm run build && npm run lint && npm run format:check` pass with Supabase removed.
- [ ] README setup section no longer mentions Docker or `supabase start`; it points at Neon branches (final wording lands in AUTH-T08).
- [ ] Each open Supabase-based branch has a closing comment or a note in the PR explaining what was salvaged.

### AUTH-T03 — Install Better Auth 1.7 with the Prisma adapter and mount the handler

**Priority:** Urgent · **Estimate:** 3 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, backend, better-auth  
**Depends on:** AUTH-T02 (Remove Supabase from the auth repo (in-place migration to Neon)); AUTH-T04 (Configure Prisma 7 for Neon (pooled runtime, direct migrations))

Add self-managed Better Auth (latest 1.7.x) and `@better-auth/prisma-adapter` on Neon, mirroring the pattern Aplio already uses.

- `src/lib/auth/config.ts`: `betterAuth({ database: prismaAdapter(prisma, { provider: 'postgresql' }), baseURL, secret, trustedOrigins, advanced: { database: { generateId: false } }, plugins: [nextCookies()] })`. Prisma generates `uuid(7)` ids.
- `src/app/api/auth/[...all]/route.ts` mounting `toNextJsHandler(auth)`.
- `baseURL` = `https://auth.northeasternsga.com` in production, `https://auth-dev.northeasternsga.com` on the dev deployment, and a local dev hostname (AUTH-T34) locally. Never derive it from `VERCEL_URL` for cookies (the cookie domain must be the parent domain).
- `trustedOrigins` is temporarily a static list; AUTH-T56 replaces it with the product registry.
- Add `server-only` guards and the `auth.api` typed server helper.

Plugins (jwt, admin, twoFactor, customSession) are added in their own tickets.

**Acceptance criteria**
- [ ] `GET /api/auth/ok` (or equivalent Better Auth health route) returns 200 on the dev deployment.
- [ ] Better Auth's initialization-time schema validation passes against the Prisma client (1.7 rejects requests on mismatch).
- [ ] `BETTER_AUTH_SECRET` is required (32+ chars) and the app refuses to start without it.
- [ ] Unit test confirms `baseURL` resolution per environment and that `VERCEL_URL` is never used for the production cookie domain.

### AUTH-T04 — Configure Prisma 7 for Neon (pooled runtime, direct migrations)

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, backend, neon, prisma  
**Depends on:** AUTH-T01 (Provision the Neon project, branches, and roles for SGAuth)

Wire Prisma 7 to Neon following Neon's Prisma guide.

- `prisma.config.ts`: `datasource.url = env('DIRECT_URL')` (used by the CLI for migrations). No `url` in the schema datasource block (Prisma 7 rule).
- Runtime client (`src/lib/prisma.ts`): driver adapter with the **pooled** `DATABASE_URL`. Use `@prisma/adapter-pg` with a `pg.Pool` sized for Vercel functions (`max: 5`, `idleTimeoutMillis: 10_000`), or `@prisma/adapter-neon` if WebSocket transport is preferred; document the choice.
- Global singleton in dev to avoid pool exhaustion on HMR.
- Add `?sslmode=verify-full`. Verify whether `pgbouncer=true` is needed with Neon's pooler when using a driver adapter and document the result.

**Acceptance criteria**
- [ ] `npx prisma migrate deploy` runs against `DIRECT_URL`; runtime queries use the `-pooler` host (verified via Neon monitoring or `pg_stat_activity`).
- [ ] Cold start on Vercel executes a `SELECT 1` through the pooled connection in under 300 ms p50 (measured on the dev deployment).
- [ ] README documents why two URLs exist and which commands use which.

### AUTH-T05 — Create the Vercel project, custom domains, environments, and Neon preview branching

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, infra, vercel, neon  
**Depends on:** AUTH-T01 (Provision the Neon project, branches, and roles for SGAuth); AUTH-T03 (Install Better Auth 1.7 with the Prisma adapter and mount the handler)

Host SGAuth on Vercel (Node runtime, not Edge, because of Prisma).

- Vercel project `sgauth` linked to the repo; production branch `main` → `auth.northeasternsga.com`; a protected `dev` branch → `auth-dev.northeasternsga.com` (see AUTH-T34 for why a dev SGAuth deployment on the real parent domain is required for product previews).
- Install the Neon–Vercel integration so each preview deployment gets its own Neon branch (from `dev`) and `DATABASE_URL`/`DIRECT_URL` injected; enable automatic deletion of preview branches when the deployment is deleted (free plan allows 10 branches).
- Environment variables scoped per environment (production / preview / development). Secrets never shared across environments; `BETTER_AUTH_SECRET` differs per environment.
- Build command runs `prisma generate` and `prisma migrate deploy` (AUTH-T16) before `next build`.
- Deployment protection: previews password- or SSO-protected via Vercel; production public.
- **No Vercel cron jobs.** Vercel Hobby allows two jobs at once-per-day granularity and rejects more frequent schedules at deploy time; all scheduled work runs from GitHub Actions (AUTH-T38). Do not add a `crons` section to `vercel.json`.
- SGAuth's own `*.vercel.app` preview deployments cannot set a `northeasternsga.com` cookie; they run with `SGAUTH_ENV=preview` (host-only cookie, AUTH-T26) so previews are testable in isolation.

**Acceptance criteria**
- [ ] `https://auth.northeasternsga.com` and `https://auth-dev.northeasternsga.com` serve the app over TLS with valid certificates.
- [ ] Opening a PR creates a Neon preview branch and a preview deployment that runs migrations against it; closing the PR deletes the branch.
- [ ] Vercel env vars are documented in `docs/ENVIRONMENTS.md` with which environment each applies to.

### AUTH-T06 — Update CI: typecheck, lint, format, migrations check, and tests on a Neon test branch

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, ci, chore  
**Depends on:** AUTH-T03 (Install Better Auth 1.7 with the Prisma adapter and mount the handler); AUTH-T93 (Test harness: vitest, Neon test branch, factories, and test mailer)

Extend `.github/workflows/ci.yml` for the new stack.

Jobs: typecheck, lint, format:check (existing), plus:
- `migrations`: `prisma migrate diff` to ensure schema and migrations are in sync and no drift; fails if a migration is missing.
- `test`: vitest unit + integration tests against the Neon `test` branch (AUTH-T93). Use a Neon API key stored as a GitHub secret to reset the branch (`neonctl branches reset`) before the run so tests start clean. Serialize runs with a GitHub Actions `concurrency` group (`neon-test-branch`) so parallel PRs do not share the branch mid-run; per-run branches are avoided because of the 10-branch cap.
- Cache npm and Prisma engines.
- Required checks + branch protection on `main` and `dev` (PR required, at least one review, CI green).

**Acceptance criteria**
- [ ] CI runs on every PR and push to `main`/`dev`, all jobs green on a clean checkout.
- [ ] A PR that changes `schema.prisma` without a migration fails the `migrations` job with a clear message.
- [ ] Branch protection rules are enabled and documented in CONTRIBUTING.md.

### AUTH-T07 — Validate environment variables at startup with zod

**Priority:** Medium · **Estimate:** 1 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, backend, chore  
**Depends on:** AUTH-T02 (Remove Supabase from the auth repo (in-place migration to Neon))

Add `src/lib/env.ts` that parses `process.env` with zod (server and public schemas separated) and fails fast with a readable error listing missing/invalid vars. Rewrite `.env.example` to the final variable list: `DATABASE_URL`, `DIRECT_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SGAUTH_COOKIE_DOMAIN`, `SGAUTH_COOKIE_PREFIX`, `SGAUTH_ENV` (production|dev|preview|local), `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `POSTHOG_KEY`, `POSTHOG_HOST`, `CRON_SECRET`, `NEON_API_KEY` (CI only).

**Acceptance criteria**
- [ ] Starting the app with a missing required var prints the variable name and exits non-zero.
- [ ] `.env.example` lists every variable with a one-line purpose comment and no real values.
- [ ] No code reads `process.env` directly outside `src/lib/env.ts` (enforced by an ESLint `no-restricted-syntax` rule).

### AUTH-T08 — Rewrite README and developer bootstrap for Neon branches

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, docs, chore  
**Depends on:** AUTH-T10 (Core schema: User plus Better Auth Session, Account, and Verification tables); AUTH-T44 (Seed the curated SGA position list)

Replace the Docker/Supabase setup with: create a personal Neon branch from `dev` (`neonctl branches create --parent dev --name <github-handle>`), copy its URLs into `.env`, run `npx prisma migrate dev`, run `npm run seed` (curated positions + a local Primary Admin from `SEED_PRIMARY_ADMIN_EMAIL`), then `npm run dev`. Include the local SSO hostname setup from AUTH-T34 and the scripts table.

**Acceptance criteria**
- [ ] A new contributor can go from clone to logged-in local Primary Admin in under 15 minutes following only the README.
- [ ] The seed is idempotent (re-running changes nothing) and refuses to run when `SGAUTH_ENV=production`.

### AUTH-T09 — Automate Neon branch hygiene to stay under plan limits

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, infra, neon  
**Depends on:** AUTH-T05 (Create the Vercel project, custom domains, environments, and Neon preview branching)

The free plan allows 10 branches per project. Add a scheduled GitHub Action (daily) that lists branches via the Neon API and deletes preview branches whose PR is closed/merged or that are older than 7 days, excluding `main`, `dev`, `test`, and branches matching `dev-*` (personal). Post a summary to the workflow log.

**Acceptance criteria**
- [ ] The action runs daily, is idempotent, and never deletes protected branches (unit test on the filter).
- [ ] Branch count stays below 8 in steady state; a warning is logged at 8 or more.

### AUTH-T101 — Neon Free-plan quota monitoring, alerts, and upgrade runbook

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 0 — Foundation · **Labels:** epic:foundation, phase:0, infra, neon, observability  
**Depends on:** AUTH-T01 (Provision the Neon project, branches, and roles for SGAuth)

Accepted risk from the red-team review: SGAuth runs on Neon Free, which suspends the compute for the remainder of the month once the project uses 100 CU-hours. A compute that stays awake most of the day at the 0.25 CU minimum uses about 180 CU-hours/month, so exhaustion is plausible once several products are live, and it would take every SGA login down at once.
Mitigations: (1) a scheduled job (AUTH-T38, daily) reads consumption via the Neon API and emails all admins at 50%, 70%, and 85% of the monthly CU-hour quota, with a projection of the exhaustion date; (2) keep scale-to-zero at 5 minutes and rely on the SDK cache so idle periods suspend the compute; (3) `docs/runbooks/neon-upgrade.md`: one-click upgrade to Launch (pay-as-you-go, $0.106/CU-hour), what changes (7-day restore window, scale-to-zero configurable), and who is authorized to approve the spend; (4) record the 6-hour restore window as a known limitation in the architecture doc; (5) never add keep-warm pings (they burn the quota).

**Acceptance criteria**
- [ ] Alert emails fire at the thresholds (tested by lowering the threshold on dev).
- [ ] Runbook merged and the upgrade trigger (85% or any suspension) is written into the on-call notes.
- [ ] ARCHITECTURE.md states the Free-plan risk and the restore window explicitly.

## E2 Data Model & Migrations

### AUTH-T10 — Core schema: User plus Better Auth Session, Account, and Verification tables

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 0 — Foundation · **Labels:** epic:data-model, phase:0, backend, prisma  
**Depends on:** AUTH-T03 (Install Better Auth 1.7 with the Prisma adapter and mount the handler); AUTH-T04 (Configure Prisma 7 for Neon (pooled runtime, direct migrations))

Define the identity model in `prisma/schema.prisma` (Neon). Better Auth core tables plus SGAuth fields:

**User**: `id` (uuid v7, PK), `email` (unique, stored lower-cased; use `citext` or a lower-case check), `emailVerified`, `name` (required display name), `preferredName` (optional), `isAdmin` (bool), `isPrimaryAdmin` (bool), `status` (enum ACTIVE | DEACTIVATED | DELETED — DELETED is a tombstone: the row and id survive with PII scrubbed so product foreign keys stay valid), `deactivatedAt`, `deletedAt`, `legacyEmail` (bool; true for imported accounts whose address is not northeastern.edu), `lastLoginAt`, `passwordChangedAt`, `twoFactorEnabled` (plugin), `createdAt`, `updatedAt`.
**Session**: Better Auth fields (`id`, `token` unique, `userId`, `expiresAt`, `ipAddress`, `userAgent`, `createdAt`, `updatedAt`) plus `absoluteExpiresAt` (createdAt + 90 days) and `lastReauthAt`. The Better Auth admin plugin is **not** used (custom authz instead), so no `impersonatedBy`/ban columns.
**KnownDevice**: `id`, `userId`, `tokenHash`, `createdAt`, `lastSeenAt`, `userAgent` — backs the lockout exemption (AUTH-T64).
**Account**: Better Auth fields; `password` holds either a scrypt hash or an imported `bcrypt$...` hash (AUTH-T21). **Verification**: Better Auth fields.

No NUID, phone, pronouns, or photo. Products keep extra fields keyed by SGAuth user id. Write the initial migration and a Prisma-level test that the Better Auth adapter validates against this schema.

**Acceptance criteria**
- [ ] Migration applies cleanly on an empty Neon branch and Better Auth schema validation passes at startup.
- [ ] Email uniqueness is case-insensitive (`Alice@Northeastern.edu` and `alice@northeastern.edu` collide) with a test.
- [ ] `isPrimaryAdmin = true` implies `isAdmin = true` via a CHECK constraint.
- [ ] Indexes exist on `Session.userId`, `Session.expiresAt`, `Account.userId`, `Verification.identifier`.

### AUTH-T11 — Positions schema: Position, UserPosition, and retired keys

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:data-model, phase:1, backend, prisma, positions  
**Depends on:** AUTH-T10 (Core schema: User plus Better Auth Session, Account, and Verification tables)

**Position**: `id` (uuid v7), `key` (unique, immutable, regex `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 2–64 chars), `name` (display, 2–100 chars, editable), `category` (optional text for admin grouping), `description` (optional), `deletedAt` (soft delete), `createdById`, `updatedById`, timestamps.
**UserPosition**: composite PK (`userId`, `positionId`), `assignedById`, `assignedAt`. Unassignment deletes the row; history lives in the audit log. Soft-deleting a position keeps rows for history but they are excluded from sessions.
**RetiredPositionKey**: `key`, `retiredAt`, `positionId` — written on soft delete; the service layer refuses reuse of a key retired less than 365 days ago.
DB-level: partial unique index on `Position(key) WHERE deletedAt IS NULL`; CHECK constraint on key format; trigger or service check enforcing a maximum of 50 active positions per user.

**Acceptance criteria**
- [ ] Creating a position with an invalid key or a key retired within 365 days fails at the service layer with a specific error code (and the DB rejects malformed keys).
- [ ] A user cannot hold more than 50 active positions (test at the boundary).
- [ ] Soft-deleted positions never appear in session or JWT output (covered by AUTH-T45).

### AUTH-T12 — Primary Admin invariants at the database level and the PrimaryAdminTransfer table

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:data-model, phase:1, backend, prisma, admin, security  
**Depends on:** AUTH-T10 (Core schema: User plus Better Auth Session, Account, and Verification tables)

Enforce in Postgres, independent of application code:
- Partial unique index: exactly one row may have `isPrimaryAdmin = true` (`CREATE UNIQUE INDEX one_primary_admin ON "User" ((true)) WHERE "isPrimaryAdmin"`).
- Trigger `protect_primary_admin` BEFORE UPDATE/DELETE on User: reject setting `isAdmin = false`, `status = DEACTIVATED`, or deleting the row while `isPrimaryAdmin = true`; reject clearing `isPrimaryAdmin` unless the transaction has set the session variable `sgauth.pa_transfer = 'on'` (set only by the transfer service and the break-glass script).
**PrimaryAdminTransfer**: `id`, `fromUserId`, `toUserId`, `status` (PENDING_ACCEPTANCE | COOLING | COMPLETED | CANCELLED | EXPIRED), `createdAt`, `acceptanceExpiresAt` (+7 days), `acceptedAt`, `executesAt` (acceptedAt + 24 h), `cancelTokenHash`, `completedAt`, `cancelledAt`, `cancelledById`, `reason`. Partial unique index allowing at most one transfer in PENDING_ACCEPTANCE or COOLING.

**Acceptance criteria**
- [ ] SQL tests: inserting a second Primary Admin fails; updating the PA to non-admin fails; deleting the PA fails; a transfer inside a transaction with the session variable set succeeds and leaves exactly one PA.
- [ ] At most one in-flight transfer can exist (unique index test).
- [ ] Migration is reversible and documented with the reasoning in a comment header.

### AUTH-T13 — Append-only AuditEvent table

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:data-model, phase:1, backend, prisma, audit  
**Depends on:** AUTH-T10 (Core schema: User plus Better Auth Session, Account, and Verification tables)

**AuditEvent**: `id` (uuid v7), `type` (string enum from the event catalog in AUTH-T73), `actorUserId` (nullable; null for system/break-glass), `actorType` (USER | SYSTEM | BREAK_GLASS), `targetType` (USER | POSITION | PRODUCT | SESSION | TRANSFER), `targetId`, `metadata` (jsonb, no secrets), `ip`, `userAgent`, `createdAt`. Index on (`type`, `createdAt`), (`actorUserId`, `createdAt`), (`targetType`, `targetId`, `createdAt`).
Append-only: a trigger rejects UPDATE and DELETE except for the anonymization job (AUTH-T78), which may null `ip`/`userAgent` and replace user-identifying metadata when a user is tombstoned, gated by the same session-variable pattern as AUTH-T12. The session-variable gate protects against accidental writes from application code; it is not a security boundary against anyone holding the database role.
`type` is validated in TypeScript against the catalog (AUTH-T73), not by a DB CHECK, so adding an event type does not require a migration.

**Acceptance criteria**
- [ ] UPDATE/DELETE on AuditEvent fails from the runtime role (test), while the anonymization path succeeds.
- [ ] A unit test rejects emitting an event whose `type` is not in the catalog.

### AUTH-T14 — Product registry schema

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:data-model, phase:2, backend, prisma, registry  
**Depends on:** AUTH-T10 (Core schema: User plus Better Auth Session, Account, and Verification tables)

**Product**: `id`, `slug` (unique, kebab-case), `name`, `description`, `baseUrl` (must be `https://` and end with `.northeasternsga.com`; validated in service and by CHECK), `iconUrl` (optional, https only), `isActive`, `sortOrder`, `visibleToPositionKeys` (text[]; empty = visible to everyone), `loginRedirectPath` (optional path appended after login), `createdById`, timestamps. Seed the dev branch with SGAuth itself plus VaultZ, Chambers, Aplio placeholders.

**Acceptance criteria**
- [ ] Inserting a product with an http:// or non-northeasternsga.com base URL fails.
- [ ] Slug uniqueness enforced; renames of `name` do not change `slug`.

### AUTH-T15 — Security tables: AccountLock, UnlockToken, Jwks, TwoFactor

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:data-model, phase:1, backend, prisma, security  
**Depends on:** AUTH-T10 (Core schema: User plus Better Auth Session, Account, and Verification tables)

- **AccountLock**: `userId` (PK), `failedCount`, `windowStartedAt`, `lockedUntil`, `lockLevel` (0..N for escalation), `lastFailedAt`, `lastFailedIp`.
- **UnlockToken**: `id`, `userId`, `tokenHash`, `expiresAt`, `usedAt`.
- **Jwks** and **TwoFactor** tables as required by the Better Auth jwt and twoFactor plugins (generate via `npx @better-auth/cli generate` and reconcile with Prisma naming).
- **KnownDevice** (see AUTH-T10) for the lockout exemption.
- No rate-limit table: rate limiting uses Upstash (AUTH-T63); disable Better Auth's DB-backed limiter storage.

**Acceptance criteria**
- [ ] Plugin schema validation passes for jwt and twoFactor at startup.
- [ ] Unlock tokens are stored hashed (SHA-256) and single-use (test).

### AUTH-T16 — Migration workflow: deploy in build, never migrate dev against production

**Priority:** Medium · **Estimate:** 1 · **Phase:** Phase 0 — Foundation · **Labels:** epic:data-model, phase:0, backend, prisma, docs  
**Depends on:** AUTH-T04 (Configure Prisma 7 for Neon (pooled runtime, direct migrations)); AUTH-T05 (Create the Vercel project, custom domains, environments, and Neon preview branching)

Document and enforce: developers run `prisma migrate dev` only against personal/preview Neon branches; production and dev deployments run `prisma migrate deploy` during the Vercel build using `DIRECT_URL`. Add a guard script that aborts `migrate dev`/`db push`/`migrate reset` when `SGAUTH_ENV=production` or when `DIRECT_URL` points at the `main` branch host. Write `docs/MIGRATIONS.md` including how to hand-edit generated SQL for triggers/indexes Prisma cannot express, and the **expand/contract rule**: migrations run during the build while the previous deployment is still serving traffic, so every migration must be backward-compatible with the currently deployed code (add columns nullable first, drop in a later release).

**Acceptance criteria**
- [ ] Running `npm run prisma:migrate-dev` with a production `DIRECT_URL` exits non-zero before touching the database (test with a fake host).
- [ ] Vercel production build logs show `migrate deploy` applying pending migrations.

## E3 Authentication Core

### AUTH-T17 — Email + password sign-in and self-sign-up restricted to northeastern.edu

**Priority:** Urgent · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:auth-core, phase:1, backend, better-auth  
**Depends on:** AUTH-T03 (Install Better Auth 1.7 with the Prisma adapter and mount the handler); AUTH-T10 (Core schema: User plus Better Auth Session, Account, and Verification tables)

Enable `emailAndPassword` in Better Auth: `minPasswordLength: 12`, `maxPasswordLength: 128`, default scrypt hashing, `requireEmailVerification: true`, `autoSignIn: false` after sign-up.
- Self-sign-up: a `databaseHooks.user.create.before` hook rejects emails whose domain is not `northeastern.edu` (exact match, lower-cased) unless the creation is admin/import initiated (flag passed via context). Admin-created users may have any domain.
- Normalize email (trim, lower-case) before lookup and storage.
- New self-signed-up users have no positions and no admin flags.
- Deactivated users are refused at sign-in and at session creation (`session.create.before` hook) with a stable error code.
- Record `lastLoginAt` and emit audit events for LOGIN_SUCCESS / LOGIN_FAILED (AUTH-T73).
- **Account pre-hijack defense (red-team):** with `requireEmailVerification`, Better Auth answers a sign-up for an existing email with success (enumeration protection). If that existing account is still **unverified**, the new sign-up must overwrite its password and name (the address owner is whoever verifies), and verification must revoke every existing session. Verified accounts are never overwritten.
- Note: Better Auth re-sends the verification email on every sign-in attempt by an unverified user; the mailer's per-recipient caps (AUTH-T20) and sign-in rate limits (AUTH-T63) bound the abuse.
No breached-password (HIBP) check, per decision.

**Acceptance criteria**
- [ ] Sign-up with `x@gmail.com` is rejected with `EMAIL_DOMAIN_NOT_ALLOWED`; `x@northeastern.edu` succeeds and requires verification before login.
- [ ] Passwords under 12 characters are rejected client- and server-side.
- [ ] A deactivated user cannot sign in and any existing session returns 401 from the session endpoint.
- [ ] Pre-hijack test: attacker signs up with victim's email + password A; victim signs up with password B and verifies; password A no longer works and B does.
- [ ] Integration tests cover success, wrong password, unverified email, deactivated user, and domain rejection.

### AUTH-T18 — Email verification for self-sign-up with resend limits

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:auth-core, phase:1, backend, email  
**Depends on:** AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu); AUTH-T20 (Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps); AUTH-T103 (Scanner-safe email links: land on a page, consume the token on POST)

Send a verification email on sign-up via the mailer (AUTH-T20) with a link valid for 24 hours; the link lands on a confirmation page and the token is consumed only on the button POST (AUTH-T103, Safe Links). Verifying revokes any pre-existing sessions, logs the user in, and redirects to the validated `redirect` target (AUTH-T31) or the account page. Resend is limited to 3 per address per hour (Upstash key `verify:<email>`). Unverified accounts older than 7 days are purged by the retention job (AUTH-T78). The UI shows the same message whether or not the address exists.

**Acceptance criteria**
- [ ] Clicking the link verifies the address once; a second click shows an already-verified message; expired links show a resend option.
- [ ] Fourth resend within an hour returns 429 without sending.

### AUTH-T19 — Password reset flow

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:auth-core, phase:1, backend, email, security  
**Depends on:** AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu); AUTH-T20 (Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps); AUTH-T103 (Scanner-safe email links: land on a page, consume the token on POST)

Forgot-password request (email only; uniform response regardless of existence), reset token valid 1 hour, single use, delivered by email; the token is consumed only when the new-password form is submitted, never on link open (AUTH-T103). On successful reset: set `passwordChangedAt`, revoke all other sessions, clear any account lock, send a security notice email, emit PASSWORD_RESET audit event. Rate limit: 3 requests per email per 10 minutes and per IP (AUTH-T63). Imported bcrypt accounts (AUTH-T21) reset to scrypt.

**Acceptance criteria**
- [ ] Reset for a non-existent email returns the same response and timing profile (within 50 ms) as for an existing one.
- [ ] Using a token twice fails; after reset, previously issued session cookies are rejected.
- [ ] Audit and notice email are produced (asserted with the test mailer).

### AUTH-T20 — Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:auth-core, phase:1, backend, email, infra  
**Depends on:** AUTH-T07 (Validate environment variables at startup with zod)

Password login keeps email volume low (verification, reset, invite, lock/unlock, security notices, PA transfer steps). To avoid sharing Aplio's and Chambers' Resend quota:
- Separate Resend API key and a dedicated sending domain `mail.northeasternsga.com` with SPF, DKIM, and DMARC (p=quarantine) records; `from` = `SGA Auth <no-reply@mail.northeasternsga.com>`.
- `src/lib/email/mailer.ts` provider-agnostic interface (`sendEmail({ to, template, data })`) with a Resend implementation and a console/preview transport for local/test.
- Templates (React Email or plain HTML+text): verify, reset, invite/set-password, account locked, unlock, security notice (password changed / new admin grant), PA transfer initiated / accepted / cancelled / completed, inactivity notice.
- Caps: per-recipient 10 emails per hour and 30 per day; global daily cap (env, default 500) with an alert at 80%. Log every send with template and recipient hash to the log stream.

**Acceptance criteria**
- [ ] DKIM/SPF/DMARC verified in the Resend dashboard; a test email to Gmail and Outlook lands in the inbox with aligned DMARC.
- [ ] Exceeding the per-recipient cap is refused with a logged warning, not an exception to the user.
- [ ] All templates render in both HTML and text and are snapshot-tested.

### AUTH-T21 — Accept imported Chambers bcrypt hashes with lazy re-hash to scrypt

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:auth-core, phase:3, backend, migration, security  
**Depends on:** AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu)

Supabase Auth (GoTrue) stores bcrypt hashes (`$2a$`/`$2b$`). Configure Better Auth `emailAndPassword.password.verify`: if the stored hash starts with `bcrypt$` (marker set by the import, AUTH-T87), verify with `bcryptjs`; on success, re-hash the plaintext with scrypt and update the Account row in the same request, then emit PASSWORD_REHASHED. Otherwise use the default scrypt verify. Never log plaintext. Remove the bcrypt path after all imported accounts have re-hashed or been reset (tracked by a metric).

**Acceptance criteria**
- [ ] A user imported with a bcrypt hash can log in with their Chambers password on the first try and their Account row is scrypt afterwards.
- [ ] Wrong password against a bcrypt hash fails without re-hashing.
- [ ] A metric/query reports how many `bcrypt$` hashes remain.

### AUTH-T22 — Invite flow: admin-created users receive a set-password link

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:auth-core, phase:2, backend, email, admin  
**Depends on:** AUTH-T20 (Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps); AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu); AUTH-T103 (Scanner-safe email links: land on a page, consume the token on POST)

When an admin creates a user (or the bulk import runs), create the User with `emailVerified = true` (admin vouches for the address), no password, and send an invite email with a set-password token valid 7 days (consumed on form submit, AUTH-T103). Setting the password marks the account ready and logs the user in. Admins can resend an invite (rate-limited 3/day per user). Users who never accept are listed in the admin UI as 'Invited'. If an invited (password-less) user tries to self-sign-up with the same email, the login page copy points them to 'Forgot password / set password' rather than creating a second account.

**Acceptance criteria**
- [ ] An invited user cannot log in with any password until they set one via the link.
- [ ] Expired invite shows a message and the admin sees a 'Resend invite' action.

### AUTH-T23 — Change password (current password + re-auth), revoke other sessions

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:auth-core, phase:2, backend, security  
**Depends on:** AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu); AUTH-T32 (Re-authentication (sudo mode) for sensitive actions)

Authenticated users change their password by providing the current password; requires a fresh re-authentication (AUTH-T32). On success: update hash, set `passwordChangedAt`, revoke every other session, send a security notice, emit PASSWORD_CHANGED.

**Acceptance criteria**
- [ ] Wrong current password fails and counts toward account lockout.
- [ ] Other devices are logged out after change (integration test with two sessions).

### AUTH-T24 — Admin-initiated email change with re-verification and privilege rules

**Priority:** Low · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:auth-core, phase:3, backend, admin  
**Depends on:** AUTH-T36 (Admin user-management endpoints); AUTH-T20 (Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps)

Users cannot change their own email in v1 (identity anchoring). Admins can set a new email on a **non-admin** user; only the Primary Admin can change an admin's email; the Primary Admin's own email can be changed only by the Primary Admin. Every email change requires fresh re-authentication (AUTH-T32) so a hijacked session cannot redirect reset or transfer-cancel emails. The account keeps working with the old address until the user verifies the new one via a link sent to the new address (POST-consumed, AUTH-T103); a notice goes to the old address. Changing a `legacyEmail` account to a northeastern.edu address clears the flag. Audit EMAIL_CHANGE_REQUESTED / EMAIL_CHANGED.

**Acceptance criteria**
- [ ] Old address remains valid until verification; after verification the old address cannot log in.
- [ ] Attempting to change to an address already in use fails without revealing which account owns it.
- [ ] An admin cannot change another admin's or the PA's email (authz test); re-auth is required in every case.

### AUTH-T25 — Login, sign-up, forgot/reset, and verify pages

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:auth-core, phase:1, frontend, ui  
**Depends on:** AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu); AUTH-T18 (Email verification for self-sign-up with resend limits); AUTH-T19 (Password reset flow); AUTH-T31 (Safe post-login redirects validated against the product registry)

Build the public auth pages with shadcn/ui and react-hook-form + zod: `/login` (email, password, preserves redirect param, links to forgot and sign-up), `/sign-up` (northeastern.edu hint, name, password with live length feedback), `/forgot-password`, `/reset-password/[token]`, `/verify-email/[token]`, `/set-password/[token]` (invites), `/locked` (explains lock and unlock email). Map Better Auth error codes to friendly copy without leaking account existence. Show SGA branding and a one-line explanation that this login works across all SGA tools.

**Acceptance criteria**
- [ ] All pages are keyboard navigable, pass axe with no serious violations, and work at 360 px width.
- [ ] Wrong password and unknown email share the same copy; unverified, locked, and deactivated states have distinct copy only when shown to the account's own verified session or email link.
- [ ] After login the user lands on the validated redirect target or `/account`.

### AUTH-T99 — Spike: Northeastern Microsoft Entra ID sign-in feasibility

**Priority:** Low · **Estimate:** 3 · **Phase:** Phase 5 — Backlog / spikes · **Labels:** epic:auth-core, phase:5, spike, sso  
**Depends on:** AUTH-T91 (Production launch checklist and Primary Admin bootstrap)

Not a launch dependency. Investigate whether SGA can (a) get an app registered in Northeastern's Entra tenant via ITS, or (b) register a multi-tenant app in an SGA-owned tenant that Northeastern's tenant permits users to consent to, restricting sign-in to Northeastern's tenant id. If viable, prototype Better Auth's `microsoft` social provider behind a feature flag, linking to existing accounts by verified email. Report blockers, MFA inheritance (Duo), and the account-linking policy.

**Acceptance criteria**
- [ ] Written findings with a go/no-go recommendation and, if go, a follow-up ticket set.

### AUTH-T100 — Backlog: optional email OTP login (deferred due to email volume)

**Priority:** Low · **Estimate:** 2 · **Phase:** Phase 5 — Backlog / spikes · **Labels:** epic:auth-core, phase:5, backlog, email  
**Depends on:** AUTH-T91 (Production launch checklist and Primary Admin bootstrap)

Deferred by decision: password is the launch method because Resend free-tier volume is constrained. Revisit after launch: Better Auth `emailOTP` plugin as an alternative sign-in for users who forget passwords, with strict per-user caps. Requires a volume estimate against the org-wide Resend budget first.

**Acceptance criteria**
- [ ] Decision recorded after reviewing 60 days of email volume metrics.

### AUTH-T103 — Scanner-safe email links: land on a page, consume the token on POST

**Priority:** Urgent · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:auth-core, phase:1, backend, email, security  
**Depends on:** AUTH-T20 (Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps)

Northeastern mail is Microsoft 365, and Defender Safe Links pre-fetches every link in incoming mail. A link that acts on GET (verify, reset, invite/set-password, unlock, PA transfer accept/cancel) would be consumed by the scanner before the user clicks. Rule for every emailed link in SGAuth: the URL opens a page that shows what is about to happen and a button; the token is validated for display on GET (never consumed, never marks anything) and consumed only on the button's POST (same-origin, CSRF-protected). Better Auth's built-in verify-email link acts on GET, so send our own URL (`/verify-email?token=`) that renders the confirmation page and calls the Better Auth verification endpoint on submit. HEAD requests and known scanner user agents get a 200 with no side effects. Provide one shared `TokenActionPage` component and a helper used by AUTH-T18, T19, T22, T24, T37, T64.

**Acceptance criteria**
- [ ] A HEAD or GET request to any emailed link does not consume the token (integration test); the subsequent POST does, exactly once.
- [ ] Every email template's link points at a page implementing the pattern (test enumerates templates).

## E4 Sessions & SSO

### AUTH-T26 — Parent-domain session cookie for *.northeasternsga.com

**Priority:** Urgent · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:sessions, phase:1, backend, sso, security  
**Depends on:** AUTH-T03 (Install Better Auth 1.7 with the Prisma adapter and mount the handler)

Configure Better Auth cookies so a single session spans every SGA subdomain:
- `advanced.crossSubDomainCookies = { enabled: true, domain: 'northeasternsga.com' }` in production and dev; `advanced.cookiePrefix` = `sgauth` (production) and `sgauth-dev` (dev deployment) so the two environments never collide on the shared parent domain.
- `defaultCookieAttributes`: `httpOnly: true`, `secure: true`, `sameSite: 'lax'`, `path: '/'`. Production cookie name becomes `__Secure-sgauth.session_token`. `__Host-` is impossible with a Domain attribute; document why.
- `session.cookieCache` disabled (no `session_data` cookie) so revocation is immediate.
- `SGAUTH_ENV=preview` (SGAuth's own `*.vercel.app` previews): cross-subdomain cookies **disabled**, host-only cookie, so previews can log in at all.
- Local dev uses the topology from AUTH-T34. Validate the whole configuration early with the spike in AUTH-T104 (there are unresolved community reports of cross-subdomain cookies being set then dropped in some setups).
Document the threat model: any compromised or dangling `*.northeasternsga.com` host can read the cookie **and can set a same-named cookie on the parent domain** (cookie tossing / login CSRF: the victim is silently logged into an attacker-controlled account). Cookie values are signed so they cannot be forged, but `__Host-` cannot be used with a Domain attribute, so subdomain hygiene (AUTH-T68) is the control.

**Acceptance criteria**
- [ ] After login at auth.northeasternsga.com the browser holds one cookie with Domain=northeasternsga.com, Secure, HttpOnly, SameSite=Lax, and the `__Secure-` prefix.
- [ ] A request to a product stub on another subdomain carries the cookie and the session endpoint resolves it.
- [ ] Dev and production cookies coexist in one browser without interfering (different names).

### AUTH-T27 — Session lifetime: 30-day sliding, 90-day absolute cap, no cookie cache

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:sessions, phase:1, backend, sso  
**Depends on:** AUTH-T10 (Core schema: User plus Better Auth Session, Account, and Verification tables); AUTH-T26 (Parent-domain session cookie for *.northeasternsga.com)

`session.expiresIn = 30 days`, `session.updateAge = 1 day` (sliding). Leave Better Auth's `freshAge` at its default: it gates Better Auth's own fresh-session endpoints and is **not** the re-auth mechanism (AUTH-T32 uses `lastReauthAt`). Absolute cap: set `absoluteExpiresAt = createdAt + 90 days` in `session.create.before`, reject sessions past it in the session endpoint, **and** have the daily retention job (AUTH-T78) delete any session whose `createdAt` is older than 90 days, because Better Auth's own endpoints (e.g. `/token`) do not run the custom check. Capture IP (from `x-forwarded-for` first hop on Vercel) and user agent. Sessions and JWTs are DB-backed; no cookie cache.

**Acceptance criteria**
- [ ] A session used daily is still valid on day 29 and invalid on day 91 (time-travel test), including at `/api/auth/token`.
- [ ] A session unused for 31 days is invalid.
- [ ] Session rows store IP and user agent for the account page.

### AUTH-T28 — Session endpoint for products: user, email, positions, admin flags

**Priority:** Urgent · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:sessions, phase:1, backend, sso, api  
**Depends on:** AUTH-T27 (Session lifetime: 30-day sliding, 90-day absolute cap, no cookie cache); AUTH-T11 (Positions schema: Position, UserPosition, and retired keys)

Products resolve the shared cookie by calling SGAuth server-side. Implement `GET /api/sgauth/session` (a thin wrapper over Better Auth `getSession` plus the `customSession` plugin) returning:
```json
{ "user": { "id": "uuid", "email": "...", "name": "...", "preferredName": null, "isAdmin": false, "isPrimaryAdmin": false },
  "positions": [{ "key": "vp-finance", "name": "Vice President of Finance" }],
  "session": { "id": "...", "expiresAt": "...", "absoluteExpiresAt": "...", "createdAt": "..." } }
```
- 401 with `{ "error": "unauthenticated" }` when the cookie is missing, expired, revoked, past the absolute cap, or the user is deactivated.
- Positions read live from the DB (active, non-deleted), sorted by key.
- Headers: `Cache-Control: no-store`, `Vary: Cookie`. Accept the cookie via the `Cookie` header only (no query/body tokens).
- Also expose `GET /api/sgauth/session/minimal` returning only user id + positions for hot paths. Publish the JSON schema in the SDK.

**Acceptance criteria**
- [ ] Contract tests cover the 200 shape, 401 cases, position ordering, and that deactivation/revocation is reflected on the very next call.
- [ ] p95 latency under 120 ms from a Vercel function in the same region (measured against dev).
- [ ] Response never includes password hashes, tokens, or MFA secrets (schema assertion).

### AUTH-T29 — ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sessions, phase:2, backend, sso, supabase, jwt  
**Depends on:** AUTH-T28 (Session endpoint for products: user, email, positions, admin flags); AUTH-T15 (Security tables: AccountLock, UnlockToken, Jwks, TwoFactor)

Add the Better Auth `jwt` plugin configured for Supabase third-party auth:
- `jwks.keyPairConfig = { alg: 'ES256' }`; **automatic rotation disabled** (no `rotationInterval`). Supabase learns about a new key only when it re-fetches the JWKS (up to ~30 minutes), so an automatic rotation would reject fresh tokens for that window. Rotation is manual (annually or on incident) per the runbook in AUTH-T69: generate the new key, push the combined JWKS to every Supabase project via `custom_jwks`, then switch signing; keep the old key published for 7 days.
- `jwt.issuer = 'https://auth.northeasternsga.com'` (no trailing slash; discovery must resolve at `{issuer}/.well-known/openid-configuration`), `jwt.audience = 'authenticated'` (matches Supabase's own token convention so any audience check passes), `jwt.expirationTime = '10m'`, `getSubject = user.id` (UUID, required because Supabase `auth.uid()` casts `sub` to uuid). Private keys encrypted at rest (default).
- `definePayload`: `{ email, name, role: 'authenticated', positions: [keys], is_admin, is_primary_admin }`. Include the `kid` header (plugin default). `role: 'authenticated'` is required so Supabase maps the request to the `authenticated` Postgres role.
- Endpoints: `/api/auth/jwks` (plugin) and rewrites for `/.well-known/jwks.json` and `/.well-known/openid-configuration` (`issuer`, `jwks_uri`, `id_token_signing_alg_values_supported: ['ES256']`, minimal fields) so Supabase can be pointed at the issuer URL.
- Token endpoint `/api/auth/token` requires a valid session cookie (rate-limited in AUTH-T63).

**Acceptance criteria**
- [ ] A token from `/api/auth/token` verifies with `jose` against the JWKS with issuer and audience checks and contains `sub` (uuid), `role: 'authenticated'`, and `positions`.
- [ ] `/.well-known/openid-configuration` returns valid JSON with `jwks_uri` resolving to the live key set.
- [ ] After a manual rotation on dev, tokens signed by the previous key verify for 7 days and new tokens carry the new `kid`; the JWKS lists both keys during the overlap.
- [ ] Token size stays under 2 KB with 50 positions of 64 characters (test).

### AUTH-T30 — Global logout, sign out everywhere, and admin revocation

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:sessions, phase:1, backend, sso  
**Depends on:** AUTH-T26 (Parent-domain session cookie for *.northeasternsga.com); AUTH-T56 (Product registry service: trusted origins and redirect allowlist at runtime)

- `POST /api/auth/sign-out` deletes the current session row and clears the parent-domain cookie (same Domain/Path/prefix, `Max-Age=0`); every subdomain is logged out immediately because they share the cookie and the DB row is gone.
- `POST /api/sgauth/sessions/revoke-all` (user) revokes all sessions including the current one.
- Admin endpoint to revoke all sessions of a target user (AUTH-T36) with audit SESSIONS_REVOKED.
- `/logout?redirect=` convenience route for products: rejects requests whose `Sec-Fetch-Site` is `cross-site` (so an external page cannot log users out via an image or link), signs out, then redirects to a registry-validated URL (AUTH-T56) or to `/login`. Sibling subdomains are same-site and keep working.
Supabase-style JWTs already issued remain valid until their 10-minute expiry; document this in the Supabase guide.

**Acceptance criteria**
- [ ] After sign-out on one subdomain, the session endpoint returns 401 for a request from another subdomain using the same browser.
- [ ] `/logout?redirect=https://evil.example` redirects to `/login`, not the attacker URL.
- [ ] Admin revocation invalidates every session of the target within one request.

### AUTH-T31 — Safe post-login redirects validated against the product registry

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:sessions, phase:1, backend, security, sso  
**Depends on:** AUTH-T56 (Product registry service: trusted origins and redirect allowlist at runtime)

`/login?redirect=<url>` is the entry point every product uses. Validate: absolute `https://` URL whose origin exactly matches an active product's base URL origin (or SGAuth itself), or a relative path starting with `/` (not `//`). Strip fragments; cap length at 2 KB. Persist the redirect through sign-up, verification, and reset via a short-lived signed cookie rather than hidden form fields. Unknown or malformed targets fall back to `/account`.

**Acceptance criteria**
- [ ] Open-redirect test suite (protocol-relative, backslashes, userinfo tricks, unicode homographs, unregistered subdomains) all land on `/account`.
- [ ] A valid `https://vaultz.northeasternsga.com/purchases/42` survives login → verify → login and is honored.

### AUTH-T32 — Re-authentication (sudo mode) for sensitive actions

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sessions, phase:2, backend, security  
**Depends on:** AUTH-T27 (Session lifetime: 30-day sliding, 90-day absolute cap, no cookie cache); AUTH-T67 (TOTP multi-factor authentication (optional for users, required for admins and the Primary Admin))

Sensitive actions require proof of presence within the last 10 minutes: Primary Admin transfer steps, granting/revoking admin, changing password, changing any email, enrolling/disabling/resetting MFA, revoking all sessions, deleting/deactivating users. Implement `POST /api/sgauth/reauth` accepting password (and TOTP code if enrolled) that stamps `Session.lastReauthAt`; a `requireFreshAuth()` guard checks the stamp. This is independent of Better Auth's `freshAge` (left at default). The UI shows a modal to re-enter credentials when the guard fails (403 `REAUTH_REQUIRED`). Failed re-auth attempts count toward lockout.

**Acceptance criteria**
- [ ] Calling a sensitive endpoint 11 minutes after re-auth returns 403 `REAUTH_REQUIRED`; within 10 minutes it succeeds.
- [ ] Re-auth for an MFA-enrolled user requires both password and a valid TOTP.

### AUTH-T33 — List and revoke the user's own sessions

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sessions, phase:2, backend  
**Depends on:** AUTH-T27 (Session lifetime: 30-day sliding, 90-day absolute cap, no cookie cache)

`GET /api/sgauth/sessions` returns the caller's active sessions (id, createdAt, lastActiveAt, ip, userAgent parsed to a friendly device string, isCurrent). `DELETE /api/sgauth/sessions/:id` revokes one of the caller's sessions. Audit SESSION_REVOKED.

**Acceptance criteria**
- [ ] A user cannot list or revoke another user's session (404, not 403, to avoid id probing).
- [ ] Revoking the current session also clears the cookie.

### AUTH-T34 — Non-production SSO topology: dev deployment, local hostnames, product preview domains

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:sessions, phase:1, infra, sso, docs  
**Depends on:** AUTH-T05 (Create the Vercel project, custom domains, environments, and Neon preview branching); AUTH-T26 (Parent-domain session cookie for *.northeasternsga.com)

A parent-domain cookie cannot be read by `*.vercel.app` previews or plain `localhost`, so define the non-production topology once:
- **Dev SGAuth**: `auth-dev.northeasternsga.com` (branch `dev`, Neon `dev` branch, cookie prefix `sgauth-dev`). Products point their preview and dev environments here. Because it is a production-looking login page on the trusted domain: persistent 'DEVELOPMENT ENVIRONMENT' banner on every page, `noindex`, synthetic users only (real user imports are never run against dev), and fully separate secrets (Better Auth secret, Resend key, Upstash namespace).
- **Product previews**: each product gets a stable branch domain like `<product>-dev.northeasternsga.com` (Vercel branch domain) so the dev cookie is shared; ad-hoc `*.vercel.app` previews cannot use SSO (document the limitation).
- **Local**: developers use `*.localhost` hostnames (Chrome resolves subdomains of localhost automatically; Firefox needs a preference) or hosts-file entries; SGAuth locally runs on `http://auth.sga.localhost:3000` with cookie domain `sga.localhost`, `secure: false`, no `__Secure-` prefix. Provide a `SGAUTH_ENV=local` switch that applies these settings. Browser handling of `Domain=<x>.localhost` cookies differs (Safari is the usual problem); the spike in AUTH-T104 confirms the local scheme or falls back to a hosts-file domain such as `sga.test`.
- **SDK dev mode**: the SDK accepts `SGAUTH_URL` and `SGAUTH_COOKIE_NAME` overrides so products target dev or local SGAuth. Write `docs/ENVIRONMENTS.md` with a table of URLs, cookie names, and Neon branches per environment.

**Acceptance criteria**
- [ ] A product stub running on `vaultz.sga.localhost:3001` sees a session created at `auth.sga.localhost:3000` (documented manual test plus a Playwright job in AUTH-T96).
- [ ] `docs/ENVIRONMENTS.md` exists and is linked from README and the integration guides.
- [ ] Production configuration cannot be started with a non-secure cookie setting (startup assertion).

### AUTH-T104 — Spike: validate cross-subdomain cookies, prefixes, and local hostnames on the real domain before building on them

**Priority:** Urgent · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:sessions, phase:1, spike, sso, better-auth  
**Depends on:** AUTH-T05 (Create the Vercel project, custom domains, environments, and Neon preview branching); AUTH-T26 (Parent-domain session cookie for *.northeasternsga.com)

Community reports (better-auth issues #5611, #3938) describe cross-subdomain cookies being set and then dropped in some configurations. Before any product integration work, deploy the minimal Better Auth config to `auth-dev.northeasternsga.com` and a static stub on `stub-dev.northeasternsga.com`, then verify in Chrome, Firefox, and Safari: (1) login sets exactly one `__Secure-sgauth-dev.session_token` cookie with `Domain=northeasternsga.com`; (2) the stub's server receives it and the session endpoint resolves it; (3) sign-out clears it on both hosts; (4) the `SGAUTH_ENV=preview` host-only mode works on a `*.vercel.app` preview; (5) the local `*.sga.localhost` scheme works in all three browsers or the fallback (hosts-file `sga.test`) is adopted; (6) a stale cookie with the same name set by the stub host (cookie tossing) is observed and its effect documented. Record findings in `docs/ENVIRONMENTS.md` and adjust AUTH-T26/T34 accordingly.

**Acceptance criteria**
- [ ] Findings documented per browser with screenshots or HAR excerpts; any Better Auth version pin or workaround recorded.
- [ ] Go/no-go on the parent-domain cookie approach signed off by the SGAuth lead.

## E5 Admin & Primary Admin

### AUTH-T35 — Authorization module with the admin/Primary Admin rule matrix

**Priority:** Urgent · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:admin, phase:2, backend, admin, security  
**Depends on:** AUTH-T10 (Core schema: User plus Better Auth Session, Account, and Verification tables); AUTH-T12 (Primary Admin invariants at the database level and the PrimaryAdminTransfer table)

Create `src/lib/authz.ts`: pure functions `can(actor, action, target)` used by every mutating endpoint. Rules:
- Only admins may perform admin actions; deactivated actors can do nothing.
- Admins may grant or revoke admin for **other** users freely; they can never change their **own** admin status or deactivate/delete themselves.
- Nobody except the transfer flow or break-glass may modify the Primary Admin's admin flag, status, PA flag, MFA, or email, or delete the account. The PA's positions and display name may be edited by any admin like any other user (accepted: an admin could strip the PA's product positions, which affects product access only, never SGAuth authority, and is audited).
- Email changes: admins may change non-admin users' emails; only the PA may change an admin's email; the PA changes their own. MFA reset: admins may reset non-admin and (only the PA) admin MFA; PA MFA reset is break-glass only.
- The Primary Admin may do everything an admin can, including changing other admins, and is the only one who can initiate a transfer.
- Position and product CRUD: any admin.
Return structured denials (`{ allowed: false, reason: 'SELF_MODIFICATION' | 'PRIMARY_ADMIN_PROTECTED' | 'NOT_ADMIN' | ... }`). UI hides controls using the same function, but enforcement is server-side only.

**Acceptance criteria**
- [ ] Table-driven unit tests enumerate actor ∈ {user, admin, primary admin, deactivated admin} × target ∈ {self, other user, other admin, primary admin} × action ∈ {grantAdmin, revokeAdmin, deactivate, delete, assignPosition, initiateTransfer} with expected results; 100% branch coverage of `authz.ts`.
- [ ] Every mutating route imports `can()`; an ESLint rule or test asserts no admin route lacks the guard.

### AUTH-T36 — Admin user-management endpoints

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:admin, phase:2, backend, admin, api  
**Depends on:** AUTH-T35 (Authorization module with the admin/Primary Admin rule matrix); AUTH-T13 (Append-only AuditEvent table); AUTH-T32 (Re-authentication (sudo mode) for sensitive actions); AUTH-T22 (Invite flow: admin-created users receive a set-password link)

Server actions or route handlers under `/api/sgauth/admin/users`: list/search (by email, name, position, status, admin flag; paginated), get, create (invite), update name/preferredName, deactivate (revokes all sessions immediately), reactivate, delete (= tombstone: status DELETED, PII scrubbed, sessions/accounts/MFA/positions removed, id retained), grant admin, revoke admin, revoke all sessions, unlock account, reset MFA (per the authz rules; emails the user), resend invite, force re-login. Every call passes `can()`, requires fresh re-auth for grant/revoke admin, deactivate, delete, and MFA reset, and emits an audit event with actor, target, and diff. Deactivation/deletion of the PA and self-modification are refused with the authz reason.

**Acceptance criteria**
- [ ] Integration tests for every endpoint including denials (self-modify, PA-protected, non-admin, deactivated actor).
- [ ] Deactivating a user with three active sessions leaves zero sessions and their next product request returns 401.
- [ ] Each mutation produces exactly one audit row with the expected type and metadata.

### AUTH-T37 — Primary Admin transfer flow (re-auth, recipient acceptance, 24-hour cancel window)

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:admin, phase:2, backend, admin, security, email  
**Depends on:** AUTH-T12 (Primary Admin invariants at the database level and the PrimaryAdminTransfer table); AUTH-T35 (Authorization module with the admin/Primary Admin rule matrix); AUTH-T32 (Re-authentication (sudo mode) for sensitive actions); AUTH-T20 (Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps); AUTH-T67 (TOTP multi-factor authentication (optional for users, required for admins and the Primary Admin)); AUTH-T103 (Scanner-safe email links: land on a page, consume the token on POST); AUTH-T38 (Scheduled-job runner: GitHub Actions schedules calling secret-protected routes)

Implement the guarded transfer as a state machine over `PrimaryAdminTransfer`:
1. **Initiate** (PA only, fresh re-auth, recipient must be an active admin with MFA enrolled, PA must type the recipient email exactly): creates PENDING_ACCEPTANCE (expires in 7 days), emails recipient (accept link) and PA (confirmation), audit PA_TRANSFER_INITIATED.
2. **Accept** (recipient only, fresh re-auth): moves to COOLING, sets `executesAt = now + 24h`, generates a cancel token emailed to the outgoing PA (and shown in-app), emails both, audit PA_TRANSFER_ACCEPTED.
3. **Cancel**: outgoing PA (in-app with re-auth, or via the emailed cancel link without login — the link opens a page with a Cancel button; the token is consumed on POST, AUTH-T103), or recipient declines; status CANCELLED, both emailed, audit PA_TRANSFER_CANCELLED. The accept link likewise lands on a page requiring login + re-auth before acting.
4. **Execute** (scheduler, AUTH-T38): when `executesAt` has passed and status is COOLING, in one transaction with the DB session variable set: clear PA on the old user, set it on the recipient, keep both as admins, revoke all sessions of both users (forces re-login with correct claims), status COMPLETED, emails to both and to every admin, audit PA_TRANSFER_COMPLETED.
5. **Expire**: PENDING_ACCEPTANCE older than 7 days → EXPIRED, emails PA.
Exactly one in-flight transfer is allowed. If the recipient loses admin or is deactivated mid-flight, the transfer is cancelled automatically.

**Acceptance criteria**
- [ ] State-machine tests cover every transition and every illegal transition (e.g. accept by a third party, cancel after completion, initiate while one is in flight).
- [ ] The emailed cancel link works without a session and is single-use.
- [ ] After execution there is exactly one PA, both parties are admins, and both must log in again.
- [ ] Recipient deactivation during COOLING cancels the transfer and notifies the PA.

### AUTH-T38 — Scheduled-job runner: GitHub Actions schedules calling secret-protected routes

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:admin, phase:1, backend, infra, ci  
**Depends on:** AUTH-T05 (Create the Vercel project, custom domains, environments, and Neon preview branching); AUTH-T07 (Validate environment variables at startup with zod)

Vercel Hobby limits cron to two jobs at once-per-day and rejects finer schedules at deploy time, so **no Vercel cron is used**. Instead, a GitHub Actions workflow in the auth repo (same pattern Chambers uses) runs on schedules and calls `GET /api/jobs/<name>` with `Authorization: Bearer $CRON_SECRET` (repo secret = Vercel env):
- `pa-transfer` every 15 minutes: executes due COOLING transfers and expires stale PENDING_ACCEPTANCE ones, idempotently (row-level lock, status re-check inside the transaction).
- `alerts` every 15 minutes (AUTH-T77).
- `retention` daily (AUTH-T78).
Each route is idempotent, logs outcomes, and returns quickly (under the function timeout); Actions schedules can be delayed several minutes under load, which is acceptable for these jobs. A missed run is caught by the next.

**Acceptance criteria**
- [ ] Running the transfer job twice concurrently executes the transfer once (test with a simulated race).
- [ ] Requests without the correct bearer secret return 401 and do nothing.
- [ ] Workflow file exists with the three schedules; `vercel.json` contains no `crons`.

### AUTH-T39 — Break-glass Primary Admin recovery script and runbook

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:admin, phase:2, backend, admin, security, docs  
**Depends on:** AUTH-T12 (Primary Admin invariants at the database level and the PrimaryAdminTransfer table); AUTH-T13 (Append-only AuditEvent table)

`scripts/recover-primary-admin.ts` run by a human with production Neon credentials (`npm run recover-primary-admin -- --email new-pa@northeastern.edu --reason "..."`). It: verifies the target user exists and is active; prompts for the confirmation phrase `TRANSFER PRIMARY ADMIN`; inside one transaction with the DB session variable set, moves the PA flag, ensures the new PA is admin, revokes all sessions of the previous PA; writes an AuditEvent with `actorType = BREAK_GLASS` and the operator's name/reason; emails every admin and the old PA address. Supports `--dry-run`. A second mode, `--reset-mfa --email <pa>`, clears the current PA's TOTP and backup codes (for the lost-phone-and-lost-codes case, since admins cannot touch PA MFA) and forces re-enrollment on next login. No HTTP endpoint exists for either. Write `docs/runbooks/break-glass.md`: when to use it, who holds credentials (at least two people), and how to verify afterwards.

**Acceptance criteria**
- [ ] Dry run prints the plan and changes nothing; real run leaves exactly one PA and an audit row of type BREAK_GLASS_PA_RECOVERY.
- [ ] Script refuses to run without `DIRECT_URL` and the confirmation phrase.
- [ ] Runbook reviewed by the current Primary Admin.

### AUTH-T40 — Primary Admin protection tests across API and database layers

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:admin, phase:2, testing, admin, security  
**Depends on:** AUTH-T12 (Primary Admin invariants at the database level and the PrimaryAdminTransfer table); AUTH-T36 (Admin user-management endpoints)

Integration tests proving the PA cannot be deleted, deactivated, banned, stripped of admin, or have the PA flag removed via any admin endpoint, Better Auth admin plugin endpoint (if mounted), or direct SQL from the runtime role; and that the PA is subject to account lockout but can self-unlock via the emailed link.

**Acceptance criteria**
- [ ] All listed attack paths fail with the expected error at the API layer and, when bypassed, at the DB trigger.
- [ ] Lockout/unlock test for the PA passes.

### AUTH-T41 — Bulk user import (CSV) with position assignment and batched invites

**Priority:** Medium · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:admin, phase:2, backend, admin, migration  
**Depends on:** AUTH-T36 (Admin user-management endpoints); AUTH-T43 (Position assignment endpoints (assign, unassign, bulk))

Admin endpoint + UI to upload a CSV (`email,name,positions` where positions is a `|`-separated list of keys). Validates rows (email format, known keys), previews the diff (new users, existing users, position changes), then applies: creates users as invited (AUTH-T22), assigns positions, and queues invite emails respecting mailer caps (AUTH-T20) in batches. Produces a downloadable report. Audit BULK_IMPORT with counts.

**Acceptance criteria**
- [ ] A 200-row CSV with 5 invalid rows shows the 5 errors and imports nothing until fixed (all-or-nothing) or with an explicit 'skip invalid' toggle.
- [ ] Re-importing the same CSV is idempotent (no duplicate users or assignments).

## E6 Positions

### AUTH-T42 — Positions CRUD: create, edit name/category, soft delete with retirement

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:positions, phase:2, backend, positions, api  
**Depends on:** AUTH-T11 (Positions schema: Position, UserPosition, and retired keys); AUTH-T35 (Authorization module with the admin/Primary Admin rule matrix); AUTH-T13 (Append-only AuditEvent table)

Admin endpoints: create (key + name + optional category/description; key validated, uniqueness checked against active and retired-within-365-days keys), update (name/category/description only; key immutable), delete (soft; returns holder count first via a preflight, requires the admin to send `confirmKey` equal to the key; on delete: set `deletedAt`, write RetiredPositionKey, keep UserPosition rows, emit POSITION_DELETED with holder ids). Audit every change with before/after. List endpoint supports including deleted for history views.

**Acceptance criteria**
- [ ] Renaming changes `name` only; the key and all holders are untouched (test asserts session output before/after).
- [ ] Delete without the matching `confirmKey` is refused; with it, holders lose the position on the next session call.
- [ ] Creating a key retired 100 days ago fails with `KEY_RETIRED`; 400 days ago succeeds.

### AUTH-T43 — Position assignment endpoints (assign, unassign, bulk)

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:positions, phase:2, backend, positions, api  
**Depends on:** AUTH-T42 (Positions CRUD: create, edit name/category, soft delete with retirement)

Admin endpoints to assign/unassign one or many positions to a user and to assign one position to many users. Enforce the 50-position cap, refuse deleted positions, ignore duplicates, emit POSITION_ASSIGNED / POSITION_UNASSIGNED per pair. Assignments are visible in the session endpoint on the next call (no caching in SGAuth).

**Acceptance criteria**
- [ ] Assigning the 51st position fails with `POSITION_LIMIT`.
- [ ] Bulk assign of 30 users is one transaction and one audit row per pair.

### AUTH-T44 — Seed the curated SGA position list

**Priority:** Medium · **Estimate:** 1 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:positions, phase:1, backend, positions  
**Depends on:** AUTH-T11 (Positions schema: Position, UserPosition, and retired keys)

**Input received 2026-09-18:** `prisma/seed/positions.json` already exists in the repo with 82 positions (81 offices across 9 categories — Office of the President, Academic Affairs, Campus Affairs, Diversity Equity and Inclusion, External Affairs, Student Involvement, Student Success, Operational Affairs, Senate — plus `senator`). Keys were generated by slugifying the official names and validated against the key format and length rules. Upsert by key in the seed script (safe to run in every environment; never deletes; name/category updates are applied, keys never change). Include a validation test that every key matches the format and names are unique. Product-specific roles (e.g. `aplio-admin`) are **not** seeded; product owners create them in the admin UI when they integrate.
Key naming convention (document in the admin UI help and the integration guides): organization roles use bare keys (`vp-finance`, `senator`); product-specific roles are prefixed with the product slug (`aplio-admin`, `chambers-iems`) so keys never collide and products can grep their own.

**Acceptance criteria**
- [ ] Seed creates all 82 curated positions with zero holders; re-running is a no-op.
- [ ] A test loads `prisma/seed/positions.json` and asserts every key matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`, is 2–64 chars, and that keys and names are unique.

### AUTH-T45 — Position propagation tests and forced re-login

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:positions, phase:2, testing, positions, sso  
**Depends on:** AUTH-T43 (Position assignment endpoints (assign, unassign, bulk)); AUTH-T28 (Session endpoint for products: user, email, positions, admin flags); AUTH-T29 (ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products)

Tests: after assign/unassign/delete, the very next `/api/sgauth/session` call reflects the change; a JWT minted before the change stays valid until expiry (≤10 min) and a new token reflects it. Add an admin action 'Force re-login' (revoke all sessions of a user) surfaced in the UI as the way to invalidate outstanding JWTs immediately. Document the staleness model in the integration guides.

**Acceptance criteria**
- [ ] Automated tests demonstrate immediate propagation for the session endpoint and bounded staleness for JWTs.
- [ ] Guides contain a 'Propagation and staleness' section.

### AUTH-T46 — Position history queries

**Priority:** Low · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:positions, phase:3, backend, positions, audit  
**Depends on:** AUTH-T42 (Positions CRUD: create, edit name/category, soft delete with retirement); AUTH-T73 (Audit event catalog, emitter, and coverage test)

Endpoints returning the audit trail for a position (who was assigned/unassigned, renames, deletion) and for a user (all position changes), backed by AuditEvent indexes. Used by the admin UI detail pages.

**Acceptance criteria**
- [ ] Both queries paginate and return within 200 ms for 10k events on the test branch.

## E7 Admin UI & Account UI

### AUTH-T47 — App shell, navigation, and route guards for /admin and /account

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:ui, phase:2, frontend, ui  
**Depends on:** AUTH-T25 (Login, sign-up, forgot/reset, and verify pages); AUTH-T28 (Session endpoint for products: user, email, positions, admin flags)

Next.js App Router layouts: `(auth)` public pages, `(app)` authenticated pages with a header (user menu, sign out, sign out everywhere), `/account` for all users, `/admin` visible only to admins (server-side guard using `can()`; non-admins get 404). shadcn/ui components, light/dark via next-themes, SGA branding tokens. Toasts via sonner. Loading and error boundaries.

**Acceptance criteria**
- [ ] Non-admin visiting `/admin` receives a 404 page; admin sees the dashboard.
- [ ] Layout works at 360 px and 1440 px; axe reports no serious violations.

### AUTH-T48 — Admin: users list and user detail pages

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:ui, phase:2, frontend, ui, admin  
**Depends on:** AUTH-T47 (App shell, navigation, and route guards for /admin and /account); AUTH-T36 (Admin user-management endpoints); AUTH-T43 (Position assignment endpoints (assign, unassign, bulk))

Users list with search, filters (status, admin, position), pagination, and an 'Invited' badge. User detail: profile fields (editable), positions (assign/unassign with a searchable multi-select), admin toggle (disabled for self and PA with tooltip reason from `can()`), deactivate/reactivate, unlock, resend invite, sessions list with revoke, force re-login, and the user's audit timeline. Re-auth modal appears when the API returns REAUTH_REQUIRED.

**Acceptance criteria**
- [ ] Every action shows success/failure toasts and refreshes data; disabled controls explain why.
- [ ] Playwright test: admin assigns a position, the user's session endpoint reflects it.

### AUTH-T49 — Admin: positions pages

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:ui, phase:2, frontend, ui, positions  
**Depends on:** AUTH-T47 (App shell, navigation, and route guards for /admin and /account); AUTH-T42 (Positions CRUD: create, edit name/category, soft delete with retirement)

List (with holder counts and category grouping), create dialog (key auto-suggested from name, editable before save, immutable after), edit page (name, category, description; key shown read-only with an explanation), delete dialog showing holder count and requiring the key to be typed, and a 'deleted positions' tab with history.

**Acceptance criteria**
- [ ] Key input rejects invalid characters live and shows the format rule.
- [ ] Delete dialog blocks submission until the typed key matches.

### AUTH-T50 — Admin: product registry pages

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:ui, phase:2, frontend, ui, registry  
**Depends on:** AUTH-T47 (App shell, navigation, and route guards for /admin and /account); AUTH-T56 (Product registry service: trusted origins and redirect allowlist at runtime)

CRUD pages for products (name, slug, base URL, description, icon URL, active, sort order, visible-to-positions). Show which trusted origins and redirect targets the registry currently yields.

**Acceptance criteria**
- [ ] Adding a product makes its origin trusted and its URL appear on account pages without a deploy (verified on dev).

### AUTH-T51 — Admin: audit log viewer with filters and CSV export

**Priority:** Medium · **Estimate:** 3 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:ui, phase:3, frontend, ui, audit  
**Depends on:** AUTH-T47 (App shell, navigation, and route guards for /admin and /account); AUTH-T73 (Audit event catalog, emitter, and coverage test)

Table of AuditEvents with filters (type, actor, target, date range), detail drawer for metadata, and CSV export of the filtered set (server-streamed, capped at 50k rows).

**Acceptance criteria**
- [ ] Filtering by a user shows both events they performed and events targeting them.
- [ ] Export matches the on-screen filter.

### AUTH-T52 — Admin: Primary Admin transfer wizard, status, acceptance, and cancel pages

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:ui, phase:2, frontend, ui, admin  
**Depends on:** AUTH-T47 (App shell, navigation, and route guards for /admin and /account); AUTH-T37 (Primary Admin transfer flow (re-auth, recipient acceptance, 24-hour cancel window))

PA-only wizard: full-screen warning explaining consequences, recipient selection limited to eligible admins (MFA enrolled), typed email confirmation, re-auth step, summary. Status card on the admin dashboard while a transfer is in flight (with cancel). Recipient acceptance page (`/admin/transfer/accept/[id]`) with re-auth and decline. Public cancel page for the emailed token. Completion banner for all admins.

**Acceptance criteria**
- [ ] Wizard cannot be completed without typing the exact recipient email and passing re-auth.
- [ ] Ineligible recipients (no MFA, not admin, deactivated) are not selectable and the reason is shown.

### AUTH-T53 — Account page: profile, positions, product links, sessions, sign out everywhere

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:ui, phase:2, frontend, ui  
**Depends on:** AUTH-T47 (App shell, navigation, and route guards for /admin and /account); AUTH-T33 (List and revoke the user's own sessions); AUTH-T56 (Product registry service: trusted origins and redirect allowlist at runtime)

`/account`: edit name and preferredName; read-only list of positions (key and name); 'Your SGA tools' grid of active products from the registry filtered by `visibleToPositionKeys` with links to each product (this is the hub users land on after login without a redirect); sessions list with per-device revoke and 'Sign out everywhere'; links to security settings.

**Acceptance criteria**
- [ ] A user with no positions sees only products visible to everyone.
- [ ] Revoking another device's session removes it from the list and that device gets 401.

### AUTH-T54 — Account security page: change password, MFA enrollment, backup codes

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:ui, phase:3, frontend, ui, security  
**Depends on:** AUTH-T23 (Change password (current password + re-auth), revoke other sessions); AUTH-T67 (TOTP multi-factor authentication (optional for users, required for admins and the Primary Admin))

`/account/security`: change password form; TOTP enrollment (QR + manual secret, verify code, download/copy backup codes once), regenerate backup codes, disable MFA (re-auth; disallowed for admins and PA with explanation). Show 'MFA required for admins' banner and block admin pages until enrolled.

**Acceptance criteria**
- [ ] An admin without MFA is redirected to enrollment when opening `/admin`.
- [ ] Backup codes are shown once; using one logs a security notice.

### AUTH-T55 — Accessibility, responsive, and empty/error state pass

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:ui, phase:3, frontend, ui, a11y  
**Depends on:** AUTH-T48 (Admin: users list and user detail pages); AUTH-T49 (Admin: positions pages); AUTH-T53 (Account page: profile, positions, product links, sessions, sign out everywhere); AUTH-T54 (Account security page: change password, MFA enrollment, backup codes)

Audit every page with axe and keyboard-only navigation; add empty states, loading skeletons, and error states; verify focus management in dialogs; confirm color contrast in both themes.

**Acceptance criteria**
- [ ] axe: zero serious/critical issues on all pages; documented checklist completed.

## E8 Product Registry & SDK

### AUTH-T56 — Product registry service: trusted origins and redirect allowlist at runtime

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:sdk, phase:1, backend, registry, security  
**Depends on:** AUTH-T14 (Product registry schema)

`src/lib/products.ts`: loads active products (cached in-memory for 60 s, invalidated on write), exposes `getTrustedOrigins()` (product origins + SGAuth origin + local dev origins when `SGAUTH_ENV=local`) fed to Better Auth's `trustedOrigins` as a function, and `isAllowedRedirect(url)` used by AUTH-T31 and AUTH-T30. If the registry query fails, fall back to a static list containing only SGAuth's own origin (fail closed for products, but SGAuth's own pages keep working). Never trust `*.vercel.app` and never use a wildcard `https://*.northeasternsga.com` (it would trust dangling subdomains).

**Acceptance criteria**
- [ ] Adding a product on dev makes cross-origin POSTs from its origin pass Better Auth's origin check within 60 s; removing it makes them fail.
- [ ] Unit tests for origin normalization (trailing slash, port, case).

### AUTH-T57 — Scaffold the @sgaoperations/sgauth package and publish pipeline (public npm)

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sdk, phase:2, sdk, infra  
**Depends on:** AUTH-T28 (Session endpoint for products: user, email, positions, admin flags)

New repo `SGAOperations/sgauth-sdk` (TypeScript, tsup, vitest, ESM+CJS, Node 20+). Publish to the **public npm registry** under the `@sgaoperations` org scope (claim the scope on npmjs.com; the SDK contains no secrets, only calls to public SGAuth endpoints with the user's cookie). GitHub Packages was rejected because it requires a classic personal access token to install even public packages. Use npm **trusted publishing** (OIDC from GitHub Actions) so no long-lived npm token exists; publish on `v*` tags; semantic versioning; `CHANGELOG.md`; provenance attestations enabled.

**Acceptance criteria**
- [ ] `npm install @sgaoperations/sgauth` works from any product repo with no `.npmrc` changes.
- [ ] CI publishes on `v*` tags via trusted publishing and fails on version collisions; the package page shows provenance.

### AUTH-T58 — SDK: getSession() with cookie forwarding and a 60-second cache

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sdk, phase:2, sdk, sso  
**Depends on:** AUTH-T57 (Scaffold the @sgaoperations/sgauth package and publish pipeline (public npm))

`getSession({ headers | cookieHeader })`: extracts the SGAuth cookie (name from `SGAUTH_COOKIE_NAME`, default `__Secure-sgauth.session_token`), calls `{SGAUTH_URL}/api/sgauth/session` with the `Cookie` header, returns a typed `SgaSession | null`. In-memory LRU cache keyed by SHA-256 of the token, TTL 60 s (configurable, max 300 s), negative cache 10 s. **Availability:** SGAuth is a single point of failure for every product, so on network error or 5xx the SDK serves a previously cached session for that token for up to `staleIfErrorSeconds` (default 300, max 900) and calls `onError`; with no cached entry it returns null (fail closed). Timeout 3 s. Never caches 5xx as a session. Products must never log the forwarded Cookie header (documented). Ships the JSON schema types from AUTH-T28.

**Acceptance criteria**
- [ ] Unit tests with a mocked fetch: cache hit/miss, TTL expiry, 401 → null, timeout with cached entry → stale session + onError, timeout without cache → null + onError.
- [ ] Revocation observed within 60 s in an integration test against dev.

### AUTH-T59 — SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs)

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sdk, phase:2, sdk, sso  
**Depends on:** AUTH-T58 (SDK: getSession() with cookie forwarding and a 60-second cache)

Exports: `createSgaProxy({ publicPaths })` for Next.js `proxy.ts`/`middleware.ts` that **only checks for the presence of the SGAuth cookie** (no network call, no per-request latency) and redirects to `loginUrl(currentUrl)` when absent; real validation happens in server code via `requireSession()` (throws/redirects on an invalid or revoked cookie). `hasPosition(session, key)`, `hasAnyPosition(session, keys)`, `hasAllPositions`, `isAdmin(session)`; `loginUrl(redirect)`, `logoutUrl(redirect)`, `accountUrl()`. React cache() wrapper for server components so one request resolves the session once. Document why the proxy must not call SGAuth: middleware runs per request and per instance, so a network round trip there adds latency to every page and defeats the cache.

**Acceptance criteria**
- [ ] Example app in the repo demonstrates a protected page, a position-gated action, and logout.
- [ ] Helpers never run in the browser (server-only guard) except the URL builders.

### AUTH-T60 — SDK: getAccessToken() for Supabase clients

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sdk, phase:3, sdk, supabase, jwt  
**Depends on:** AUTH-T58 (SDK: getSession() with cookie forwarding and a 60-second cache); AUTH-T29 (ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products)

`getAccessToken({ headers })` calls `/api/auth/token` with the forwarded cookie and caches the JWT until `exp - 60 s` keyed by session token hash. Provide `createSupabaseAccessTokenProvider()` returning the `accessToken` callback shape supabase-js expects, and a browser-safe variant that calls a product-side route which proxies to SGAuth (so the token never requires exposing SGAuth cookies to client JS).

**Acceptance criteria**
- [ ] Token refresh happens before expiry in a long-running test; a revoked session stops yielding tokens at the next refresh.

### AUTH-T61 — SDK documentation, example app, and versioning policy

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sdk, phase:2, sdk, docs  
**Depends on:** AUTH-T59 (SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs))

README with install (public npm, no registry config), env vars (`SGAUTH_URL`, `SGAUTH_COOKIE_NAME`), quick start, API reference (typedoc), dev/preview topology (AUTH-T34), the stale-if-error behavior and its bound, upgrade notes, and a support policy (latest two minors).

**Acceptance criteria**
- [ ] A new product can integrate using only the README (validated by the VaultZ integration).

### AUTH-T62 — CORS for browser-side calls from registered products

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sdk, phase:3, backend, security, sso  
**Depends on:** AUTH-T56 (Product registry service: trusted origins and redirect allowlist at runtime); AUTH-T28 (Session endpoint for products: user, email, positions, admin flags)

Allow client components on registered product origins to call `/api/sgauth/session`, `/api/auth/token`, and `/api/auth/sign-out` with `credentials: 'include'`: dynamic `Access-Control-Allow-Origin` echoing only registry origins, `Allow-Credentials: true`, `Vary: Origin`, preflight handling, no wildcard. Server-side calls remain the recommended path.

**Acceptance criteria**
- [ ] Preflight from an unregistered origin gets no CORS headers; from a registered one it succeeds with credentials.

## E9 Security Hardening

### AUTH-T63 — Upstash Redis rate limiting on auth and token endpoints

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:security, phase:1, backend, security, infra  
**Depends on:** AUTH-T03 (Install Better Auth 1.7 with the Prisma adapter and mount the handler); AUTH-T07 (Validate environment variables at startup with zod)

Use `@upstash/ratelimit` (sliding window) inside the handlers for **mutating and expensive endpoints only**: sign-in 10/min and 50/hour per IP; sign-up 5/hour per IP; forgot-password 3/10 min per IP and per email; verification resend 3/hour per email; token endpoint 60/min per session; re-auth 5/min per user; admin mutations 100/min per user. The **session endpoint is not Redis-limited** (the Upstash free tier is 500K commands/month and the session endpoint is the hot path); it relies on the SDK cache, Vercel's platform protections, and a cheap in-process token bucket. Disable Better Auth's built-in limiter. **On Upstash outage: fail open everywhere with a logged alert** (decision: an Upstash outage must never become an org-wide login outage); the DB-backed account lockout (AUTH-T64) remains the brute-force backstop. Return 429 with `Retry-After`. Budget: estimate monthly Redis commands from expected logins and document the alert threshold at 80% of the free quota.

**Acceptance criteria**
- [ ] Automated tests hit each limit and observe 429 + `Retry-After`; limits reset after the window.
- [ ] With Upstash unreachable (fake), sign-in still succeeds and an alert-level log line is emitted.
- [ ] Upstash keys are namespaced per environment (`sgauth:prod:`, `sgauth:dev:`).

### AUTH-T64 — Escalating account lockout with emailed unlock and known-device exemption

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:security, phase:1, backend, security, email  
**Depends on:** AUTH-T15 (Security tables: AccountLock, UnlockToken, Jwks, TwoFactor); AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu); AUTH-T20 (Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps); AUTH-T103 (Scanner-safe email links: land on a page, consume the token on POST)

Track failed password attempts per account (AccountLock). 5 failures within 15 minutes → lock 15 min; each subsequent lock doubles (30 min, 1 h, 2 h, … capped at 24 h); never permanent. **Known-device exemption (red-team):** a plain lockout lets anyone who knows an admin's email lock them out indefinitely. After every successful login SGAuth sets a signed, HttpOnly `__Secure-sgauth.device` cookie (host-only on auth.northeasternsga.com, 1-year, hashed in KnownDevice). Sign-in attempts that carry a valid known-device cookie for that account are exempt from the account lock (they remain subject to IP rate limits and their own separate 5-per-15-min counter); attempts without one count toward and are blocked by the lock. Attackers cannot obtain the cookie without a successful login. While locked, sign-in returns the same generic error as wrong password; the locked-account email tells the real owner what happened. On lock: email the user an unlock link (page + POST, AUTH-T103; single-use, 1 h) and a security notice; audit ACCOUNT_LOCKED / ACCOUNT_UNLOCKED. Successful login or password reset resets counters; lock level decays after 24 h clean. Applies to the Primary Admin. Admins can unlock from the UI.

**Acceptance criteria**
- [ ] Sixth attempt within the window from an unknown device is refused even with the correct password; the unlock link restores access.
- [ ] The same account signing in from a browser holding a valid known-device cookie succeeds while the account is locked for unknown devices.
- [ ] Lock durations escalate and cap at 24 h (time-travel test).
- [ ] Unknown emails do not produce different responses or timing.

### AUTH-T65 — CSRF and origin enforcement across subdomains

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:security, phase:1, backend, security, sso  
**Depends on:** AUTH-T56 (Product registry service: trusted origins and redirect allowlist at runtime); AUTH-T26 (Parent-domain session cookie for *.northeasternsga.com)

Because the cookie is shared with every subdomain and SameSite=Lax still sends it on same-site POSTs from sibling subdomains, SGAuth must verify the `Origin` (fallback `Referer`) header on every state-changing request against the registry-derived trusted origins (Better Auth does this for its routes; extend the check to all `/api/sgauth/*` mutations). Reject missing Origin on non-GET. Add `Sec-Fetch-Site` checks as defense in depth.

**Acceptance criteria**
- [ ] A POST to `/api/sgauth/admin/users` with `Origin: https://unregistered.northeasternsga.com` and a valid cookie is rejected 403.
- [ ] Same POST from a registered product origin succeeds.

### AUTH-T66 — Security headers (CSP, HSTS, frame, referrer)

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:security, phase:2, backend, security  
**Depends on:** AUTH-T05 (Create the Vercel project, custom domains, environments, and Neon preview branching)

Set via `next.config.ts` headers: strict CSP (self + PostHog host, nonce for inline scripts), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` minimal. HSTS: `max-age=31536000` on auth.northeasternsga.com **without** `includeSubDomains`/`preload` unless every SGA subdomain is confirmed HTTPS-only (flag for the team; enabling it at the apex affects all products).

**Acceptance criteria**
- [ ] securityheaders.com grade A on production; CSP violations reported to PostHog or a report-only endpoint first for one week.

### AUTH-T67 — TOTP multi-factor authentication (optional for users, required for admins and the Primary Admin)

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:security, phase:2, backend, security, better-auth  
**Depends on:** AUTH-T15 (Security tables: AccountLock, UnlockToken, Jwks, TwoFactor); AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu)

Add the Better Auth `twoFactor` plugin (TOTP + backup codes; no SMS/email OTP). Login flow: after password, if enrolled, prompt for a 6-digit code or backup code; 'trust this device' is NOT enabled (keep it simple and consistent with sessions). Enforcement: users with `isAdmin` must have MFA to access admin endpoints/pages (403 `MFA_REQUIRED` → enrollment redirect); granting admin to a user without MFA is allowed but they are locked out of admin functions until enrolled; the PA transfer recipient must be enrolled. Backup codes hashed; regeneration invalidates old ones; audit MFA_ENROLLED / MFA_DISABLED / MFA_BACKUP_USED.

**Acceptance criteria**
- [ ] Enrolled user must present a valid TOTP; replayed codes within the same step are rejected.
- [ ] Admin without MFA cannot call any admin endpoint; after enrollment the same call succeeds.
- [ ] Disabling MFA requires re-auth and is refused for admins/PA.

### AUTH-T68 — Subdomain hygiene: DNS inventory, dangling-record removal, and policy

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:security, phase:2, infra, security, docs  
**Depends on:** AUTH-T26 (Parent-domain session cookie for *.northeasternsga.com)

Because the session cookie is readable by every `*.northeasternsga.com` host, inventory all DNS records for the domain, remove or reclaim records that point at unowned Vercel/other targets (subdomain takeover), and write `docs/SUBDOMAIN_POLICY.md`: only products in the SGAuth registry may receive a subdomain; wildcard records are prohibited; third-party services get a separate domain. Add a quarterly checklist item.

**Acceptance criteria**
- [ ] Inventory spreadsheet/link attached; zero dangling records; policy merged and linked from the architecture doc.

### AUTH-T69 — Secrets management and rotation procedures

**Priority:** Medium · **Estimate:** 1 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:security, phase:2, infra, security, docs  
**Depends on:** AUTH-T05 (Create the Vercel project, custom domains, environments, and Neon preview branching); AUTH-T29 (ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products)

Document and script rotation for `BETTER_AUTH_SECRET` (invalidates cookie signatures → all users re-login; schedule in a low-usage window), Resend key, Upstash token, Neon passwords, `CRON_SECRET`, and the **manual JWKS rotation** (AUTH-T29): (1) generate the new ES256 key pair in the Jwks table without switching signing; (2) run `scripts/supabase-push-jwks.ts` to PUT the combined JWKS into each Supabase project's third-party integration via `custom_jwks` (Management API) and confirm `resolved_jwks`; (3) switch signing to the new key; (4) after 7 days remove the old key and push again. Ensure secrets are scoped per Vercel environment and never printed in logs or preview builds.

**Acceptance criteria**
- [ ] `docs/runbooks/rotate-secrets.md` exists and a dry run of the JWKS rotation on dev against a throwaway Supabase project produces zero token rejections during the switch.

### AUTH-T70 — Account-enumeration resistance and timing uniformity

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:security, phase:1, backend, security, testing  
**Depends on:** AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu); AUTH-T19 (Password reset flow)

Ensure sign-in, forgot-password, sign-up, and verification-resend responses do not reveal whether an email exists (identical bodies and status codes). Better Auth already returns success for a duplicate sign-up when `requireEmailVerification` is on; verify that path and add the unverified-account overwrite from AUTH-T17. Add a dummy hash comparison on unknown-email sign-in to equalize timing.

**Acceptance criteria**
- [ ] Tests assert identical response bodies and status codes across known/unknown emails for each endpoint; a non-gating benchmark script reports timing deltas (a hard 50 ms CI assertion was rejected as flaky).

### AUTH-T71 — Dependency and code scanning

**Priority:** Low · **Estimate:** 1 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:security, phase:3, ci, security  
**Depends on:** AUTH-T06 (Update CI: typecheck, lint, format, migrations check, and tests on a Neon test branch)

Enable Dependabot (npm, weekly, grouped), `npm audit --audit-level=high` in CI, and GitHub CodeQL for JavaScript/TypeScript on PRs.

**Acceptance criteria**
- [ ] All three run on the repo; a seeded vulnerable dependency fails CI in a test PR.

### AUTH-T72 — Threat model and pre-launch security review checklist

**Priority:** Medium · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:security, phase:2, docs, security  
**Depends on:** AUTH-T26 (Parent-domain session cookie for *.northeasternsga.com); AUTH-T29 (ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products); AUTH-T35 (Authorization module with the admin/Primary Admin rule matrix)

Write `docs/THREAT_MODEL.md` (STRIDE-lite) covering: shared-cookie exposure and subdomain takeover, session fixation/replay, JWT misuse by Supabase products, admin abuse and self-escalation, PA transfer hijack, break-glass misuse, email link phishing, rate-limit bypass, Neon credential leakage. For each: mitigation and residual risk. Derive a pre-launch checklist executed in AUTH-T91.

**Acceptance criteria**
- [ ] Document reviewed by at least two team members; every residual risk has an owner or an accepted-risk note.

## E10 Observability & Audit

### AUTH-T73 — Audit event catalog, emitter, and coverage test

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:observability, phase:1, backend, audit  
**Depends on:** AUTH-T13 (Append-only AuditEvent table)

`src/lib/audit.ts`: a typed catalog (LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT, SESSION_REVOKED, SESSIONS_REVOKED, PASSWORD_RESET_REQUESTED, PASSWORD_RESET, PASSWORD_CHANGED, PASSWORD_REHASHED, EMAIL_VERIFIED, USER_CREATED, USER_INVITED, USER_DEACTIVATED, USER_REACTIVATED, USER_DELETED, ADMIN_GRANTED, ADMIN_REVOKED, POSITION_CREATED/UPDATED/DELETED/ASSIGNED/UNASSIGNED, PRODUCT_CREATED/UPDATED/DELETED, PA_TRANSFER_*, BREAK_GLASS_PA_RECOVERY, ACCOUNT_LOCKED/UNLOCKED, MFA_*, BULK_IMPORT, JWKS_ROTATED) and `audit(event)` that captures actor, IP, UA from request context and writes inside the caller's transaction when one is open. Add a test that every mutating endpoint emits at least one audit event (route table cross-checked against catalog usage).

**Acceptance criteria**
- [ ] Catalog is the single source for the DB CHECK constraint (generated migration).
- [ ] Coverage test fails when a new mutating route is added without an audit call.

### AUTH-T74 — Structured JSON logging with request IDs and redaction

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:observability, phase:1, backend, observability  
**Depends on:** AUTH-T03 (Install Better Auth 1.7 with the Prisma adapter and mount the handler)

Use `pino` (or a thin console JSON logger compatible with Vercel log drains): request id (from `x-vercel-id` or generated), route, user id (never email), latency, outcome. Redact tokens, cookies, passwords, and email bodies. Log levels by environment.

**Acceptance criteria**
- [ ] Sample production log line validated against a schema; a test asserts secrets are redacted.

### AUTH-T75 — PostHog: server-side auth funnel events and error tracking

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:observability, phase:2, observability, posthog  
**Depends on:** AUTH-T74 (Structured JSON logging with request IDs and redaction)

Integrate PostHog (free tier): server-side capture of login_succeeded/login_failed (reason category only), signup_started/completed, reset_requested/completed, mfa_enrolled, session_endpoint_error; identify by SGAuth user id only (no email/name properties). Enable PostHog error tracking on the server; on the client, load the PostHog script **only on authenticated /admin and /account pages, never on login, sign-up, reset, or verification pages** (a third-party script on a credential form is a supply-chain risk; those pages report errors via a first-party endpoint). Respect a `POSTHOG_DISABLED` flag for local/test. Add a dashboard for daily logins, failure rate, lockouts.

**Acceptance criteria**
- [ ] Events appear in PostHog from dev with no PII properties (verified by inspecting event payloads); an induced server error shows in error tracking.

### AUTH-T76 — Health endpoint and uptime monitor

**Priority:** Medium · **Estimate:** 1 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:observability, phase:1, backend, infra  
**Depends on:** AUTH-T04 (Configure Prisma 7 for Neon (pooled runtime, direct migrations)); AUTH-T29 (ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products)

`GET /api/health` returns 200 with `{ db: 'ok', jwks: 'ok', version }` after a cheap `SELECT 1` and a JWKS presence check; 503 otherwise. Configure a free external uptime monitor hitting it every 5 minutes with email alerts to the admins.

**Acceptance criteria**
- [ ] Monitor is live and alerted correctly during a deliberate 10-minute dev outage test.

### AUTH-T77 — Threshold alerts for security events

**Priority:** Low · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:observability, phase:3, backend, observability, email  
**Depends on:** AUTH-T73 (Audit event catalog, emitter, and coverage test); AUTH-T20 (Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps); AUTH-T38 (Scheduled-job runner: GitHub Actions schedules calling secret-protected routes)

A scheduled job (every 15 min via AUTH-T38) queries AuditEvent for spikes: >50 LOGIN_FAILED in 15 min, >5 ACCOUNT_LOCKED in an hour, any BREAK_GLASS_PA_RECOVERY, any PA_TRANSFER_INITIATED, JWKS rotation, job failures, Upstash fail-open events; emails all admins with a summary (deduplicated per hour).

**Acceptance criteria**
- [ ] Simulated spike triggers exactly one alert email; the same condition an hour later triggers again.

### AUTH-T78 — Retention jobs: tombstone deactivated (30 d) and inactive (12 mo) users, purge sessions and PII

**Priority:** Medium · **Estimate:** 3 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:observability, phase:3, backend, privacy, infra  
**Depends on:** AUTH-T13 (Append-only AuditEvent table); AUTH-T36 (Admin user-management endpoints); AUTH-T20 (Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps); AUTH-T38 (Scheduled-job runner: GitHub Actions schedules calling secret-protected routes)

Daily job (via AUTH-T38): (1) **tombstone** users deactivated ≥30 days ago: status DELETED, email replaced by `deleted+<id>@invalid`, name 'Deleted user', preferredName null, password/accounts/MFA/known devices/sessions/positions removed, audit PII anonymized via the gated path; the row and id are kept so product foreign keys stay valid and products render 'Deleted user' (never the PA); (2) flag users with no login for 11 months and email an inactivity notice; tombstone at 12 months if still inactive (admins and the PA are exempt and listed for manual review; holding positions does not exempt); (3) purge expired sessions, **sessions whose `createdAt` is older than 90 days (absolute cap enforcement, AUTH-T27)**, verifications, unlock tokens, and unverified sign-ups older than 7 days; (4) null IP/UA on audit rows and sessions older than 90 days. Everything logged with counts; `--dry-run` support; admin UI shows upcoming tombstones. A tombstoned email may be re-registered later as a brand-new account (new id).

**Acceptance criteria**
- [ ] Time-travel tests for each rule; PA and admins are never auto-tombstoned.
- [ ] A tombstoned user's id still resolves (status DELETED) with no PII; audit rows keep `actorUserId` but lose IP/UA/metadata PII.
- [ ] Sessions older than 90 days are gone after the job even if recently refreshed.

## E11 Integration Guides & Docs

### AUTH-T79 — ARCHITECTURE.md: Neon mandate, components, session and token flows

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:docs, phase:1, docs  
**Depends on:** AUTH-T26 (Parent-domain session cookie for *.northeasternsga.com); AUTH-T28 (Session endpoint for products: user, email, positions, admin flags); AUTH-T29 (ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products)

Write the canonical architecture document: the Neon mandate in the first paragraph ('SGAuth runs on Neon serverless Postgres and does not use Supabase for any purpose'), component diagram (Vercel app, Neon, Upstash, Resend, PostHog), request flows (login, product session lookup, Supabase token flow, logout propagation, PA transfer), data model overview, environment topology, and links to runbooks and guides. Keep it current as a living document (owner: SGAuth lead).

**Acceptance criteria**
- [ ] Doc merged at `docs/ARCHITECTURE.md` with Mermaid diagrams that render on GitHub; reviewed by the team lead.

### AUTH-T80 — Integration guide for Neon-based products (Next.js)

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:docs, phase:2, docs, sdk  
**Depends on:** AUTH-T61 (SDK documentation, example app, and versioning policy); AUTH-T34 (Non-production SSO topology: dev deployment, local hostnames, product preview domains)

`docs/integration/neon-products.md`: prerequisites (subdomain registered in the product registry), install SDK, env vars, add `proxy.ts`, read the session in server components/actions/route handlers, gate features by position keys (with a recommended per-product permission map file), key product tables by SGAuth user id (create-on-first-login pattern), link to the account page, logout, dev/preview topology, propagation/staleness, migration checklist for products with existing users, troubleshooting (cookie missing, 401 loops, origin rejected).

**Acceptance criteria**
- [ ] VaultZ integration completed by following the guide with no undocumented steps (feedback folded back in).

### AUTH-T81 — Integration guide for Supabase-backed products (third-party auth) plus the move-to-Neon alternative

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:docs, phase:3, docs, supabase, jwt  
**Depends on:** AUTH-T29 (ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products); AUTH-T60 (SDK: getAccessToken() for Supabase clients)

`docs/integration/supabase-products.md` covering, with tested snippets:
1. **Register SGAuth as a third-party auth provider** using the Supabase Management API (`POST /v1/projects/{ref}/config/auth/third-party-auth` with `oidc_issuer_url: https://auth.northeasternsga.com`, or `jwks_url`), a script `scripts/supabase-register-tpa.ts`, and how to verify (`GET` the integration, check `resolved_jwks`). Note the dashboard may not expose a generic provider; the API does.
2. **Token requirements** SGAuth satisfies: ES256, `kid`, `role: 'authenticated'`, uuid `sub`, `iss`, `exp` ≤ 10 min.
3. **Client setup**: `createClient(url, key, { accessToken: () => getAccessToken() })` server-side, and the browser proxy pattern from the SDK.
4. **RLS**: `auth.uid()` = SGAuth user id; positions via `(select auth.jwt() -> 'positions')`; helper function `has_position(text)`; examples for select/insert policies; performance wrapping.
5. **Decoupling from auth.users**: third-party users have no `auth.users` row; replace FKs/triggers with a product `users` table keyed by SGAuth id, created on first request.
6. **Limitations**: no Supabase sessions/refresh/MFA/password features for these users; JWT staleness ≤10 min; Supabase JWKS refresh ≤30 min (why rotation has a 7-day grace); billing at $0.00325 per third-party MAU beyond quota; `custom_jwks` fallback if discovery fails.
7. **Alternative**: server-side verification with `jose` against SGAuth's JWKS for products that do not need RLS.
8. **Move to Neon instead**: checklist for migrating a Supabase product's Postgres to Neon and using the standard Neon guide, recommended for any product that needs auth and does not depend on Supabase-only features (Storage, Realtime).

**Acceptance criteria**
- [ ] A throwaway Supabase project registered via the script accepts an SGAuth token and an RLS policy using `auth.uid()` and a position claim behaves as documented (recorded in the guide with a verification date).
- [ ] Guide includes the explicit limitations list and the MAU cost line.

### AUTH-T82 — Admin runbooks

**Priority:** Medium · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:docs, phase:2, docs, admin  
**Depends on:** AUTH-T37 (Primary Admin transfer flow (re-auth, recipient acceptance, 24-hour cancel window)); AUTH-T39 (Break-glass Primary Admin recovery script and runbook); AUTH-T64 (Escalating account lockout with emailed unlock and known-device exemption); AUTH-T41 (Bulk user import (CSV) with position assignment and batched invites)

`docs/runbooks/`: Primary Admin transfer (step-by-step with screenshots), break-glass recovery, unlocking a user, bulk import, position lifecycle (create/rename/retire), key and secret rotation, incident response (revoke all sessions, rotate secret, notify), onboarding a new product (registry + subdomain + SDK), semester turnover checklist.

**Acceptance criteria**
- [ ] Each runbook has been executed once on dev by someone other than its author and corrected accordingly.

### AUTH-T83 — Privacy notice and data-handling document

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:docs, phase:3, docs, privacy  
**Depends on:** AUTH-T78 (Retention jobs: tombstone deactivated (30 d) and inactive (12 mo) users, purge sessions and PII)

Public page `/privacy` and `docs/DATA_HANDLING.md`: what SGAuth stores (name, preferred name, northeastern.edu email, positions, security metadata such as IP/user agent for 90 days, audit events), why, who can see it (admins), retention (deactivated 30 days, inactive 12 months), how to request deletion, and that SGAuth stores no NUID, grades, or academic records. Note that names and positions are directory-level information and that SGA, as a student organization, is not the university's FERPA steward; keep the data set that way.

**Acceptance criteria**
- [ ] Page live and linked from the login footer; reviewed by the Primary Admin.

### AUTH-T84 — Generated SDK API reference and changelog discipline

**Priority:** Low · **Estimate:** 1 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:docs, phase:3, docs, sdk  
**Depends on:** AUTH-T61 (SDK documentation, example app, and versioning policy)

Typedoc site published to GitHub Pages from the SDK repo on release; enforce changelog entries via a CI check on PRs.

**Acceptance criteria**
- [ ] Reference site live; a PR without a changelog entry fails CI.

### AUTH-T85 — CLAUDE.md and CONTRIBUTING.md for agents and humans

**Priority:** Low · **Estimate:** 1 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:docs, phase:1, docs, chore  
**Depends on:** AUTH-T02 (Remove Supabase from the auth repo (in-place migration to Neon)); AUTH-T06 (Update CI: typecheck, lint, format, migrations check, and tests on a Neon test branch)

Document conventions for coding agents and contributors: Neon-only (no Supabase), commands (dev, test, migrate, seed), folder layout, authz and audit requirements for any new mutating route, testing expectations, commit/PR conventions (labels), and links to the design docs. Update the repo's agent definitions that reference Supabase (prisma-migration-agent, security-reviewer) to Neon.

**Acceptance criteria**
- [ ] CLAUDE.md merged; agent definitions no longer mention Supabase.

## E12 User Migration & Rollout

### AUTH-T86 — Receive the Chambers auth.users export and define the import file format

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:rollout, phase:3, migration, chambers  
**Depends on:** none

**The export itself is a manual action item owned by Eli, outside Linear** (Chambers has no Linear team): export the Chambers Supabase `auth.users` table (`id`, `email`, `encrypted_password`, `email_confirmed_at`, `last_sign_in_at`, `banned_until`) joined to `public.users` (name fields, `admin_role`, `iems_role`, `is_active`) and board memberships **before the Supabase project is deleted**, into a JSON file kept out of git. This ticket: publish the expected JSON schema and a validation script (`scripts/validate-export.ts`) that checks the file, reports row counts and a checksum, and confirms hashes look like bcrypt (`$2a$`/`$2b$`). The file is stored in the team secrets vault and deleted after import.

**Acceptance criteria**
- [ ] Schema and validator merged; the received export validates with counts matching what Eli reports from Supabase.

### AUTH-T87 — Import script: Chambers users with bcrypt hashes and position mapping

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:rollout, phase:3, migration, backend, chambers  
**Depends on:** AUTH-T86 (Receive the Chambers auth.users export and define the import file format); AUTH-T21 (Accept imported Chambers bcrypt hashes with lazy re-hash to scrypt); AUTH-T44 (Seed the curated SGA position list); AUTH-T13 (Append-only AuditEvent table)

`scripts/import-users.ts --source chambers.json --mapping chambers-positions.json --dry-run`: for each row, upsert User by lower-cased email (merge if it already exists from another import), store the bcrypt hash as `bcrypt$<hash>` in Account (only when no scrypt password exists), set `emailVerified` from `email_confirmed_at`, mark `is_active = false` users as DEACTIVATED, assign positions from an approved mapping file (Chambers roles → curated position keys), skip banned users, and write a report (created/merged/skipped with reasons) plus an id-mapping file (Supabase id → SGAuth id) for the Chambers team. Audit BULK_IMPORT. Never log hashes.

**Acceptance criteria**
- [ ] Dry run against dev reports counts; real run is idempotent (second run: 0 created).
- [ ] Sample imported user logs in with their Chambers password on dev (AUTH-T21) and holds the mapped positions.
- [ ] Mapping file approved by the Primary Admin before the production run.

### AUTH-T88 — Aplio user import (emails and names, no passwords) with invites and id mapping

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:rollout, phase:4, migration, aplio  
**Depends on:** AUTH-T87 (Import script: Chambers users with bcrypt hashes and position mapping); AUTH-T22 (Invite flow: admin-created users receive a set-password link)

Aplio users authenticated with email OTP and have no passwords. Extend the import script with `--source aplio.json` (id, email, name, isAdmin, deletedAt): upsert by email, mark as invited (set-password link) unless they already exist with a password, do not grant SGAuth admin from Aplio's `isAdmin` (product-level; APLIO-P04 maps it to a position), skip soft-deleted users, produce the id-mapping file for APLIO-P03. Accounts whose address is not northeastern.edu are imported as-is (the admin/import path bypasses the domain rule) with `legacyEmail = true`; they keep working, and an admin can later move them to the person's northeastern.edu address via AUTH-T24, preserving the SGAuth id and Aplio history. Invites are sent in batches under the mailer caps; stagger over days if needed.

**Acceptance criteria**
- [ ] Report shows created/merged counts; a sample invited user sets a password and logs in; id-mapping file delivered to the Aplio team.

### AUTH-T89 — SenatePath and Attendance Manager user import

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:rollout, phase:4, migration  
**Depends on:** AUTH-T88 (Aplio user import (emails and names, no passwords) with invites and id mapping)

Same script with `--source senatepath.json` (admin users only) and `--source attendance.json` (email, first/last, role) — NUID is NOT imported. Positions mapping files approved per product. Invites batched.

**Acceptance criteria**
- [ ] Both imports run on dev with reports; id-mapping files delivered to each team.

### AUTH-T90 — Rollout plan and user communications

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:rollout, phase:3, docs, rollout  
**Depends on:** AUTH-T80 (Integration guide for Neon-based products (Next.js)); AUTH-T87 (Import script: Chambers users with bcrypt hashes and position mapping)

Write `docs/ROLLOUT.md`: order SGAuth MVP → VaultZ → Chambers → Aplio (hard cutover) → SenatePath → Attendance Manager; per-product cutover checklist (pre-import users, registry entry, subdomain, env, SDK version, smoke test, announcement, rollback flag, support window of 3 days with a named contact); email templates announcing 'one login for all SGA tools' and, for Chambers users, that their existing password keeps working.

**Acceptance criteria**
- [ ] Plan reviewed with each product owner; dates recorded; announcement emails drafted.

### AUTH-T91 — Production launch checklist and Primary Admin bootstrap

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:rollout, phase:2, rollout, infra, security  
**Depends on:** AUTH-T72 (Threat model and pre-launch security review checklist); AUTH-T66 (Security headers (CSP, HSTS, frame, referrer)); AUTH-T76 (Health endpoint and uptime monitor); AUTH-T39 (Break-glass Primary Admin recovery script and runbook); AUTH-T64 (Escalating account lockout with emailed unlock and known-device exemption)

Execute before the first product goes live: DNS + DMARC verified; production env vars set; Neon PITR confirmed; Upstash and Resend production keys; PostHog project; uptime monitor; threat-model checklist items closed; bootstrap the first Primary Admin via a one-time script (`scripts/bootstrap-primary-admin.ts`, refuses to run if any PA exists) followed by MFA enrollment; at least two people hold break-glass credentials; backups of the curated positions; smoke test of login/logout/session endpoint from a product stub on a real subdomain.

**Acceptance criteria**
- [ ] Checklist completed and signed off in the ticket by the Primary Admin; bootstrap script left disabled afterwards.

### AUTH-T92 — Post-launch review and legacy cleanup tracking

**Priority:** Low · **Estimate:** 1 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:rollout, phase:4, rollout, docs  
**Depends on:** AUTH-T90 (Rollout plan and user communications)

Two weeks after each product cutover: review PostHog funnel and audit metrics (failed logins, lockouts, support requests), remove the bcrypt verify path once no `bcrypt$` hashes remain, and confirm each product deleted its legacy auth code and secrets. Record findings in `docs/ROLLOUT.md`.

**Acceptance criteria**
- [ ] Review notes recorded for every product; legacy-cleanup subtasks closed.

## E13 Testing & QA

### AUTH-T93 — Test harness: vitest, Neon test branch, factories, and test mailer

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 0 — Foundation · **Labels:** epic:testing, phase:0, testing, infra  
**Depends on:** AUTH-T01 (Provision the Neon project, branches, and roles for SGAuth); AUTH-T04 (Configure Prisma 7 for Neon (pooled runtime, direct migrations))

Configure vitest (node environment) with a global setup that points Prisma at the Neon `test` branch (reset from `dev` before each CI run; runs serialized by a GitHub Actions concurrency group because the 10-branch cap rules out per-run branches), applies migrations, and truncates tables between test files. Provide factories (`createUser`, `createAdmin`, `createPrimaryAdmin`, `createSession`, `createPosition`), a fake clock helper, a capturing mailer, and a fake Upstash (in-memory) limiter. Add `npm test` and coverage thresholds (80% lines on `src/lib`).

**Acceptance criteria**
- [ ] `npm test` runs locally against a personal branch and in CI against the test branch in under 5 minutes.
- [ ] Factories and fakes documented in CONTRIBUTING.md.

### AUTH-T94 — Integration tests for authentication flows

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 1 — Core auth, sessions, SSO (MVP) · **Labels:** epic:testing, phase:1, testing, auth-core  
**Depends on:** AUTH-T93 (Test harness: vitest, Neon test branch, factories, and test mailer); AUTH-T17 (Email + password sign-in and self-sign-up restricted to northeastern.edu); AUTH-T18 (Email verification for self-sign-up with resend limits); AUTH-T19 (Password reset flow); AUTH-T27 (Session lifetime: 30-day sliding, 90-day absolute cap, no cookie cache); AUTH-T64 (Escalating account lockout with emailed unlock and known-device exemption)

End-to-end (HTTP-level) tests: sign-up + verify + login; domain rejection; wrong password; lockout and unlock; forgot/reset including session revocation; invite acceptance; deactivated user; session sliding and absolute expiry; logout and sign-out-everywhere; re-auth freshness; rate-limit responses with the fake limiter.

**Acceptance criteria**
- [ ] All flows green in CI; each test asserts the expected audit events.

### AUTH-T95 — Authorization, admin, positions, and transfer integration tests

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:testing, phase:2, testing, admin  
**Depends on:** AUTH-T93 (Test harness: vitest, Neon test branch, factories, and test mailer); AUTH-T36 (Admin user-management endpoints); AUTH-T37 (Primary Admin transfer flow (re-auth, recipient acceptance, 24-hour cancel window)); AUTH-T42 (Positions CRUD: create, edit name/category, soft delete with retirement); AUTH-T43 (Position assignment endpoints (assign, unassign, bulk))

HTTP-level tests exercising the admin endpoints with the full actor/target matrix, the position lifecycle (create/rename/assign/delete/retired-key reuse), and the complete PA transfer state machine including cron execution and mid-flight recipient deactivation.

**Acceptance criteria**
- [ ] Matrix and state-machine tests pass; coverage of `authz.ts` and the transfer service ≥ 90%.

### AUTH-T96 — Playwright end-to-end SSO test across subdomains

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:testing, phase:2, testing, sso, e2e  
**Depends on:** AUTH-T34 (Non-production SSO topology: dev deployment, local hostnames, product preview domains); AUTH-T59 (SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs)); AUTH-T30 (Global logout, sign out everywhere, and admin revocation)

Spin up SGAuth and two minimal product stubs (using the SDK) on `auth.sga.localhost`, `a.sga.localhost`, `b.sga.localhost` in CI. Scenarios: login at auth → both products see the session; position assigned by an admin → product B gates a page accordingly; logout on product A → product B is logged out; expired session → redirect to login with the correct redirect param; open-redirect attempts rejected.

**Acceptance criteria**
- [ ] Playwright job green in CI with traces on failure; run time under 4 minutes.

### AUTH-T97 — JWT and JWKS conformance tests for Supabase requirements

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:testing, phase:2, testing, jwt, supabase  
**Depends on:** AUTH-T29 (ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products)

Tests: token verifies with `jose` via remote JWKS; header has `alg: ES256` and `kid`; claims include uuid `sub`, `role: 'authenticated'`, `iss`, `aud`, `exp - iat ≤ 600`; discovery document is valid; rotation keeps the old key in the JWKS for the grace period; token endpoint rejects missing/revoked sessions.

**Acceptance criteria**
- [ ] Conformance suite green; a checklist in the Supabase guide references these tests.

### AUTH-T98 — Load sanity for the session endpoint on Neon

**Priority:** Low · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:testing, phase:3, testing, performance  
**Depends on:** AUTH-T28 (Session endpoint for products: user, email, positions, admin flags); AUTH-T05 (Create the Vercel project, custom domains, environments, and Neon preview branching)

Run a k6/autocannon script against the dev deployment: 100 concurrent virtual users hitting `/api/sgauth/session` with valid cookies for 2 minutes. Record p50/p95, Neon connection count, and any pooler saturation; tune pool size and Neon compute settings; document results.

**Acceptance criteria**
- [ ] p95 < 250 ms and zero connection errors at 100 VUs; results in `docs/PERFORMANCE.md`.

---

# Team VAULTZ

## SGAuth integration — VaultZ

### VAULTZ-V01 — Install @sgaoperations/sgauth and protect all routes with the SGAuth proxy

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sgauth-integration, phase:2, sgauth, backend  
**Depends on:** AUTH-T59 (SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs)); AUTH-T80 (Integration guide for Neon-based products (Next.js)); AUTH-T34 (Non-production SSO topology: dev deployment, local hostnames, product preview domains)

Add the SDK from public npm (no registry config), env vars (`SGAUTH_URL`, `SGAUTH_COOKIE_NAME`), and `proxy.ts` using `createSgaProxy({ publicPaths: ['/api/uploadthing', '/health'] })` (cookie-presence check only; real validation in server code via `requireSession()`). Unauthenticated requests redirect to `https://auth.northeasternsga.com/login?redirect=<current URL>`. Register `https://vaultz.northeasternsga.com` (and `vaultz-dev.northeasternsga.com`) in the SGAuth product registry first.

**Acceptance criteria**
- [ ] Visiting any VaultZ page without an SGAuth session redirects to SGAuth login and back to the original page after login.
- [ ] UploadThing callback route remains reachable without a session.

### VAULTZ-V02 — Remove the shared passphrase gate

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sgauth-integration, phase:2, sgauth, backend  
**Depends on:** VAULTZ-V01 (Install @sgaoperations/sgauth and protect all routes with the SGAuth proxy)

Delete `lib/access-gate.ts`, `lib/actions/access.ts`, the passphrase page, and the `VAULTZ_ACCESS_CODE`/`VAULTZ_ACCESS_SECRET` env vars after the cutover (keep behind a `SGAUTH_ENABLED` flag for one release so rollback is a flag flip, then delete).

**Acceptance criteria**
- [ ] No references to the passphrase remain after the flag is removed; the `vaultz_access` cookie is no longer set.

### VAULTZ-V03 — Link VaultZ purchaser records to SGAuth user ids

**Priority:** Medium · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sgauth-integration, phase:2, sgauth, data  
**Depends on:** VAULTZ-V01 (Install @sgaoperations/sgauth and protect all routes with the SGAuth proxy)

VaultZ's `User` table records purchasers (first/last), not logins. Add `sgauthUserId String? @unique` and `email String?`. On first authenticated request, find-or-create the purchaser row for the session user (name from SGAuth split into first/last as a best effort, editable). Admin UI to link legacy purchaser rows to SGAuth users by email. Purchases created by the current user default `userId` to their linked row.

**Acceptance criteria**
- [ ] A first-time SGAuth user gets exactly one purchaser row; re-login does not duplicate.
- [ ] Legacy rows can be linked once and the link is unique.

### VAULTZ-V04 — Position-based permissions map for VaultZ

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sgauth-integration, phase:2, sgauth, permissions  
**Depends on:** VAULTZ-V01 (Install @sgaoperations/sgauth and protect all routes with the SGAuth proxy); AUTH-T44 (Seed the curated SGA position list)

Create `lib/permissions.ts` mapping SGAuth position keys to VaultZ capabilities (e.g. `vp-finance`, `treasurer` → manage designations/budgets/transfers; `finance-committee` → create purchases; everyone else → read-only or no access). Gate server actions and pages with `hasAnyPosition`. Permissions are decided in VaultZ, not in SGAuth; SGAuth only supplies positions. Document the map in the README and agree the keys with the curated position list.

**Acceptance criteria**
- [ ] Every mutating server action checks a capability; a user without positions cannot create or edit anything (tests).
- [ ] The map is the only place position keys appear in VaultZ code.

### VAULTZ-V05 — Account and sign-out links in the VaultZ header

**Priority:** Low · **Estimate:** 1 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sgauth-integration, phase:2, sgauth, ui  
**Depends on:** VAULTZ-V01 (Install @sgaoperations/sgauth and protect all routes with the SGAuth proxy)

Show the session user's name, a link to `accountUrl()`, and a sign-out action using `logoutUrl('https://vaultz.northeasternsga.com')`.

**Acceptance criteria**
- [ ] Sign out from VaultZ logs the user out of every SGA product (verified on dev).

### VAULTZ-V06 — Dev and preview topology for VaultZ

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sgauth-integration, phase:2, sgauth, infra  
**Depends on:** VAULTZ-V01 (Install @sgaoperations/sgauth and protect all routes with the SGAuth proxy); AUTH-T34 (Non-production SSO topology: dev deployment, local hostnames, product preview domains)

Configure the Vercel branch domain `vaultz-dev.northeasternsga.com` pointing at the dev branch with `SGAUTH_URL=https://auth-dev.northeasternsga.com` and the dev cookie name; local dev on `vaultz.sga.localhost:3001` against local SGAuth. Document in the VaultZ README.

**Acceptance criteria**
- [ ] Preview on the branch domain shares the dev SGAuth session; ad-hoc vercel.app previews show a documented 'SSO unavailable on this host' page instead of a redirect loop.

### VAULTZ-V07 — VaultZ cutover checklist and rollback

**Priority:** Medium · **Estimate:** 1 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sgauth-integration, phase:2, sgauth, rollout  
**Depends on:** VAULTZ-V02 (Remove the shared passphrase gate); VAULTZ-V04 (Position-based permissions map for VaultZ); AUTH-T91 (Production launch checklist and Primary Admin bootstrap)

Execute the per-product checklist from the rollout plan: registry entry, DNS, env vars, SDK version pinned, smoke test, announcement to finance users, `SGAUTH_ENABLED` rollback flag verified, 3-day support window.

**Acceptance criteria**
- [ ] Checklist completed; rollback rehearsed on dev by flipping the flag.

### VAULTZ-V08 — Tests for SGAuth guards and permissions in VaultZ

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 2 — Admin, Primary Admin, positions, UI, SDK, VaultZ · **Labels:** epic:sgauth-integration, phase:2, sgauth, testing  
**Depends on:** VAULTZ-V04 (Position-based permissions map for VaultZ)

Unit tests for the permissions map and integration tests (mocked SDK) for a protected page, a gated server action, and the purchaser link-on-first-login behavior.

**Acceptance criteria**
- [ ] Tests run in VaultZ CI and cover allow/deny for each capability.

---

# Team CHAMBERS

## SGAuth integration — Chambers

### CHAMBERS-C01 — Inventory every auth and authorization touchpoint in Chambers

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sgauth-integration, phase:3, sgauth, audit  
**Depends on:** none

List all uses of `getAuthedUser`, `getAuthedUserWithLiveRoles`, `hasLiveAdmin`, `app_metadata`, `is_admin()`, `is_iems()`, `my_body_ids()`, `revoke_user_sessions`, and any remaining Supabase Auth client calls (login, reset, password change) after the Neon migration. Produce a table: location → replacement (SGAuth session, position check, or Chambers-internal membership).

**Acceptance criteria**
- [ ] Inventory document merged in the Chambers repo and reviewed by the Chambers lead.

### CHAMBERS-C02 — Replace Supabase Auth with the SGAuth SDK (proxy, session helpers, login removal)

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sgauth-integration, phase:3, sgauth, backend  
**Depends on:** CHAMBERS-C01 (Inventory every auth and authorization touchpoint in Chambers); AUTH-T59 (SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs)); AUTH-T80 (Integration guide for Neon-based products (Next.js))

Install the SDK; add `proxy.ts` with public paths for kiosk/display pages (protected by `DISPLAY_KEY`), cron routes (`CRON_SECRET`), and the service worker assets; replace `lib/auth.ts`/`lib/authorization.ts` with thin wrappers over `getSession()`; delete `LoginCard`, forgot-password UI, and all `supabase.auth.*` calls; `/login` redirects to SGAuth with the current URL. Keep offline/network-retry UX for the session fetch failure case (show the existing offline message).

**Acceptance criteria**
- [ ] No `@supabase/*` auth imports remain; every previously protected route is protected by the proxy.
- [ ] Kiosk and cron routes work without a user session.

### CHAMBERS-C03 — Key Chambers users by SGAuth user id

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sgauth-integration, phase:3, sgauth, data  
**Depends on:** CHAMBERS-C02 (Replace Supabase Auth with the SGAuth SDK (proxy, session helpers, login removal)); AUTH-T87 (Import script: Chambers users with bcrypt hashes and position mapping)

Using the id-mapping file from the SGAuth import, migrate `users.id` (or add `sgauth_user_id` and repoint FKs) so the product's user row is keyed by SGAuth id; drop auth-only columns (`sessions_revoked_at`, password-related fields) and the dependency on `auth.users`. Create-on-first-login for users that exist in SGAuth but not in Chambers (e.g. self-registered students) with no memberships.

**Acceptance criteria**
- [ ] Every pre-existing Chambers user resolves to the same SGAuth user by email (verification script), and bookings history is intact.

### CHAMBERS-C04 — Map admin_role / iems_role to SGAuth positions; keep body memberships internal

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sgauth-integration, phase:3, sgauth, permissions  
**Depends on:** CHAMBERS-C02 (Replace Supabase Auth with the SGAuth SDK (proxy, session helpers, login removal)); AUTH-T44 (Seed the curated SGA position list)

Define `lib/permissions.ts`: Chambers admin capabilities derive from position keys (e.g. `chambers-admin`, `iems`, and the relevant exec positions from the curated list); board/body memberships stay in Chambers tables keyed by SGAuth user id and continue to drive booking scopes. Replace `hasLiveAdmin`/`is_admin()` checks in app code with position checks; since Chambers is on Neon, RLS helpers are replaced by app-level checks in the data layer.

**Acceptance criteria**
- [ ] Every admin-only route and action checks positions; a user whose position is removed in SGAuth loses admin ability within 60 s (SDK cache) without any Chambers-side change.
- [ ] Body-scoped booking rules unchanged (existing tests pass).

### CHAMBERS-C05 — Remove live-role-check and session-revocation mechanisms

**Priority:** Medium · **Estimate:** 3 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sgauth-integration, phase:3, sgauth, cleanup  
**Depends on:** CHAMBERS-C04 (Map admin_role / iems_role to SGAuth positions; keep body memberships internal)

Delete `getAuthedUserWithLiveRoles`, `sessions_revoked_at`, `revoke_user_sessions`, and related migrations/tests; revocation and deactivation are now SGAuth's job (admin revoke in SGAuth → 401 from the SDK). Update the user-management admin pages in Chambers to link to the SGAuth admin UI for deactivation/positions instead of local toggles.

**Acceptance criteria**
- [ ] Chambers admin UI no longer offers role toggles that SGAuth owns; links open the SGAuth user page.

### CHAMBERS-C06 — Approve the Chambers role-to-position mapping file

**Priority:** High · **Estimate:** 1 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sgauth-integration, phase:3, sgauth, migration  
**Depends on:** none

(The auth.users export is Eli's separate manual action item and is not tracked here.) Review and approve the mapping from `admin_role` / `iems_role` / board memberships to curated position keys used by the SGAuth import (AUTH-T87).

**Acceptance criteria**
- [ ] Mapping file approved by the Chambers lead and the Primary Admin.

### CHAMBERS-C07 — Chambers cutover, comms, and rollback plan

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sgauth-integration, phase:3, sgauth, rollout  
**Depends on:** CHAMBERS-C03 (Key Chambers users by SGAuth user id); CHAMBERS-C04 (Map admin_role / iems_role to SGAuth positions; keep body memberships internal); CHAMBERS-C05 (Remove live-role-check and session-revocation mechanisms); AUTH-T91 (Production launch checklist and Primary Admin bootstrap)

Per-product checklist: registry entry for chambers.northeasternsga.com, env, SDK pin, import verified (sample users log in with existing passwords), announcement that passwords carry over, rollback plan (previous deployment + Supabase auth still intact for 7 days), 3-day support window.

**Acceptance criteria**
- [ ] Cutover completed with zero password resets required for imported users beyond expected stragglers; rollback rehearsed on dev.

### CHAMBERS-C08 — Verify kiosk display key, Slack reminders, and cron routes are unaffected

**Priority:** Low · **Estimate:** 1 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sgauth-integration, phase:3, sgauth, verification  
**Depends on:** CHAMBERS-C02 (Replace Supabase Auth with the SGAuth SDK (proxy, session helpers, login removal))

Confirm the display pages, Slack bot posting, Resend flows, and GitHub-Actions-driven cron routes still work with the SGAuth proxy in place (they must be on the public path list).

**Acceptance criteria**
- [ ] Manual verification checklist completed on dev and production.

### CHAMBERS-C09 — Tests for SGAuth-based authorization in Chambers

**Priority:** Medium · **Estimate:** 3 · **Phase:** Phase 3 — Hardening, observability, Chambers · **Labels:** epic:sgauth-integration, phase:3, sgauth, testing  
**Depends on:** CHAMBERS-C04 (Map admin_role / iems_role to SGAuth positions; keep body memberships internal)

Replace tests that mocked Supabase JWT claims with tests that mock the SDK session; cover admin/iems/body-member/none for the main booking and admin routes.

**Acceptance criteria**
- [ ] Chambers CI green with the new tests; old Supabase auth tests removed.

---

# Team APLIO

## SGAuth integration — Aplio

### APLIO-P01 — Export Aplio users for the SGAuth import and receive the id mapping

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, migration  
**Depends on:** AUTH-T88 (Aplio user import (emails and names, no passwords) with invites and id mapping)

Export `User` rows (id, email, name, isAdmin, deletedAt) to JSON for the SGAuth import; receive the SGAuth id-mapping file; verify every active Aplio user maps to an SGAuth user.

**Acceptance criteria**
- [ ] Mapping verified with a script; discrepancies resolved before cutover.

### APLIO-P02 — Replace local Better Auth with the SGAuth SDK

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, backend  
**Depends on:** APLIO-P01 (Export Aplio users for the SGAuth import and receive the id mapping); AUTH-T59 (SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs)); AUTH-T80 (Integration guide for Neon-based products (Next.js))

Remove `lib/auth/config.ts` (emailOTP, rate limits), `app/api/auth/[...path]`, the OTP email template and Resend usage for OTP, the login/OTP pages, and `resolveUser`'s Better Auth branch; implement `getCurrentUser`/`getOptionalUser`/`getDeactivatedSessionUser` over the SDK. Keep Aplio's deactivation concept (`deletedAt`) as a product-level state. Drop the `Session`, `Account`, and `Verification` tables in a follow-up migration after cutover.

**Acceptance criteria**
- [ ] No `better-auth` dependency remains in Aplio; all `(auth)` routes are protected by the SGAuth proxy.
- [ ] Deactivated Aplio users still see the explanatory screen rather than a login loop.

### APLIO-P03 — Key Aplio users by SGAuth user id

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, data  
**Depends on:** APLIO-P02 (Replace local Better Auth with the SGAuth SDK)

Add `sgauthUserId String @unique` to `User`, backfill from the id-mapping file, and make all lookups go through it; create-on-first-login for new applicants (name/email from the session). Keep Aplio's own `User.id` as the FK target for the many audit relations to avoid rewriting every table. Remove `neonAuthId`.

**Acceptance criteria**
- [ ] Every existing application, answer, and email log still resolves to the right person after backfill (verification query).

### APLIO-P04 — Derive Aplio admin from an SGAuth position; managers stay product-level

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, permissions  
**Depends on:** APLIO-P02 (Replace local Better Auth with the SGAuth SDK); AUTH-T44 (Seed the curated SGA position list)

Replace `User.isAdmin` with a position check (e.g. `aplio-admin` or the relevant exec positions) in `requireAdmin`/`requireAdminOr404` and `buildReviewablePositionWhere`; position managers remain an Aplio relation. Provide a one-time script that assigns the `aplio-admin` position in SGAuth to current Aplio admins (via the SGAuth bulk assign API or CSV).

**Acceptance criteria**
- [ ] Admin pages gate on positions; the `isAdmin` column is removed after cutover.

### APLIO-P05 — Applicant flow on SGAuth accounts (northeastern.edu required)

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, product  
**Depends on:** APLIO-P02 (Replace local Better Auth with the SGAuth SDK)

Applicants now create SGAuth accounts via northeastern.edu self-sign-up with verification. Decision: every student has a northeastern.edu address, so no domain exception exists; applicants who previously used another address must use their Northeastern one. Update the apply entry points to redirect to SGAuth sign-up with a redirect back to the position, and add copy explaining the Northeastern-email requirement. Existing Aplio users with non-NU addresses are imported as legacy accounts (AUTH-T88) and keep working until an admin moves them to their NU address.

**Acceptance criteria**
- [ ] A new student can apply end-to-end: SGAuth sign-up → verify → land on the application form.
- [ ] Apply pages state the northeastern.edu requirement before the redirect.

### APLIO-P06 — Local dev bypass and preview topology

**Priority:** Low · **Estimate:** 1 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, dev  
**Depends on:** APLIO-P02 (Replace local Better Auth with the SGAuth SDK); AUTH-T34 (Non-production SSO topology: dev deployment, local hostnames, product preview domains)

Keep the dev-bypass user cookie for local only (never on any deployed host), and configure `apply-dev.northeasternsga.com` with the dev SGAuth URL and cookie name.

**Acceptance criteria**
- [ ] Bypass is a no-op on all Vercel deployments; preview branch domain shares the dev SSO session.

### APLIO-P07 — Aplio hard cutover outside an application window

**Priority:** High · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, rollout  
**Depends on:** APLIO-P03 (Key Aplio users by SGAuth user id); APLIO-P04 (Derive Aplio admin from an SGAuth position; managers stay product-level); APLIO-P05 (Applicant flow on SGAuth accounts (northeastern.edu required)); AUTH-T91 (Production launch checklist and Primary Admin bootstrap)

Schedule the cutover when no application cycle is open; users were pre-imported and invited; announce; rollback = redeploy previous release (local Better Auth tables retained for 14 days); 3-day support window.

**Acceptance criteria**
- [ ] Cutover completed; no applicant lost draft access (verified with a sample of drafts).

### APLIO-P08 — Update Aplio tests for SDK-based auth

**Priority:** Medium · **Estimate:** 3 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, testing  
**Depends on:** APLIO-P04 (Derive Aplio admin from an SGAuth position; managers stay product-level)

Replace Better Auth session mocks with SDK session mocks; cover admin, manager, applicant, deactivated, and anonymous paths for guards and scopes.

**Acceptance criteria**
- [ ] Aplio CI green; guard coverage unchanged or higher.

---

# Team SENATEPATH

## SGAuth integration — SenatePath

### SENATEPATH-S01 — Migrate SenatePath's database from Supabase to Neon

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, neon, migration  
**Depends on:** none

Create a Neon project/branches, dump and restore the Postgres schema and data (pg_dump from Supabase → psql into Neon), switch `DATABASE_URL`/`DIRECT_URL`, optionally upgrade Prisma 6 → 7 with the driver adapter, remove `@supabase/*` packages and Supabase Storage usage if any (or keep Storage only if truly needed and document it). SGAuth is Neon-only; SenatePath becomes a standard Neon product.

**Acceptance criteria**
- [ ] App runs against Neon in dev and prod; row counts match the Supabase source; no Supabase Auth code remains after S02.

### SENATEPATH-S02 — Gate the SenatePath admin area with SGAuth positions

**Priority:** High · **Estimate:** 3 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, backend  
**Depends on:** SENATEPATH-S01 (Migrate SenatePath's database from Supabase to Neon); AUTH-T59 (SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs)); AUTH-T80 (Integration guide for Neon-based products (Next.js))

Install the SDK; protect `/admin/**` with the proxy; replace the Supabase login page with a redirect to SGAuth; gate admin capabilities on a position (e.g. `elections-chair` / `senate-admin`). Public application/nomination forms remain unauthenticated as today.

**Acceptance criteria**
- [ ] Admin pages require an SGAuth session with the configured position; public forms unaffected.

### SENATEPATH-S03 — Import SenatePath admins into SGAuth and cut over

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, rollout  
**Depends on:** SENATEPATH-S02 (Gate the SenatePath admin area with SGAuth positions); AUTH-T89 (SenatePath and Attendance Manager user import)

Export admin emails for the SGAuth import; confirm they hold the gating position; run the per-product cutover checklist; delete Supabase project after a 14-day retention window.

**Acceptance criteria**
- [ ] All previous admins can log in via SGAuth; Supabase project decommissioned.

### SENATEPATH-S04 — Tests for the SGAuth admin gate

**Priority:** Low · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, testing  
**Depends on:** SENATEPATH-S02 (Gate the SenatePath admin area with SGAuth positions)

Integration tests (mocked SDK) for admin access with/without the position and for public routes.

**Acceptance criteria**
- [ ] Tests in CI cover allow/deny and public access.

---

# Team ATTENDANCE

## SGAuth integration — Attendance Manager

### ATTENDANCE-M01 — Decision: stay on Supabase (third-party auth) or move to Neon (SDK)

**Priority:** High · **Estimate:** 1 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, decision  
**Depends on:** none

Record the team's directive. Criteria: does Attendance Manager use Supabase-only features (Storage, Realtime, Edge Functions)? If not, moving to Neon is recommended (simpler, no JWT staleness, standard SDK). If yes, use the third-party auth path. Exactly one of M02 or M03 proceeds.

**Acceptance criteria**
- [ ] Decision documented in the repo README with rationale; the unused path's tickets are cancelled.

### ATTENDANCE-M02 — (Supabase path) Consume SGAuth via Supabase third-party auth

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, supabase  
**Depends on:** ATTENDANCE-M01 (Decision: stay on Supabase (third-party auth) or move to Neon (SDK)); AUTH-T81 (Integration guide for Supabase-backed products (third-party auth) plus the move-to-Neon alternative); AUTH-T60 (SDK: getAccessToken() for Supabase clients)

Follow the Supabase integration guide: register SGAuth as a third-party auth provider on the Attendance Supabase project via the Management API script; configure supabase-js with the SDK's access-token provider (server) and the proxy route (browser); replace `supabaseAuthId` with `sgauthUserId` on `User` and remove any `auth.users` FKs/triggers; rewrite RLS to `auth.uid()` and position claims (`has_position('...')`); remove Supabase login/signup pages and the custom middleware in favor of the SGAuth proxy; remove the unused `password` column. Note the ≤10-minute JWT staleness and the MAU billing line.

**Acceptance criteria**
- [ ] A user with the required position can read/write per RLS using an SGAuth token; a user without it is denied at the database.
- [ ] No `auth.users` dependency remains; Supabase login pages removed.

### ATTENDANCE-M03 — (Neon path) Migrate to Neon and integrate with the SDK

**Priority:** High · **Estimate:** 5 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, neon  
**Depends on:** ATTENDANCE-M01 (Decision: stay on Supabase (third-party auth) or move to Neon (SDK)); AUTH-T59 (SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs)); AUTH-T80 (Integration guide for Neon-based products (Next.js))

Dump/restore Postgres to Neon, switch Prisma URLs, remove `@supabase/*`, install the SDK, protect routes with the proxy, key `User` by `sgauthUserId`, and move authorization from RLS to app-level checks using positions.

**Acceptance criteria**
- [ ] App runs on Neon with SGAuth sessions; row counts match; no Supabase code remains.

### ATTENDANCE-M04 — Map roles to SGAuth positions; keep NUID product-side

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, permissions  
**Depends on:** ATTENDANCE-M01 (Decision: stay on Supabase (third-party auth) or move to Neon (SDK)); AUTH-T44 (Seed the curated SGA position list)

Define the permissions map from position keys to Attendance roles (MEMBER/OFFICER/etc.); NUID stays in Attendance's `User` table keyed by SGAuth user id and is never sent to SGAuth.

**Acceptance criteria**
- [ ] Role checks derive from positions; NUID handling unchanged and documented.

### ATTENDANCE-M05 — User import and cutover

**Priority:** Medium · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, rollout  
**Depends on:** ATTENDANCE-M04 (Map roles to SGAuth positions; keep NUID product-side); AUTH-T89 (SenatePath and Attendance Manager user import)

Export users (email, names, role) for the SGAuth import, receive the id mapping, backfill `sgauthUserId`, run the per-product cutover checklist.

**Acceptance criteria**
- [ ] All active members map to SGAuth users; cutover completed with rollback rehearsed.

### ATTENDANCE-M06 — Update auth and middleware tests

**Priority:** Low · **Estimate:** 2 · **Phase:** Phase 4 — Aplio, SenatePath, Attendance Manager, retention · **Labels:** epic:sgauth-integration, phase:4, sgauth, testing  
**Depends on:** ATTENDANCE-M04 (Map roles to SGAuth positions; keep NUID product-side)

Replace Supabase session mocks with SDK (or token) mocks in the existing auth-flow, middleware, and api-auth tests.

**Acceptance criteria**
- [ ] CI green; old Supabase auth tests removed.
