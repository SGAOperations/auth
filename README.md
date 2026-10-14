# SGA Auth Manager

Internal authentication service

## Stack

- [React 19](https://react.dev/)
- [Next.js 16](https://nextjs.org/)
- [Prisma v7](https://www.prisma.io/)
- [Tailwind CSS 4](https://tailwindcss.com/)

## Prerequisites

- [Node.js & npm](https://nodejs.org/en/download/)

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in every variable `.env.example` marks as required, starting with the connection strings for your personal Neon branch. Generate `BETTER_AUTH_SECRET` with `npx @better-auth/cli secret`. The app refuses to start with a missing or invalid variable and names each one.

   ```sh
   cp .env.example .env
   ```

   | Variable       | Purpose                                            |
   | -------------- | -------------------------------------------------- |
   | `DATABASE_URL` | Pooled (`-pooler`) Neon connection used at runtime |
   | `DIRECT_URL`   | Direct Neon connection used by the Prisma CLI      |

   > A personal Neon branch has both a pooled and a direct host, so `DATABASE_URL` and `DIRECT_URL` always differ. `DATABASE_URL` is pooled and uses the `runtime` role, `DIRECT_URL` is direct and uses the `migration` role. See [Database connections](#database-connections) and [Database — Neon](#database--neon).

3. Run Prisma migrations:

   ```sh
   npx prisma migrate dev
   ```

4. Start the dev server:

   ```sh
   npm run dev
   ```

## Database connections

Neon exposes two hosts per branch, so the app needs two connection strings.

- **Why two URLs.** The Prisma CLI needs a session-level connection for migrations (advisory locks, DDL), and Neon's PgBouncer runs in transaction mode. Serverless runtime traffic goes through the pooler so many short-lived Vercel instances don't exhaust Postgres connections.

  | Variable       | Host                        | Used by                                                                                                      |
  | -------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | `DATABASE_URL` | Pooled (host has `-pooler`) | The running app (`src/lib/prisma.ts`) and `prisma/seed.ts`                                                   |
  | `DIRECT_URL`   | Direct (no `-pooler`)       | The Prisma CLI via `prisma.config.ts`: `migrate dev`, `migrate deploy`, `migrate reset`, `db push`, `studio` |

- **Driver adapter.** The runtime client uses `@prisma/adapter-pg` (TCP) with a pool of `max: 5`, a 10 s idle timeout and a 5 s connect timeout per function instance. `@prisma/adapter-neon` was not chosen because SGAuth runs on the Vercel Node runtime, not Edge, so no WebSocket transport is needed.
- **`pgbouncer=true` is not used.** It is a flag for Prisma's Rust query engine. With a driver adapter, `pg` is expected to talk to the pooler directly, and Neon's pooler is expected to support protocol-level prepared statements. Not yet verified against a live Neon branch.
- **`sslmode=verify-full`** is expected on both URLs. Neon console strings may append `&channel_binding=require`, which is optional. Not yet verified against a live Neon branch.

## Scripts

| Command                | Description                      |
| ---------------------- | -------------------------------- |
| `npm run dev`          | Start Next.js dev server         |
| `npm run build`        | Production build                 |
| `npm run start`        | Start production server          |
| `npm run lint`         | Run ESLint                       |
| `npm run format`       | Format code with Prettier        |
| `npm run format:check` | Check formatting without writing |

## Database — Neon

SGAuth is built on [Neon](https://neon.com/) serverless Postgres and **does not
use Supabase for anything**: no Supabase Auth, no Supabase database, and no
Supabase client libraries, anywhere in SGAuth. This section describes the
target state.

The Neon project is `sgauth` (`aws-us-east-1`) with three permanent branches:

| Branch | Purpose                          |
| ------ | -------------------------------- |
| `main` | Production                       |
| `dev`  | Shared non-production deployment |
| `test` | CI integration tests             |

Preview and personal branches are created on top of these. The Free plan caps a
project at 10 branches, so the three above are the permanent baseline.

Two database roles exist in the `neondb` database: `runtime` (DML only, no DDL)
used by `DATABASE_URL`, and `migration` (owns the schema, DDL) used by
`DIRECT_URL` for `prisma migrate deploy`. `DATABASE_URL` is the pooled
connection (host contains `-pooler`), `DIRECT_URL` is the direct one, and both
use `sslmode=verify-full`. Credentials live in Vercel env and the team password
manager, never in git. Pooled vs. direct handling under Prisma is settled in
AUTH-T04.

To restore `main` to an earlier point in time, see
[docs/runbooks/neon-restore.md](docs/runbooks/neon-restore.md).
