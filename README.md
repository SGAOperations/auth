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
   | `DATABASE_URL`                  | Pooled (`-pooler`) Neon connection used at runtime                                  |
   | `DIRECT_URL`                    | Direct Neon connection used by the Prisma CLI                                       |
   | `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL (public)                                                       |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key — "Publishable" in CLI output (public)                            |
   | `SUPABASE_SERVICE_ROLE_KEY`     | Supabase service role key — "Secret" in CLI output (**never expose to the client**) |

   > A personal Neon branch has both a pooled and a direct host, so `DATABASE_URL` and `DIRECT_URL` always differ. See [Database connections](#database-connections).

4. Run Prisma migrations:

   ```sh
   npx prisma migrate dev
   ```

5. Start the dev server:

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
- **`pgbouncer=true` is not used.** It is a flag for Prisma's Rust query engine. With a driver adapter, `pg` talks to the pooler directly, and Neon's pooler supports protocol-level prepared statements.
- **`sslmode=verify-full`** is set on both URLs. Neon console strings may append `&channel_binding=require`, which is optional.

## Scripts

| Command                | Description                      |
| ---------------------- | -------------------------------- |
| `npm run dev`          | Start Next.js dev server         |
| `npm run build`        | Production build                 |
| `npm run start`        | Start production server          |
| `npm run lint`         | Run ESLint                       |
| `npm run format`       | Format code with Prettier        |
| `npm run format:check` | Check formatting without writing |
