# SGAuth — Claude Code project memory

## What this is

SGAuth is the single login for every SGA product on `*.northeasternsga.com`.
Sign in once at `auth.northeasternsga.com` and VaultZ, Chambers, Aplio, and
SenatePath all see the same session. Full ticket breakdown: **SGAuth
Technical Ticket Guide** — 104 `AUTH-T*` tickets across 13 epics (E1–E13)
for this repo. (The guide's own headline count is higher because it also
covers the consuming products' tickets, which don't live here.) If a ticket
and that guide disagree, the issue body wins.

That 104 is the size of the plan, not a measure of what's left — it doesn't
move as tickets close. For live progress use `/pipeline status`, or
`gh issue list --repo SGAOperations/auth --state open --label claude`;
they read the issues, which are the source of truth.

## The one hard rule

**SGAuth is built on Neon serverless Postgres and does not use Supabase for
anything.** No Supabase Auth, no Supabase database, no Supabase client
libraries, anywhere in this repo. Products that stay on Supabase can still
_consume_ SGAuth — it issues them short-lived signed JWTs — but SGAuth
itself never depends on Supabase.

## Stack

- Next.js 16 on Vercel (Node runtime)
- BetterAuth 1.7 — password login, sessions, JWT signing, two-factor, passkeys
- Neon Postgres + Prisma 7 — users, sessions, positions, audit log, product registry
- Upstash Redis — rate limiting
- Resend (separate SGAuth account) — verification/reset/lockout/transfer email
- PostHog — login funnel metrics, error tracking (never loaded on login/reset pages)
- GitHub Actions — scheduled jobs (Vercel free tier only runs cron daily)
- `@sgaoperations/sgauth` on public npm — the SDK every consuming product installs

## Environments

| Environment                               | URL                            | Database             |
| ----------------------------------------- | ------------------------------ | -------------------- |
| Production                                | `auth.northeasternsga.com`     | Neon `main`          |
| Dev (shared, DEV banner, synthetic users) | `auth-dev.northeasternsga.com` | Neon `dev`           |
| PR previews (host-only cookie)            | `*.vercel.app`                 | Per-PR Neon branch   |
| Local                                     | `auth.sga.localhost:3000`      | Personal Neon branch |

**Neon Free-plan budget: 10 branches total, 3 permanently held** (`main`,
`dev`, `test`). `AUTH-T09` cleans up daily to stay under 8. Separately,
**100 compute-hours/month suspends the whole database** — not just
previews — for the rest of the month (`AUTH-T101`). Treat any quota alert
as urgent; it's an outage risk, not a preview inconvenience.

## Conventions every route follows

- Every env var goes through `env.ts` (zod-parsed at startup) — no raw
  `process.env` elsewhere.
- Every data-changing route: an `authz.ts` `can(actor, action, target)`
  check if admin-facing, and an `audit()` call from the catalog
  (`AUTH-T73`) — a coverage test fails on a route that skips this.
- Migrations are backward-compatible: add columns first, drop in a later
  release, because the old deployment keeps serving while the new one
  rolls out.
- Passwords are scrypt, 12–128 chars. Imported Chambers passwords arrive as
  bcrypt and are lazily re-hashed on first login (`AUTH-T21`) — never
  treat bcrypt as the standing algorithm.
- Login/sign-up/reset/resend give identical responses for known vs.
  unknown emails (`AUTH-T70`) — never let an endpoint leak account
  existence.
- Emailed links never act on open — every one lands on a confirm page with
  a button, because Microsoft 365 Safe Links pre-opens every emailed link
  (`AUTH-T103`).

## Commands

```
npm run dev            # Next.js dev server
npm run build           # production build
npm run lint             # ESLint
npm run format:check     # Prettier check
npx tsc --noEmit         # typecheck
npm test                 # placeholder (exits 0) until AUTH-T93 lands Vitest
npx prisma migrate dev --create-only --name <name>   # review before applying
```

## The pipeline

This repo runs the Claude Code agent pipeline documented in each file under
`.claude/agents/` and the cockpit skill at `.claude/skills/pipeline/`. Two
gates beyond the base pipeline pattern:

- **`security sensitive`** label — a PR-level merge gate (not a dispatch
  block) for anything touching login, sessions, tokens, credential
  storage, or authorization. Requires a human `security signed off` in
  addition to `approved` before merge. `plan-agent` sets it from the plan's
  `SECURITY SENSITIVE` marker and `impl-agent` carries it onto the PR; the
  gate reads the **label**, because a PR body can be edited without review.
  See `.claude/agents/plan-agent.md` for the full trigger list.
- **Human approval** — `approved` and `security signed off` are only ever
  applied by a person, and `Approval Check` enforces it: it reads the issue
  event log and fails if an App, a bot, or the PR author applied either
  label. `review-agent`'s success state is `awaiting approval`, which a
  human promotes. Every new push strips both labels, so code added after a
  sign-off doesn't inherit it.
- **Test-execution gate** — `npm test` runs alongside lint/format/tsc/build
  and blocks the review bar the same way. It is currently a placeholder
  that exits 0; `AUTH-T93` replaces it with the real Vitest suite and the
  gate becomes meaningful then, with no pipeline change needed. Until then,
  treat a green `npm test` as "not run", not as coverage.

Start it with `/pipeline` in an interactive session running in `default`
permission mode.
