# SGA Auth Manager

Internal authentication service

## Stack

- [React 19](https://react.dev/)
- [Next.js 16](https://nextjs.org/)
- [Prisma v7](https://www.prisma.io/)
- [Supabase](https://supabase.com/)
  - Authentication
  - Managed PostgreSQL instance
- [Tailwind CSS 4](https://tailwindcss.com/)

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Node.js & npm](https://nodejs.org/en/download/)

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Start the local Supabase stack:

   ```sh
   npx supabase start
   ```

   After starting, credentials will be printed to the console.

3. Copy `.env.example` to `.env` and fill in your Supabase credentials from the previous step:

   ```sh
   cp .env.example .env
   ```

   | Variable                        | Purpose                                                                             |
   | ------------------------------- | ----------------------------------------------------------------------------------- |
   | `DATABASE_URL`                  | Pooled Postgres connection used by the application (via PgBouncer in prod)          |
   | `DIRECT_URL`                    | Direct Postgres connection used by Prisma for migrations                            |
   | `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL (public)                                                       |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key — "Publishable" in CLI output (public)                            |
   | `SUPABASE_SERVICE_ROLE_KEY`     | Supabase service role key — "Secret" in CLI output (**never expose to the client**) |

   > Locally there is no connection pooling, so `DATABASE_URL` and `DIRECT_URL` will be the same.

4. Run Prisma migrations:

   ```sh
   npx prisma migrate dev
   ```

5. Start the dev server:

   ```sh
   npm run dev
   ```

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

> The Supabase stack entry, the Docker prerequisite, the `npx supabase start`
> step, and the Supabase variables above are the old scaffold. They are being
> removed in #13 (AUTH-T02). Do not run them or follow them.

The Neon project is `sgauth` (`aws-us-east-1`) with three permanent branches:

| Branch | Purpose                          |
| ------ | -------------------------------- |
| `main` | Production                       |
| `dev`  | Shared non-production deployment |
| `test` | CI integration tests             |

Preview and personal branches are created on top of these. The Free plan caps a
project at 10 branches, so the three above are the permanent baseline.

Two database roles exist: a **runtime** role (DML only, no DDL) used by
`DATABASE_URL`, and a **migration** role (owns the schema, DDL) used by
`DIRECT_URL` for `prisma migrate deploy`. `DATABASE_URL` is the pooled
connection (host contains `-pooler`), `DIRECT_URL` is the direct one, and both
use `sslmode=verify-full`. Credentials live in Vercel env and the team password
manager, never in git. Pooled vs. direct handling under Prisma is settled in
AUTH-T04.

To restore `main` to an earlier point in time, see
[docs/runbooks/neon-restore.md](docs/runbooks/neon-restore.md).
