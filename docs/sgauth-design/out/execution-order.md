# SGAuth execution order

Computed from the dependency graph in the ticket sources: 139 tickets, 269 blocking relations, 15 waves. Everything in a wave can start once the previous waves are done; within a wave, tickets are independent of each other and can run in parallel.

**Longest chain (15 tickets):** AUTH-T01 → AUTH-T04 → AUTH-T03 → AUTH-T10 → AUTH-T27 → AUTH-T28 → AUTH-T57 → AUTH-T58 → AUTH-T59 → AUTH-T61 → AUTH-T80 → CHAMBERS-C02 → CHAMBERS-C04 → CHAMBERS-C05 → CHAMBERS-C07. This is the schedule floor: no amount of parallel work finishes SGAuth in fewer than these steps.

## Wave 0 — 7 tickets, 17 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| AUTH-T01 | [#12](https://github.com/SGAOperations/auth/issues/12) | Urgent | 2 | Provision the Neon project, branches, and roles for SGAuth | — |
| AUTH-T02 | [#13](https://github.com/SGAOperations/auth/issues/13) | Urgent | 3 | Remove Supabase from the auth repo (in-place migration to Neon) | — |
| ATTENDANCE-M01 | (not created) | High | 1 | Decision: stay on Supabase (third-party auth) or move to Neon (SDK) | — |
| AUTH-T86 | [#98](https://github.com/SGAOperations/auth/issues/98) | High | 2 | Receive the Chambers auth.users export and define the import file format | — |
| CHAMBERS-C01 | [chambers#148](https://github.com/SGAOperations/chambers/issues/148) | High | 3 | Inventory every auth and authorization touchpoint in Chambers | — |
| CHAMBERS-C06 | [chambers#153](https://github.com/SGAOperations/chambers/issues/153) | High | 1 | Approve the Chambers role-to-position mapping file | — |
| SENATEPATH-S01 | [senate-path#88](https://github.com/SGAOperations/senate-path/issues/88) | High | 5 | Migrate SenatePath's database from Supabase to Neon | — |

## Wave 1 — 3 tickets, 5 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| AUTH-T04 | [#15](https://github.com/SGAOperations/auth/issues/15) | High | 2 | Configure Prisma 7 for Neon (pooled runtime, direct migrations) | #12 |
| AUTH-T101 | [#113](https://github.com/SGAOperations/auth/issues/113) | High | 2 | Neon Free-plan quota monitoring, alerts, and upgrade runbook | #12 |
| AUTH-T07 | [#18](https://github.com/SGAOperations/auth/issues/18) | Medium | 1 | Validate environment variables at startup with zod | #13 |

## Wave 2 — 3 tickets, 9 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| AUTH-T03 | [#14](https://github.com/SGAOperations/auth/issues/14) | Urgent | 3 | Install Better Auth 1.7 with the Prisma adapter and mount the handler | #13, #15 |
| AUTH-T20 | [#32](https://github.com/SGAOperations/auth/issues/32) | High | 3 | Email infrastructure: Resend on a dedicated SGAuth sending domain with volume caps | #18 |
| AUTH-T93 | [#105](https://github.com/SGAOperations/auth/issues/105) | High | 3 | Test harness: vitest, Neon test branch, factories, and test mailer | #12, #15 |

## Wave 3 — 7 tickets, 18 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| AUTH-T103 | [#114](https://github.com/SGAOperations/auth/issues/114) | Urgent | 2 | Scanner-safe email links: land on a page, consume the token on POST | #32 |
| AUTH-T26 | [#38](https://github.com/SGAOperations/auth/issues/38) | Urgent | 2 | Parent-domain session cookie for *.northeasternsga.com | #14 |
| AUTH-T05 | [#16](https://github.com/SGAOperations/auth/issues/16) | High | 3 | Create the Vercel project, custom domains, environments, and Neon preview branching | #12, #14 |
| AUTH-T06 | [#17](https://github.com/SGAOperations/auth/issues/17) | High | 3 | Update CI: typecheck, lint, format, migrations check, and tests on a Neon test branch | #14, #105 |
| AUTH-T10 | [#21](https://github.com/SGAOperations/auth/issues/21) | High | 3 | Core schema: User plus Better Auth Session, Account, and Verification tables | #14, #15 |
| AUTH-T63 | [#75](https://github.com/SGAOperations/auth/issues/75) | High | 3 | Upstash Redis rate limiting on auth and token endpoints | #14, #18 |
| AUTH-T74 | [#86](https://github.com/SGAOperations/auth/issues/86) | High | 2 | Structured JSON logging with request IDs and redaction | #14 |

## Wave 4 — 17 tickets, 35 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| AUTH-T104 | [#115](https://github.com/SGAOperations/auth/issues/115) | Urgent | 2 | Spike: validate cross-subdomain cookies, prefixes, and local hostnames on the real domain before building on them | #16, #38 |
| AUTH-T17 | [#29](https://github.com/SGAOperations/auth/issues/29) | Urgent | 3 | Email + password sign-in and self-sign-up restricted to northeastern.edu | #14, #21 |
| AUTH-T11 | [#22](https://github.com/SGAOperations/auth/issues/22) | High | 3 | Positions schema: Position, UserPosition, and retired keys | #21 |
| AUTH-T12 | [#24](https://github.com/SGAOperations/auth/issues/24) | High | 3 | Primary Admin invariants at the database level and the PrimaryAdminTransfer table | #21 |
| AUTH-T13 | [#25](https://github.com/SGAOperations/auth/issues/25) | High | 2 | Append-only AuditEvent table | #21 |
| AUTH-T27 | [#39](https://github.com/SGAOperations/auth/issues/39) | High | 2 | Session lifetime: 30-day sliding, 90-day absolute cap, no cookie cache | #21, #38 |
| AUTH-T34 | [#46](https://github.com/SGAOperations/auth/issues/46) | High | 3 | Non-production SSO topology: dev deployment, local hostnames, product preview domains | #16, #38 |
| AUTH-T38 | [#50](https://github.com/SGAOperations/auth/issues/50) | High | 2 | Scheduled-job runner: GitHub Actions schedules calling secret-protected routes | #16, #18 |
| AUTH-T09 | [#20](https://github.com/SGAOperations/auth/issues/20) | Medium | 2 | Automate Neon branch hygiene to stay under plan limits | #16 |
| AUTH-T14 | [#26](https://github.com/SGAOperations/auth/issues/26) | Medium | 2 | Product registry schema | #21 |
| AUTH-T15 | [#27](https://github.com/SGAOperations/auth/issues/27) | Medium | 2 | Security tables: AccountLock, UnlockToken, Jwks, TwoFactor | #21 |
| AUTH-T16 | [#28](https://github.com/SGAOperations/auth/issues/28) | Medium | 1 | Migration workflow: deploy in build, never migrate dev against production | #15, #16 |
| AUTH-T66 | [#78](https://github.com/SGAOperations/auth/issues/78) | Medium | 2 | Security headers (CSP, HSTS, frame, referrer) | #16 |
| AUTH-T68 | [#80](https://github.com/SGAOperations/auth/issues/80) | Medium | 2 | Subdomain hygiene: DNS inventory, dangling-record removal, and policy | #38 |
| AUTH-T75 | [#87](https://github.com/SGAOperations/auth/issues/87) | Medium | 2 | PostHog: server-side auth funnel events and error tracking | #86 |
| AUTH-T71 | [#83](https://github.com/SGAOperations/auth/issues/83) | Low | 1 | Dependency and code scanning | #17 |
| AUTH-T85 | [#97](https://github.com/SGAOperations/auth/issues/97) | Low | 1 | CLAUDE.md and CONTRIBUTING.md for agents and humans | #13, #17 |

## Wave 5 — 13 tickets, 36 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| AUTH-T28 | [#40](https://github.com/SGAOperations/auth/issues/40) | Urgent | 3 | Session endpoint for products: user, email, positions, admin flags | #39, #22 |
| AUTH-T35 | [#47](https://github.com/SGAOperations/auth/issues/47) | Urgent | 3 | Authorization module with the admin/Primary Admin rule matrix | #21, #24 |
| AUTH-T18 | [#30](https://github.com/SGAOperations/auth/issues/30) | High | 2 | Email verification for self-sign-up with resend limits | #29, #32, #114 |
| AUTH-T19 | [#31](https://github.com/SGAOperations/auth/issues/31) | High | 3 | Password reset flow | #29, #32, #114 |
| AUTH-T21 | [#33](https://github.com/SGAOperations/auth/issues/33) | High | 2 | Accept imported Chambers bcrypt hashes with lazy re-hash to scrypt | #29 |
| AUTH-T39 | [#51](https://github.com/SGAOperations/auth/issues/51) | High | 3 | Break-glass Primary Admin recovery script and runbook | #24, #25 |
| AUTH-T56 | [#68](https://github.com/SGAOperations/auth/issues/68) | High | 2 | Product registry service: trusted origins and redirect allowlist at runtime | #26 |
| AUTH-T64 | [#76](https://github.com/SGAOperations/auth/issues/76) | High | 5 | Escalating account lockout with emailed unlock and known-device exemption | #27, #29, #32, #114 |
| AUTH-T67 | [#79](https://github.com/SGAOperations/auth/issues/79) | High | 5 | TOTP multi-factor authentication (optional for users, required for admins and the Primary Admin) | #27, #29 |
| AUTH-T73 | [#85](https://github.com/SGAOperations/auth/issues/85) | High | 3 | Audit event catalog, emitter, and coverage test | #25 |
| AUTH-T22 | [#34](https://github.com/SGAOperations/auth/issues/34) | Medium | 2 | Password-less accounts: lazy set-password on first sign-in, plus admin invites | #32, #29, #114 |
| AUTH-T33 | [#45](https://github.com/SGAOperations/auth/issues/45) | Medium | 2 | List and revoke the user's own sessions | #39 |
| AUTH-T44 | [#56](https://github.com/SGAOperations/auth/issues/56) | Medium | 1 | Seed the curated SGA position list | #22 |

## Wave 6 — 15 tickets, 38 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| AUTH-T29 | [#41](https://github.com/SGAOperations/auth/issues/41) | High | 3 | ES256 JWTs with JWKS and OIDC discovery for Supabase-backed products | #40, #27 |
| AUTH-T30 | [#42](https://github.com/SGAOperations/auth/issues/42) | High | 2 | Global logout, sign out everywhere, and admin revocation | #38, #68 |
| AUTH-T31 | [#43](https://github.com/SGAOperations/auth/issues/43) | High | 2 | Safe post-login redirects validated against the product registry | #68 |
| AUTH-T32 | [#44](https://github.com/SGAOperations/auth/issues/44) | High | 3 | Re-authentication (sudo mode) for sensitive actions | #39, #79 |
| AUTH-T42 | [#54](https://github.com/SGAOperations/auth/issues/54) | High | 3 | Positions CRUD: create, edit name/category, soft delete with retirement | #22, #47, #25 |
| AUTH-T57 | [#69](https://github.com/SGAOperations/auth/issues/69) | High | 3 | Scaffold the @sgaoperations/sgauth package and publish pipeline (public npm) | #40 |
| AUTH-T65 | [#77](https://github.com/SGAOperations/auth/issues/77) | High | 2 | CSRF and origin enforcement across subdomains | #68, #38 |
| AUTH-T87 | [#99](https://github.com/SGAOperations/auth/issues/99) | High | 3 | Import script: Chambers users with bcrypt hashes and position mapping | #98, #33, #56, #25 |
| AUTH-T94 | [#106](https://github.com/SGAOperations/auth/issues/106) | High | 5 | Integration tests for authentication flows | #105, #29, #30, #31, #39, #76 |
| ATTENDANCE-M04 | (not created) | Medium | 2 | Map roles to SGAuth positions; keep NUID product-side | (not created), #56 |
| AUTH-T08 | [#19](https://github.com/SGAOperations/auth/issues/19) | Medium | 2 | Rewrite README and developer bootstrap for Neon branches | #21, #56 |
| AUTH-T62 | [#74](https://github.com/SGAOperations/auth/issues/74) | Medium | 2 | CORS for browser-side calls from registered products | #68, #40 |
| AUTH-T70 | [#82](https://github.com/SGAOperations/auth/issues/82) | Medium | 2 | Account-enumeration resistance and timing uniformity | #29, #31 |
| AUTH-T77 | [#89](https://github.com/SGAOperations/auth/issues/89) | Low | 2 | Threshold alerts for security events | #85, #32, #50 |
| AUTH-T98 | [#110](https://github.com/SGAOperations/auth/issues/110) | Low | 2 | Load sanity for the session endpoint on Neon | #40, #16 |

## Wave 7 — 14 tickets, 37 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| AUTH-T25 | [#37](https://github.com/SGAOperations/auth/issues/37) | High | 3 | Login, sign-up, forgot/reset, and verify pages | #29, #30, #31, #43 |
| AUTH-T36 | [#48](https://github.com/SGAOperations/auth/issues/48) | High | 5 | Admin user-management endpoints | #47, #25, #44, #34 |
| AUTH-T37 | [#49](https://github.com/SGAOperations/auth/issues/49) | High | 5 | Primary Admin transfer flow (re-auth, recipient acceptance, 24-hour cancel window) | #24, #47, #44, #32, #79, #114, #50 |
| AUTH-T43 | [#55](https://github.com/SGAOperations/auth/issues/55) | High | 3 | Position assignment endpoints (assign, unassign, bulk) | #54 |
| AUTH-T58 | [#70](https://github.com/SGAOperations/auth/issues/70) | High | 3 | SDK: getSession() with cookie forwarding and a 60-second cache | #69 |
| AUTH-T79 | [#91](https://github.com/SGAOperations/auth/issues/91) | High | 3 | ARCHITECTURE.md: Neon mandate, components, session and token flows | #38, #40, #41 |
| AUTH-T88 | [#100](https://github.com/SGAOperations/auth/issues/100) | High | 2 | Aplio user import (emails and names, no passwords) with id mapping | #99, #34 |
| AUTH-T23 | [#35](https://github.com/SGAOperations/auth/issues/35) | Medium | 2 | Change password (current password + re-auth), revoke other sessions | #29, #44 |
| AUTH-T69 | [#81](https://github.com/SGAOperations/auth/issues/81) | Medium | 1 | Secrets management and rotation procedures | #16, #41 |
| AUTH-T72 | [#84](https://github.com/SGAOperations/auth/issues/84) | Medium | 3 | Threat model and pre-launch security review checklist | #38, #41, #47 |
| AUTH-T76 | [#88](https://github.com/SGAOperations/auth/issues/88) | Medium | 1 | Health endpoint and uptime monitor | #15, #41 |
| AUTH-T97 | [#109](https://github.com/SGAOperations/auth/issues/109) | Medium | 2 | JWT and JWKS conformance tests for Supabase requirements | #41 |
| ATTENDANCE-M06 | (not created) | Low | 2 | Update auth and middleware tests | (not created) |
| AUTH-T46 | [#58](https://github.com/SGAOperations/auth/issues/58) | Low | 2 | Position history queries | #54, #85 |

## Wave 8 — 13 tickets, 32 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| APLIO-P01 | [aplio#732](https://github.com/SGAOperations/aplio/issues/732) | High | 2 | Export Aplio users for the SGAuth import and receive the id mapping | #100 |
| AUTH-T40 | [#52](https://github.com/SGAOperations/auth/issues/52) | High | 2 | Primary Admin protection tests across API and database layers | #24, #48 |
| AUTH-T47 | [#59](https://github.com/SGAOperations/auth/issues/59) | High | 3 | App shell, navigation, and route guards for /admin and /account | #37, #40 |
| AUTH-T54 | [#66](https://github.com/SGAOperations/auth/issues/66) | High | 3 | Account security page: change password, MFA enrollment, backup codes | #35, #79 |
| AUTH-T59 | [#71](https://github.com/SGAOperations/auth/issues/71) | High | 3 | SDK: Next.js helpers (proxy/middleware, requireSession, position guards, URLs) | #70 |
| AUTH-T91 | [#103](https://github.com/SGAOperations/auth/issues/103) | High | 2 | Production launch checklist and Primary Admin bootstrap | #84, #78, #88, #51, #76 |
| AUTH-T95 | [#107](https://github.com/SGAOperations/auth/issues/107) | High | 3 | Authorization, admin, positions, and transfer integration tests | #105, #48, #49, #54, #55 |
| AUTH-T41 | [#53](https://github.com/SGAOperations/auth/issues/53) | Medium | 3 | Bulk user import (CSV) with position assignment and batched invites | #48, #55 |
| AUTH-T45 | [#57](https://github.com/SGAOperations/auth/issues/57) | Medium | 2 | Position propagation tests and forced re-login | #55, #40, #41 |
| AUTH-T60 | [#72](https://github.com/SGAOperations/auth/issues/72) | Medium | 2 | SDK: getAccessToken() for Supabase clients | #70, #41 |
| AUTH-T78 | [#90](https://github.com/SGAOperations/auth/issues/90) | Medium | 3 | Retention jobs: tombstone deactivated (30 d) and inactive (12 mo) users, purge sessions and PII | #25, #48, #32, #50 |
| AUTH-T89 | [#101](https://github.com/SGAOperations/auth/issues/101) | Medium | 2 | SenatePath and SenatePortal user import | #100 |
| AUTH-T24 | [#36](https://github.com/SGAOperations/auth/issues/36) | Low | 2 | Admin-initiated email change with re-verification and privilege rules | #48, #32 |

## Wave 9 — 15 tickets, 48 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| AUTH-T48 | [#60](https://github.com/SGAOperations/auth/issues/60) | High | 5 | Admin: users list and user detail pages | #59, #48, #55 |
| AUTH-T49 | [#61](https://github.com/SGAOperations/auth/issues/61) | High | 3 | Admin: positions pages | #59, #54 |
| AUTH-T52 | [#64](https://github.com/SGAOperations/auth/issues/64) | High | 3 | Admin: Primary Admin transfer wizard, status, acceptance, and cancel pages | #59, #49 |
| AUTH-T53 | [#65](https://github.com/SGAOperations/auth/issues/65) | High | 3 | Account page: profile, positions, product links, sessions, sign out everywhere | #59, #45, #68 |
| AUTH-T81 | [#93](https://github.com/SGAOperations/auth/issues/93) | High | 5 | Integration guide for Supabase-backed products (third-party auth) plus the move-to-Neon alternative | #41, #72 |
| AUTH-T96 | [#108](https://github.com/SGAOperations/auth/issues/108) | High | 5 | Playwright end-to-end SSO test across subdomains | #46, #71, #42 |
| ATTENDANCE-M05 | (not created) | Medium | 2 | User import and cutover | (not created), #101 |
| AUTH-T105 | [#116](https://github.com/SGAOperations/auth/issues/116) | Medium | 5 | Passkeys as an optional sign-in method | #29, #44, #66, #79 |
| AUTH-T50 | [#62](https://github.com/SGAOperations/auth/issues/62) | Medium | 2 | Admin: product registry pages | #59, #68 |
| AUTH-T51 | [#63](https://github.com/SGAOperations/auth/issues/63) | Medium | 3 | Admin: audit log viewer with filters and CSV export | #59, #85 |
| AUTH-T61 | [#73](https://github.com/SGAOperations/auth/issues/73) | Medium | 2 | SDK documentation, example app, and versioning policy | #71 |
| AUTH-T82 | [#94](https://github.com/SGAOperations/auth/issues/94) | Medium | 3 | Admin runbooks | #49, #51, #76, #53 |
| AUTH-T83 | [#95](https://github.com/SGAOperations/auth/issues/95) | Medium | 2 | Privacy notice and data-handling document | #90 |
| AUTH-T100 | [#112](https://github.com/SGAOperations/auth/issues/112) | Low | 2 | Backlog: optional email OTP login (deferred due to email volume) | #103 |
| AUTH-T99 | [#111](https://github.com/SGAOperations/auth/issues/111) | Low | 3 | Spike: Northeastern Microsoft Entra ID sign-in feasibility | #103 |

## Wave 10 — 4 tickets, 11 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| ATTENDANCE-M02 | (not created) | High | 5 | (Supabase path) Consume SGAuth via Supabase third-party auth | (not created), #93, #72 |
| AUTH-T80 | [#92](https://github.com/SGAOperations/auth/issues/92) | High | 3 | Integration guide for Neon-based products (Next.js) | #73, #46 |
| AUTH-T55 | [#67](https://github.com/SGAOperations/auth/issues/67) | Medium | 2 | Accessibility, responsive, and empty/error state pass | #60, #61, #65, #66 |
| AUTH-T84 | [#96](https://github.com/SGAOperations/auth/issues/96) | Low | 1 | Generated SDK API reference and changelog discipline | #73 |

## Wave 11 — 6 tickets, 23 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| APLIO-P02 | [aplio#733](https://github.com/SGAOperations/aplio/issues/733) | High | 5 | Replace local Better Auth with the SGAuth SDK | aplio#732, #71, #92 |
| ATTENDANCE-M03 | (not created) | High | 5 | (Neon path) Migrate to Neon and integrate with the SDK | (not created), #71, #92 |
| CHAMBERS-C02 | [chambers#149](https://github.com/SGAOperations/chambers/issues/149) | High | 5 | Replace Supabase Auth with the SGAuth SDK (proxy, session helpers, login removal) | chambers#148, #71, #92 |
| SENATEPATH-S02 | [senate-path#89](https://github.com/SGAOperations/senate-path/issues/89) | High | 3 | Gate the SenatePath admin area with SGAuth positions | senate-path#88, #71, #92 |
| VAULTZ-V01 | [vaultz#747](https://github.com/SGAOperations/vaultz/issues/747) | High | 3 | Install @sgaoperations/sgauth and protect all routes with the SGAuth proxy | #71, #92, #46 |
| AUTH-T90 | [#102](https://github.com/SGAOperations/auth/issues/102) | Medium | 2 | Rollout plan and user communications | #92, #99 |

## Wave 12 — 15 tickets, 36 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| APLIO-P03 | [aplio#734](https://github.com/SGAOperations/aplio/issues/734) | High | 5 | Key Aplio users by SGAuth user id | aplio#733 |
| APLIO-P04 | [aplio#735](https://github.com/SGAOperations/aplio/issues/735) | High | 2 | Derive Aplio admin from an SGAuth position; managers stay product-level | aplio#733, #56 |
| APLIO-P05 | [aplio#736](https://github.com/SGAOperations/aplio/issues/736) | High | 3 | Applicant flow on SGAuth accounts (northeastern.edu required) | aplio#733 |
| CHAMBERS-C03 | [chambers#150](https://github.com/SGAOperations/chambers/issues/150) | High | 3 | Key Chambers users by SGAuth user id | chambers#149, #99 |
| CHAMBERS-C04 | [chambers#151](https://github.com/SGAOperations/chambers/issues/151) | High | 5 | Map admin_role / iems_role to SGAuth positions; keep body memberships internal | chambers#149, #56 |
| VAULTZ-V02 | [vaultz#748](https://github.com/SGAOperations/vaultz/issues/748) | High | 2 | Remove the shared passphrase gate | vaultz#747 |
| VAULTZ-V04 | [vaultz#750](https://github.com/SGAOperations/vaultz/issues/750) | High | 3 | Position-based permissions map for VaultZ | vaultz#747, #56 |
| SENATEPATH-S03 | [senate-path#90](https://github.com/SGAOperations/senate-path/issues/90) | Medium | 2 | Import SenatePath admins into SGAuth and cut over | senate-path#89, #101 |
| VAULTZ-V03 | [vaultz#749](https://github.com/SGAOperations/vaultz/issues/749) | Medium | 3 | Link VaultZ purchaser records to SGAuth user ids | vaultz#747 |
| VAULTZ-V06 | [vaultz#752](https://github.com/SGAOperations/vaultz/issues/752) | Medium | 2 | Dev and preview topology for VaultZ | vaultz#747, #46 |
| APLIO-P06 | [aplio#737](https://github.com/SGAOperations/aplio/issues/737) | Low | 1 | Local dev bypass and preview topology | aplio#733, #46 |
| AUTH-T92 | [#104](https://github.com/SGAOperations/auth/issues/104) | Low | 1 | Post-launch review and legacy cleanup tracking | #102 |
| CHAMBERS-C08 | [chambers#155](https://github.com/SGAOperations/chambers/issues/155) | Low | 1 | Verify kiosk display key, Slack reminders, and cron routes are unaffected | chambers#149 |
| SENATEPATH-S04 | [senate-path#91](https://github.com/SGAOperations/senate-path/issues/91) | Low | 2 | Tests for the SGAuth admin gate | senate-path#89 |
| VAULTZ-V05 | [vaultz#751](https://github.com/SGAOperations/vaultz/issues/751) | Low | 1 | Account and sign-out links in the VaultZ header | vaultz#747 |

## Wave 13 — 6 tickets, 14 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| APLIO-P07 | [aplio#738](https://github.com/SGAOperations/aplio/issues/738) | High | 2 | Aplio hard cutover outside an application window | aplio#734, aplio#735, aplio#736, #103 |
| APLIO-P08 | [aplio#739](https://github.com/SGAOperations/aplio/issues/739) | Medium | 3 | Update Aplio tests for SDK-based auth | aplio#735 |
| CHAMBERS-C05 | [chambers#152](https://github.com/SGAOperations/chambers/issues/152) | Medium | 3 | Remove live-role-check and session-revocation mechanisms | chambers#151 |
| CHAMBERS-C09 | [chambers#156](https://github.com/SGAOperations/chambers/issues/156) | Medium | 3 | Tests for SGAuth-based authorization in Chambers | chambers#151 |
| VAULTZ-V07 | [vaultz#753](https://github.com/SGAOperations/vaultz/issues/753) | Medium | 1 | VaultZ cutover checklist and rollback | vaultz#748, vaultz#750, #103 |
| VAULTZ-V08 | [vaultz#754](https://github.com/SGAOperations/vaultz/issues/754) | Medium | 2 | Tests for SGAuth guards and permissions in VaultZ | vaultz#750 |

## Wave 14 — 1 tickets, 2 points

| Ticket | Issue | Pri | Pts | Title | Blocked by |
|---|---|---|---|---|---|
| CHAMBERS-C07 | [chambers#154](https://github.com/SGAOperations/chambers/issues/154) | High | 2 | Chambers cutover, comms, and rollback plan | chambers#150, chambers#151, chambers#152, #103 |
