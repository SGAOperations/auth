# SGA Auth Manager

SGAuth is the internal single sign-on service for SGA products. It is built on [Neon](https://neon.com/) serverless Postgres and does not use Supabase for anything. How the pieces fit together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

- [Next.js 16](https://nextjs.org/) and [React 19](https://react.dev/)
- [Better Auth](https://www.better-auth.com/)
- [Prisma v7](https://www.prisma.io/) on Neon, through `@prisma/adapter-pg`
- [Tailwind CSS 4](https://tailwindcss.com/) with [shadcn/ui](https://ui.shadcn.com/)
- [Vitest](https://vitest.dev/)

## Prerequisites

- [Node.js 22](https://nodejs.org/en/download/) and npm (Vercel runs Node 22).
- A Neon account in the SGAOperations org with access to the `sgauth` project.
- Chrome or Edge, which resolve `*.localhost` natively. For other browsers, see step 9.

## Quick start

From a fresh clone to a seeded local Primary Admin takes under 15 minutes.

1. Clone the repository and create your `.env`. Do this before installing: the `postinstall` step runs `prisma generate`, which reads `DIRECT_URL`, and the example's placeholder satisfies it.

   ```sh
   git clone https://github.com/SGAOperations/auth.git
   cd auth
   cp .env.example .env
   ```

2. Install dependencies:

   ```sh
   npm ci
   ```

3. Sign in to Neon and select the `sgauth` project. The project id is under the project's Settings in the Neon console, or from `npx neonctl projects list`.

   ```sh
   npx neonctl auth
   npx neonctl set-context --project-id <id>
   ```

4. Create your personal branch from `dev`. Keep the `dev-` prefix: the branch hygiene job always keeps `dev-*` branches.

   ```sh
   npx neonctl branches create --name dev-<github-handle> --parent dev
   ```

5. Print the two connection strings for your branch:

   ```sh
   npx neonctl connection-string dev-<github-handle> --pooled --role-name runtime --database-name neondb
   npx neonctl connection-string dev-<github-handle> --role-name migration --database-name neondb
   ```

   The first is `DATABASE_URL`, the second is `DIRECT_URL`. Neon prints `sslmode=require`. Change it to `sslmode=verify-full` in both.

6. Fill in `.env`. Only these variables matter locally:

   | Variable                      | Value                                                 |
   | ----------------------------- | ----------------------------------------------------- |
   | `SGAUTH_ENV`                  | `local` (already set)                                 |
   | `DATABASE_URL`                | The pooled string from step 5                         |
   | `DIRECT_URL`                  | The direct string from step 5                         |
   | `BETTER_AUTH_SECRET`          | Output of `npx @better-auth/cli secret`               |
   | `SEED_PRIMARY_ADMIN_EMAIL`    | The email of your local Primary Admin                 |
   | `SEED_PRIMARY_ADMIN_PASSWORD` | Its password, 12 to 128 characters                    |
   | `SEED_PRIMARY_ADMIN_NAME`     | Optional display name (default `Local Primary Admin`) |

   Leave everything else empty. An empty `SGAUTH_SIGNUP_ALLOWLIST` means nobody can self-sign-up locally, which is fine: the seeded account does not sign up.

7. Apply the migrations. On an up-to-date branch this applies nothing, or only the newer migrations:

   ```sh
   npm run prisma:migrate-dev
   ```

   This refuses to run against Neon `main` or `dev`; see [docs/MIGRATIONS.md](docs/MIGRATIONS.md).

8. Seed the database:

   ```sh
   npm run seed
   ```

   The first run prints the positions summary, then the fixtures and the Primary Admin:

   ```text
   + create ... (one line per curated position)
   N curated: N create, 0 update, 0 unchanged, 0 skipped
   Dev fixtures: 2 created
   + create Primary Admin you@example.com
   + set password for you@example.com
   ```

9. Start the dev server, then open `http://auth.sga.localhost:3000` (never `localhost:3000`; see [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md#local-development)) and sign in with the seed email and password:

   ```sh
   npm run dev
   ```

   Firefox and Safari need the name-resolution steps in [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md#local-development).

   > Signing in needs email and password sign-in (#29) and the login page (AUTH-T25). Until both merge, the seeded account exists, but there is nothing to sign in with.

## Environments

Which URL, cookie name and database each environment uses, and how to run SGAuth and a product side by side locally, is in [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md). The session cookie is set on `sga.localhost`, so a product stub on `vaultz.sga.localhost:3001` shares the session (`node scripts/sso-stub.mjs`).

## Integrating a product

A Neon and Next.js product follows [docs/integration/neon-products.md](docs/integration/neon-products.md). A Supabase product gets its own guide at [docs/integration/supabase-products.md](docs/integration/supabase-products.md) (#93).

What SGAuth stores and for how long: [docs/DATA_HANDLING.md](docs/DATA_HANDLING.md).

## What `npm run seed` does

What it writes depends on `SGAUTH_ENV`:

| `SGAUTH_ENV`      | Behavior                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `production`      | Refuses before connecting. Use `npm run positions:sync` ([runbook](docs/runbooks/positions-sync.md)). |
| `dev` / `preview` | Syncs the curated positions and adds the `.invalid` dev fixtures.                                     |
| `local`           | The same, plus the local Primary Admin from `SEED_PRIMARY_ADMIN_*`.                                   |

The rules:

- It never deletes anything.
- It never overwrites an existing password. To change the seeded password, change it through the app.
- It moves Primary Admin to your email when another user held it on your branch (a branch from `dev` brings that data along).
- A re-run changes nothing.

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

## Your personal branch

- **Reset it to `dev`**, then re-apply migrations and the seed:

  ```sh
  npx neonctl branches reset dev-<github-handle> --parent
  npx prisma migrate dev
  npm run seed
  ```

- **Delete it when you leave:**

  ```sh
  npx neonctl branches delete dev-<github-handle>
  ```

- The Free plan caps the project at 10 branches, so do not create more than one.

## Scripts

| Command                        | Description                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `npm run dev`                  | Start Next.js dev server                                                             |
| `npm run build`                | Production build                                                                     |
| `npm run start`                | Start production server                                                              |
| `npm run lint`                 | Run ESLint                                                                           |
| `npm run format`               | Format code with Prettier                                                            |
| `npm run format:check`         | Check formatting without writing                                                     |
| `npm test`                     | Run the Vitest suites                                                                |
| `npm run seed`                 | Seed positions, dev fixtures and (local only) the Primary Admin                      |
| `npm run positions:sync`       | Dry-run the curated position sync; add `-- --apply` to write. Allowed in production. |
| `npm run prisma:migrate-dev`   | Guarded `prisma migrate dev`                                                         |
| `npm run prisma:migrate-reset` | Guarded `prisma migrate reset`                                                       |
| `npm run prisma:db-push`       | Guarded `prisma db push`                                                             |

## Tests

Run `npm run test:unit` for the suites that need no database. `npm test` also runs the database-backed suites (`*.db.test.ts`) and needs `TEST_DATABASE_URL` and `TEST_DIRECT_URL` pointing at your personal `dev-*` Neon branch, never `main`, `dev` or `test`. Rows are deleted from every table before each database suite (append-only tables and the Primary Admin row are left alone). See [CONTRIBUTING.md](CONTRIBUTING.md#running-tests).

## Troubleshooting

- **The first query after idle is slow.** Neon scales to zero.
- **`migrate dev` reports drift and offers to reset.** Your branch inherited a migration that a PR preview applied to Neon `dev` ([Shared pre-production database](docs/ENVIRONMENTS.md#shared-pre-production-database)). On a personal branch, accepting the reset is safe. Re-run `npm run seed` afterwards.
- **`migrate dev` fails creating the shadow database.** It needs a role allowed to create databases. The `migration` role may lack `CREATEDB`: ask in the SGA engineering channel before working around it, and do not borrow the project owner's credentials.
- **`Invalid server environment`.** The listed variable is missing or invalid in `.env`.
- **`SEED_PRIMARY_ADMIN_*: only allowed when SGAUTH_ENV=local`.** Remove the variables, or set `SGAUTH_ENV=local`.
- **`<email> exists but is DEACTIVATED`.** The seed never reactivates a user. Use another `SEED_PRIMARY_ADMIN_EMAIL`, or reactivate the user first.
- **The page loads, but sign-in does not stick.** You are on `localhost`, not `auth.sga.localhost`.

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
[docs/runbooks/neon-restore.md](docs/runbooks/neon-restore.md). All runbooks are
indexed in [docs/runbooks/README.md](docs/runbooks/README.md).

To roll SGAuth out to a product, see [docs/ROLLOUT.md](docs/ROLLOUT.md).

A daily workflow (`.github/workflows/neon-quota-monitor.yml`) emails an alert at
50%, 70%, 85% and 100% of the Free plan's monthly compute quota. For what to do
about it, see [docs/runbooks/neon-upgrade.md](docs/runbooks/neon-upgrade.md) and
the [on-call notes](docs/runbooks/on-call.md).

For CI and branch rules, see [CONTRIBUTING.md](CONTRIBUTING.md).
