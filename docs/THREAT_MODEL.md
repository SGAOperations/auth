# Threat model

A STRIDE-lite threat model for SGAuth, the residual-risk register it produces, and the pre-launch checklist that [#103](https://github.com/SGAOperations/auth/issues/103) (AUTH-T91) runs. It consolidates decisions already taken in [`SGAuth-design-summary.md`](sgauth-design/SGAuth-design-summary.md) and [`SGAuth-red-team.md`](sgauth-design/SGAuth-red-team.md), grouped by threat. It adds no controls and takes no design decisions.

- **Scope.** SGAuth, plus the trust boundary it shares with products: the parent-domain session cookie, the session endpoint and the JWTs. Each product's own application security is out of scope.
- **Last reviewed:** 2026-10-24 (written; not yet reviewed, see [Review sign-off](#review-sign-off)).
- **Method.** STRIDE-lite: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege. Each threat is tagged with the letters that apply, then lists a scenario, the mitigations, the residual risk, a disposition and the checklist items derived from it.
- **Citations.** A mitigation names the GitHub issue that delivers it, with the AUTH-T id after it, as in `#38 (AUTH-T26)`; the mapping is in [`issue-map.json`](sgauth-design/issue-map.json). An accepted risk cites its red-team row, such as `red-team C1`.
- **State of the controls.** The document describes designed controls. Some are not built yet; [Known gaps](#known-gaps) lists them, so a reader knows when the checklist cannot yet pass.

## Assets and trust boundaries

Assets:

- the session cookie, `__Secure-sgauth.session_token` with `Domain=.northeasternsga.com` ([SESSION-COOKIE.md](SESSION-COOKIE.md));
- the JWT signing keys, stored in the `Jwks` table and encrypted with `BETTER_AUTH_SECRET`;
- the Neon `main` branch and its `runtime` and `migration` roles;
- the Primary Admin (PA) and admin flags;
- emailed single-use tokens (verify, reset, invite, unlock, transfer);
- the product registry;
- the Upstash, Resend and PostHog credentials.

Trust boundaries:

- browser to SGAuth;
- sibling subdomain to SGAuth;
- product server to the session endpoint;
- a product's Supabase project to the SGAuth JWKS;
- operator laptop to Neon (break-glass).

## Threats

### TM-01 Shared-cookie exposure and subdomain takeover

**STRIDE:** S, I, T

**Scenario**

- A compromised or dangling `*.northeasternsga.com` host receives every user's production cookie on every request, and its server code can read it.
- Any HTTPS subdomain can also set a same-named cookie carrying an attacker's valid session. That silently signs the victim in as the attacker (cookie tossing, login CSRF).

**Mitigations**

- `#38 (AUTH-T26)` cookie attributes: `Secure`, `HttpOnly`, `SameSite=Lax`, and no `__Host-` prefix, because browsers reject `__Host-` with a `Domain` attribute. Cookie values are signed, so another user's session cannot be forged.
- `#80 (AUTH-T68)` DNS inventory, dangling-record removal and the no-wildcard subdomain policy ([SUBDOMAIN-POLICY.md](SUBDOMAIN-POLICY.md)).
- `#68 (AUTH-T56)` product registry at runtime: no wildcard trusted origin and no `*.vercel.app`.
- `#77 (AUTH-T65)` Origin enforcement on every mutation.
- `#115 (AUTH-T104)` spike observing real cookie behaviour and tossing in three browsers. The spike has run; its go/no-go sign-off by the SGAuth lead is still a launch item (PL-02).
- `#213` refuses requests carrying duplicate session cookies, so a planted host-only or path copy beside the victim's resolves to signed out rather than to either session ([SESSION-COOKIE.md](SESSION-COOKIE.md#duplicate-session-cookies)).
- `#78 (AUTH-T66)` HSTS without `includeSubDomains`, so SGAuth does not force HTTPS-only on hosts it has not inventoried.

**Residual risk.** A subdomain SGA controls and later loses, or a host that is inventoried and compromised, still receives the cookie and can plant one. This is inherent to the parent-domain cookie decision.

**Disposition:** Accepted, red-team C1.

**Checklist:** PL-02, PL-03. The production cookie attributes are checked in [launch-checklist.md](runbooks/launch-checklist.md), section 9.

### TM-02 Session fixation and replay

**STRIDE:** S

**Scenario**

- An attacker plants a known session token before login and hopes it is honoured afterwards.
- A stolen cookie is replayed from another machine.

**Mitigations**

- Better Auth issues a fresh token at sign-in, so a pre-set token is not promoted.
- `#39 (AUTH-T27)` 30-day sliding window and 90-day absolute cap, with no cookie cache, so revocation takes effect on the next request.
- `#90 (AUTH-T78)` purge by `createdAt`, so the cap holds on Better Auth's own endpoints too (red-team B3).
- `#42 (AUTH-T30)` global logout and admin revocation.
- `#45 (AUTH-T33)` the user's own session list and revoke.
- `#44 (AUTH-T32)` re-authentication for sensitive actions.

**Residual risk.** A stolen cookie works until it is revoked or expires, because sessions are not bound to a device.

**Disposition:** Owned, SGAuth lead.

**Checklist:** PL-04, PL-05, PL-06.

### TM-03 JWT misuse by Supabase products

**STRIDE:** S, I, E

**Scenario**

- A token is stolen from a product's browser context and used until it expires.
- A signing key is compromised.
- A product's row-level security (RLS) policy trusts the token without checking positions.
- **Cross-project replay.** Every Supabase project that trusts SGAuth's issuer accepts any SGAuth token, because the audience is the shared `authenticated` value. A token minted for one product is valid at every other. RLS must therefore gate on `positions`, never on "this token was minted for us".

**Mitigations**

- `#41 (AUTH-T29)` ES256 only, `kid`, 10-minute TTL, `iss` and `aud` set, and manual key rotation with a published grace period.
- `#75 (AUTH-T63)` rate limit on the token endpoint.
- `#81 (AUTH-T69)` secrets and JWKS rotation runbook.
- `#93 (AUTH-T81)` RLS guide for Supabase-backed products, plus the `jose` fallback.

**Residual risk**

- A revoked user or a changed position is honoured by a product for up to 10 minutes.
- Cross-project replay and weak RLS are each product's to close.

**Disposition:** Accepted, red-team C3, for staleness. Owned, Product owner, for RLS correctness and cross-project replay.

**Checklist:** PL-07, PL-08, PL-09, PL-10.

### TM-04 Admin abuse and self-escalation

**STRIDE:** E, R

**Scenario**

- An admin changes their own flags or touches the Primary Admin.
- Two admins collude.
- An admin changes another admin's email, then resets that admin's password.

**Mitigations**

- `#47 (AUTH-T35)` the pure `authz.ts` rule matrix, called server-side by every handler.
- `#24 (AUTH-T12)` database backstop: a trigger and a partial unique index on the single Primary Admin.
- `#79 (AUTH-T67)` MFA required for admins and the Primary Admin.
- `#44 (AUTH-T32)` re-authentication for sensitive actions.
- `#48 (AUTH-T36)` audited admin endpoints.
- `#52 (AUTH-T40)` Primary Admin protection tests across the API and database layers.
- `#85 (AUTH-T73)` audit coverage test.
- `#36 (AUTH-T24)` email-change rules: admins change only non-admin emails, and only the Primary Admin changes an admin's email (red-team B8).

**Residual risk**

- Collusion between admins.
- `#89 (AUTH-T77)` does not alert on `ADMIN_GRANTED`. The Primary Admin therefore reviews the admin list and the `ADMIN_GRANTED` audit rows each semester.
- Any admin can strip the Primary Admin's positions. That affects product access only, never SGAuth authority, and is audited.

**Disposition:** Owned, Primary Admin. Also Accepted, red-team C5, for position stripping.

**Checklist:** PL-11, PL-12, PL-13.

### TM-05 Primary Admin transfer hijack

**STRIDE:** S, E

**Scenario**

- A hijacked Primary Admin session starts a transfer to an accomplice.
- An attacker changes the PA's email to redirect the cancel link.

**Mitigations**

- `#49 (AUTH-T37)` re-authentication, a typed recipient email, recipient MFA, a 24-hour cooling window, a cancel link consumed by POST, and every admin emailed.
- `#36 (AUTH-T24)` only the Primary Admin changes the PA's email (red-team B8).
- `#50 (AUTH-T38)` idempotent scheduled executor.

**Residual risk**

- An attacker who holds the PA's password, TOTP secret and mailbox can suppress the cancel.
- A Neon restore can rewind a completed or cancelled transfer ([neon-restore.md](runbooks/neon-restore.md)).

**Disposition:** Owned, Primary Admin.

**Checklist:** PL-14, PL-15.

### TM-06 Break-glass misuse

**STRIDE:** E, R

**Scenario.** A credential holder moves the PA flag or resets the PA's MFA outside the transfer flow.

**Mitigations**

- `#51 (AUTH-T39)` no HTTP path; the migration-role `DIRECT_URL` is required; a typed confirmation phrase; a `BREAK_GLASS` audit row; every admin emailed; a two-person rule ([break-glass.md](runbooks/break-glass.md)).
- `#89 (AUTH-T77)` threshold alert.

**Residual risk.** Whoever holds production database credentials can also bypass the audit row and the email by writing SQL directly. The session-variable gate is not a security boundary, so control of those credentials is the real control.

**Disposition:** Accepted, red-team C9. Owned, Primary Admin, with at least two named credential holders.

**Checklist:** PL-16.

### TM-07 Email link phishing

**STRIDE:** S, I

**Scenario**

- A lookalike email sends users to a fake login page.
- A mail scanner (Microsoft Safe Links) consumes a single-use link before the user clicks.
- A user confuses the dev deployment with production.

**Mitigations**

- `#32 (AUTH-T20)` a dedicated `mail.northeasternsga.com` sending domain with SPF, DKIM and DMARC `p=quarantine` ([EMAIL.md](EMAIL.md)).
- Every email links only to SGAuth's own host.
- `#114 (AUTH-T103)` the link GET renders a page and a POST consumes the token, so scanner requests have no side effect. Tokens are single-use and short-lived.
- `#46 (AUTH-T34)` persistent DEV banner and `noindex` on dev, synthetic users only (red-team A11).

**Residual risk.** Lookalike domains outside SGA's control, and DMARC is `quarantine`, not `reject`.

**Disposition:** Owned, SGAuth lead.

**Checklist:** PL-17, PL-18.

### TM-08 Rate-limit bypass

**STRIDE:** D, S

**Scenario**

- An attacker rotates IPs, or spoofs `x-forwarded-for` off Vercel, to dodge per-IP limits.
- Credential stuffing runs while Upstash is down and the limits fail open.
- An attacker locks out a known admin on purpose.

**Mitigations**

- `#75 (AUTH-T63)` sliding-window limits on mutations and the token endpoint, trusting the Vercel-supplied client IP ([RATE-LIMITING.md](RATE-LIMITING.md)).
- `#76 (AUTH-T64)` DB-backed escalating lockout with a known-device exemption (red-team A7).
- `#82 (AUTH-T70)` account-enumeration resistance.
- `#89 (AUTH-T77)` alerts on fail-open and security-event spikes.

**Residual risk**

- Low-and-slow distributed credential stuffing stays under every threshold.
- While Redis is down, only the account lockout protects sign-in.
- The per-IP limits can hit many users behind one campus NAT.

**Disposition:** Accepted, red-team A4 and A5. Owned, SGAuth lead.

**Checklist:** PL-19, PL-20, PL-21.

### TM-09 Neon credential leakage

**STRIDE:** I, T, E

**Scenario.** `DATABASE_URL` or `DIRECT_URL` leaks through logs, a preview build, CI, an operator laptop or Neon console membership.

**Mitigations**

- `#12 (AUTH-T01)` a `runtime` role with no DDL and a separate `migration` role, with `sslmode=verify-full`.
- Per-environment secrets, with dev kept separate from production (`#46 (AUTH-T34)`, [ENVIRONMENTS.md](ENVIRONMENTS.md)).
- `#86 (AUTH-T74)` log redaction.
- `#81 (AUTH-T69)` rotation procedures.
- Secrets scoped to the CI test job (`#17 (AUTH-T06)`).
- `server-only` modules and no `NEXT_PUBLIC_` secrets ([ENGINEERING.md](ENGINEERING.md) §3).

**Residual risk**

- The runtime role can still read and write every user row, password hashes included.
- A Neon restore rewinds role-password rotations ([neon-restore.md](runbooks/neon-restore.md)).

**Disposition:** Owned, Infrastructure owner.

**Checklist:** PL-22, PL-23.

## Other threats considered

These are handled elsewhere. This table points to the owner of each, so this document does not repeat it.

| Threat                                   | Handled in                                                         |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Account pre-hijack via sign-up           | red-team B2, `#29 (AUTH-T17)`                                      |
| Open redirect after login                | `#43 (AUTH-T31)`                                                   |
| Availability and single point of failure | red-team A1 and B6, `#113 (AUTH-T101)`, `SGAOperations/auth-sdk#3` |
| Third-party script on credential pages   | red-team B11, `#87 (AUTH-T75)`                                     |
| Logout CSRF                              | red-team B12, `#42 (AUTH-T30)`                                     |
| Restore rewinding auth state             | [neon-restore.md](runbooks/neon-restore.md)                        |

## Residual-risk register

Every residual risk above appears once. Owners are roles; the people who hold them are in [Role holders](#role-holders).

| ID    | Threat | Residual risk                                                                                            | Disposition                  | Owner                                                | Review trigger                            |
| ----- | ------ | -------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| RR-01 | TM-01  | A compromised or lost subdomain receives the cookie and can toss one                                     | Accepted, red-team C1        | SGAuth lead                                          | New subdomain; quarterly subdomain review |
| RR-02 | TM-02  | A stolen cookie works until revoked or expired; no device binding                                        | Owned                        | SGAuth lead                                          | Any session-handling change               |
| RR-03 | TM-03  | Revocation and position changes lag up to 10 minutes in products                                         | Accepted, red-team C3        | SGAuth lead                                          | JWT TTL change                            |
| RR-04 | TM-03  | Cross-project replay: any SGAuth token is accepted by every trusting Supabase project; weak RLS          | Owned                        | Product owner                                        | New Supabase product; key rotation        |
| RR-05 | TM-04  | Admin collusion; no `ADMIN_GRANTED` alert, so review is manual                                           | Owned                        | Primary Admin                                        | Each semester                             |
| RR-06 | TM-04  | Any admin can strip the Primary Admin's positions                                                        | Accepted, red-team C5        | Primary Admin                                        | Admin-matrix change                       |
| RR-07 | TM-05  | An attacker with the PA password, TOTP and mailbox can suppress the cancel; a restore rewinds a transfer | Owned                        | Primary Admin                                        | Each PA transfer; Neon restore            |
| RR-08 | TM-06  | Database credentials bypass audit and email by direct SQL                                                | Accepted, red-team C9        | Primary Admin and the break-glass credential holders | Credential holder change                  |
| RR-09 | TM-07  | Lookalike domains outside SGA's control; DMARC is `quarantine`                                           | Owned                        | SGAuth lead                                          | After a clean DMARC report period         |
| RR-10 | TM-08  | Low-and-slow stuffing; only lockout protects while Redis is down; campus NAT collisions                  | Accepted, red-team A4 and A5 | SGAuth lead                                          | Fail-open alert; rate-limit policy change |
| RR-11 | TM-09  | The runtime role reads and writes every user row; a restore rewinds role-password rotations              | Owned                        | Infrastructure owner                                 | Role or secret rotation; Neon restore     |

### Role holders

The people who hold each role fill this in when they review. An agent does not guess names.

| Role                 | Covers                                      | Role   | Since |
| -------------------- | ------------------------------------------- | ------ | ----- |
| SGAuth lead          | Sessions, email, rate limits, subdomains    | VP Ops | F2026 |
| Primary Admin        | Admin list, PA transfer, break-glass        | VP/IM  | F2026 |
| Infrastructure owner | Neon, Vercel, DNS, Upstash, Resend, PostHog | VP/DIM | F2026 |
| Product owner        | Each product's RLS and JWT handling         | VP/DIM | F2026 |

## Pre-launch checklist

[#103](https://github.com/SGAOperations/auth/issues/103) (AUTH-T91) runs this list as its "threat-model checklist items closed" step ([launch-checklist.md](runbooks/launch-checklist.md), section 5). It does not repeat what #103 already checks: DNS and DMARC, production environment variables, Neon history retention, Primary Admin bootstrap, and the two break-glass credential holders.

An item is closed when its check passes, or when its threat has an accepted-risk note and an owner in the register above.

The ids start at PL-02 and stay stable. PL-01, the production cookie attributes, is checked in [launch-checklist.md](runbooks/launch-checklist.md), section 9, so it is not repeated here.

- [ ] **PL-02** — The #115 (AUTH-T104) cookie spike, which has been run, has a recorded go/no-go signed off by the SGAuth lead (TM-01; verify on #115).
- [ ] **PL-03** — The DNS inventory has zero dangling records and the production registry has no wildcard origin (TM-01; verify via [runbooks/subdomain-review.md](runbooks/subdomain-review.md) and the `Product` rows).
- [ ] **PL-04** — The session token value changes across sign-in: a token present before sign-in is not the one present after (TM-02; verify in dev tools on the real domain).
- [ ] **PL-05** — After "sign out everywhere", the session endpoint returns no session from a sibling subdomain (TM-02; verify with the product smoke test, [launch-checklist.md](runbooks/launch-checklist.md) section 9).
- [ ] **PL-06** — The 90-day session purge job is scheduled and has run once (TM-02; verify via #90 and the GitHub Actions schedule).
- [ ] **PL-07** — A token decoded from `/api/auth/token` carries `alg: ES256`, a `kid`, `iss` and `aud: authenticated` (TM-03; verify via #41).
- [ ] **PL-08** — The JWKS endpoint exposes public keys only, with no `d` member (TM-03; verify via `curl` of the JWKS URL).
- [ ] **PL-09** — `/api/auth/token` returns 401 without a cookie (TM-03; verify via `curl` with no cookie).
- [ ] **PL-10** — A JWKS rotation dry run is done on dev, following the rotation runbook (TM-03; verify via #81).
- [ ] **PL-11** — The `authz.ts` tests pass with 100% branch coverage (TM-04; verify via `npm test`, #47).
- [ ] **PL-12** — An admin without MFA is denied access in production (TM-04; verify via #79).
- [ ] **PL-13** — The Primary Admin has reviewed the admin list and the `ADMIN_GRANTED` audit rows once, and the cadence is scheduled (TM-04; verify via the audit log and RR-05).
- [ ] **PL-14** — The Primary Admin transfer state-machine tests pass (TM-05; verify via `npm test`, #49 and #52).
- [ ] **PL-15** — The cancel link works end to end from the production sender (TM-05; verify with a transfer started and cancelled on dev, then a production send check).
- [ ] **PL-16** — A break-glass dry run succeeds against dev and prints the `Target:` line (TM-06; verify via [break-glass.md](runbooks/break-glass.md)).
- [ ] **PL-17** — Every email template links only to the SGAuth host (TM-07; verify via the template tests, #114).
- [ ] **PL-18** — A `HEAD` request to an emailed link does not consume its token (TM-07; verify via `curl -I` against a dev link, then use the link).
- [ ] **PL-19** — A 429 with `Retry-After` is observed on production for a rate-limited route (TM-08; verify via a burst against `sign-in`, see [RATE-LIMITING.md](RATE-LIMITING.md)).
- [ ] **PL-20** — Production Upstash keys use the `sgauth:prod:` namespace (TM-08; verify in the Upstash data browser).
- [ ] **PL-21** — A `rate-limit fail-open` event reaches the admins as an alert (TM-08; verify via #89).
- [ ] **PL-22** — The production `runtime` role cannot run DDL (TM-09; verify with `CREATE TABLE` as that role on `main`, expecting a permission error).
- [ ] **PL-23** — Neon organisation and project membership has been reviewed and each member is current (TM-09; verify in the Neon console).

## Known gaps

The controls below are cited above but their issues were open on 2026-10-25, so the checklist items that depend on them cannot pass yet.

| Issue            | Control                                        | Affects                    |
| ---------------- | ---------------------------------------------- | -------------------------- |
| `#44 (AUTH-T32)` | Re-authentication for sensitive actions        | TM-02, TM-04, TM-05        |
| `#90 (AUTH-T78)` | Session purge by `createdAt`                   | TM-02, PL-06               |
| `#81 (AUTH-T69)` | Secrets and JWKS rotation procedures           | TM-03, TM-09, PL-10        |
| `#93 (AUTH-T81)` | RLS guide for Supabase-backed products         | TM-03                      |
| `#36 (AUTH-T24)` | Admin email-change rules                       | TM-04, TM-05               |
| `#48 (AUTH-T36)` | Admin user-management endpoints                | TM-04                      |
| `#52 (AUTH-T40)` | Primary Admin protection tests                 | TM-04, PL-14               |
| `#79 (AUTH-T67)` | TOTP, required for admins                      | TM-04, TM-05, PL-12        |
| `#49 (AUTH-T37)` | Primary Admin transfer flow                    | TM-05, PL-14, PL-15        |
| `#76 (AUTH-T64)` | Escalating lockout with known-device exemption | TM-08                      |
| `#82 (AUTH-T70)` | Enumeration resistance                         | TM-08                      |
| `#89 (AUTH-T77)` | Threshold alerts                               | TM-04, TM-06, TM-08, PL-21 |
| `#87 (AUTH-T75)` | PostHog on authenticated pages only            | Other threats considered   |

## Review sign-off

The ticket's acceptance criterion is a human one: team members review this document, fill in the role holders, and confirm every residual risk has an owner or an accepted-risk note.

| Reviewer   | Role | Date     |
| ---------- | ---- | -------- |
| pataniaeli | VP   | 10/25/26 |
