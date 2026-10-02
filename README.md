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

2. Copy `.env.example` to `.env` and fill in the connection strings for your personal Neon branch:

   ```sh
   cp .env.example .env
   ```

   | Variable       | Purpose                                                                    |
   | -------------- | -------------------------------------------------------------------------- |
   | `DATABASE_URL` | Pooled Postgres connection used by the application (via PgBouncer in prod) |
   | `DIRECT_URL`   | Direct Postgres connection used by Prisma for migrations                   |

   > Locally there is no connection pooling, so `DATABASE_URL` and `DIRECT_URL` will be the same.

3. Run Prisma migrations:

   ```sh
   npx prisma migrate dev
   ```

4. Start the dev server:

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
