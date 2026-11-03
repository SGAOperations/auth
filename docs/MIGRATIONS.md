# Migrations

How schema changes reach each database, and the rules that keep them safe. Environments and their databases are in [ENVIRONMENTS.md](ENVIRONMENTS.md).

## Where each command runs

| Command                      | Where               | Database                                                                                                                                                      | Who                       |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `npm run prisma:migrate-dev` | Local               | Your personal Neon branch                                                                                                                                     | Developers                |
| `prisma migrate deploy`      | Vercel build        | Production builds migrate Neon `main`, and `dev` builds migrate Neon `dev`. Other branch previews skip it ([build pipeline](ENVIRONMENTS.md#build-pipeline)). | Vercel, from `DIRECT_URL` |
| `prisma migrate deploy`      | CI `migrations` job | A scratch Postgres                                                                                                                                            | GitHub Actions            |
| (none)                       | CI `test` job       | Neon `test`, reset from `dev` by CI and never migrated by hand                                                                                                | GitHub Actions            |

Developers run `migrate dev` only against personal Neon branches. Production and `dev` deployments only ever run `migrate deploy`, and no other deployment runs anything.

`DIRECT_URL` is the schema owner's credential, so it is set only where a build migrates: Vercel Production and the `dev` branch override, never Preview (all branches). Vercel cannot hide it from the running functions, so moving Production's migrations into an Environment-gated GitHub Actions job and deleting `DIRECT_URL` from Vercel is the planned follow-up ([`DIRECT_URL` at runtime](ENVIRONMENTS.md#direct_url-at-runtime)).

## The guard

`scripts/prisma-guard.mjs` refuses `migrate dev`, `migrate reset` and `db push` when any of these holds:

- `SGAUTH_ENV` is `production` or `dev`.
- The command runs on Vercel (`VERCEL_ENV` is set). Builds run `migrate deploy` only.
- `DIRECT_URL` is missing or not a valid URL. The host cannot be checked, so the guard fails closed.
- `DIRECT_URL` points at a protected Neon branch: `main` or the shared `dev`.
- `DIRECT_URL`'s host is listed in the local-only `SGAUTH_PROTECTED_DB_HOSTS` (comma-separated hosts or endpoint IDs). It can only add protection.

Two layers apply it:

- The `prisma:migrate-dev`, `prisma:migrate-reset` and `prisma:db-push` npm scripts run the guard before Prisma. Extra arguments pass through: `npm run prisma:migrate-dev -- --name <change>`.
- `prisma.config.ts` runs the same check, so a bare `npx prisma migrate dev` is refused too.

`migrate deploy`, `migrate resolve`, `migrate status`, `migrate diff`, `generate` and `studio` are never blocked, because builds and recovery need them. The guard prevents accidents. It does not stop someone deliberately pointing other tooling (`prisma db execute`, `psql`) at a protected database, so the `main` credentials stay in the password manager and Vercel.

`npm run seed` reuses the same list (`prisma/seed/guard.ts`): it refuses a `DATABASE_URL` or `DIRECT_URL` on Neon `main` whatever `SGAUTH_ENV` says, refuses Neon `dev` unless `SGAUTH_ENV=dev`, and honours `SGAUTH_PROTECTED_DB_HOSTS`.

The repository is public, so the protected endpoints are stored as SHA-256 hashes, never as IDs. To protect another endpoint, an operator adds an entry to `PROTECTED_ENDPOINTS` in `scripts/prisma-guard.mjs`: the SHA-256 hex digest of the lowercased endpoint ID, without `-pooler` or the domain. Never commit the ID itself, and never print a connection string.

## Personal branch setup

1. Create a Neon branch named `dev-<you>` from `dev`, never from `main`. The `dev-` name keeps it safe from the hygiene job (#20), and pre-production never holds production data. Neon has a 10-branch cap, so delete branches you no longer use.
2. In `.env`, put the branch's direct string (`migration` role) in `DIRECT_URL` and its pooled string (`runtime` role) in `DATABASE_URL`.
3. Set `SGAUTH_ENV=local`.

## Authoring a migration

1. Edit `prisma/schema.prisma`.
2. Run `npm run prisma:migrate-dev -- --name <change>`.
3. Commit the new `prisma/migrations/<timestamp>_<name>/` directory.

Never edit a committed migration (ENGINEERING section 2). Add a new one instead. The CI `migrations` job fails if the schema and the migrations drift apart.

## Hand-editing generated SQL

Prisma cannot express triggers, functions, CHECK constraints or partial indexes. Write them by hand in the migration:

1. Run `npm run prisma:migrate-dev -- --create-only --name <change>`. This writes the migration without applying it.
2. Edit `migration.sql`.
3. Run `npm run prisma:migrate-dev` to apply it.

`prisma/migrations/20261015010000_positions` is the worked example: the partial unique index `Position_key_active_key`, the CHECK constraints, and the trigger functions. The `///` doc comment on `Position` in `prisma/schema.prisma` records why `key` has no `@unique`.

**Review every later generated migration for a `DROP` of a hand-written object.** Prisma does not model these objects and may try to remove them. Delete such lines with `--create-only` before applying.

## Expand/contract

`migrate deploy` runs during the build while the previous deployment is still serving traffic. So every migration must work with the code that is deployed right now. Two more reasons:

- A merged migration reaches Neon `dev`, behind `auth-dev`, before production ([details](ENVIRONMENTS.md#pre-production-databases)).
- Vercel instant rollback puts older code back on the newer schema.

**Expand** steps are always safe: add tables, add nullable columns or columns with a default, add indexes.

**Contract** steps wait for a later release, once no deployed code reads the old shape: `NOT NULL` on a backfilled column, drops, type narrowing.

A rename is three releases: add the new column, dual-write and backfill, then drop the old one.

PRs carry expand steps only. A contract step merges only after the code that stops using the old shape is live in production.

| Release | Migration                                    | Code                                     |
| ------- | -------------------------------------------- | ---------------------------------------- |
| 1       | Add `x` as nullable                          | Writes `x` and the old column            |
| 2       | Set `x` `NOT NULL`, then drop the old column | Reads and writes `x` only (already live) |

## Recovery

A failed `migrate deploy` fails the build, and the previous deployment keeps serving.

- Fix it with a new migration, or run `prisma migrate resolve --rolled-back <name>` or `--applied <name>` against that environment's `DIRECT_URL`. An operator runs `resolve`. It is not guarded.
- A stray migration on Neon `dev` (one applied by a branch preview before previews stopped migrating): resolve it, or reset Neon `dev` from `main` before launch and then reset its role passwords ([rotate-secrets.md](runbooks/rotate-secrets.md#after-creating-a-branch)). See [ENVIRONMENTS.md](ENVIRONMENTS.md#pre-production-databases) and [runbooks/neon-restore.md](runbooks/neon-restore.md).
