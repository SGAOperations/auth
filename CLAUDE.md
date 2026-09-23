# SGAuth — Claude Code project memory

## What this is

SGAuth is the single login for every SGA product on `*.northeasternsga.com`.
Sign in once at `auth.northeasternsga.com` and VaultZ, Chambers, Aplio, and
SenatePath all see the same session. Full ticket breakdown: **SGAuth
Technical Ticket Guide** (139 tickets across 13 epics, E1–E13). If a ticket
and that guide disagree, the issue body wins.

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
npm test                 # Vitest against the Neon test branch (AUTH-T93)
npx prisma migrate dev --create-only --name <name>   # review before applying
```

## The pipeline

This repo runs the Claude Code agent pipeline documented in each file under
`.claude/agents/` and the cockpit skill at `.claude/skills/pipeline/`. Two
gates beyond the base pipeline pattern:

- **`SECURITY SENSITIVE`** marker — a PR-level merge gate (not a dispatch
  block) for anything touching login, sessions, tokens, credential
  storage, or authorization. Requires a human `security-approve` in
  addition to `approved` before merge. See `.claude/agents/plan-agent.md`
  for the full trigger list.
- **Test-execution gate** — `npm test` blocks `approved` the same way
  lint/tsc already do; it was historically missing from the automated
  checks list and is not optional for this repo.

Start it with `/pipeline` in an interactive session running in `default`
permission mode.
