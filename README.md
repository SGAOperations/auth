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
