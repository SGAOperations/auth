# Contributing

## Running tests

Tests run in two Vitest projects: `unit` (`*.test.ts`, parallel, no database) and `db` (`*.db.test.ts`, one file at a time against a Neon branch).

### Setup

The `db` project deletes the rows of every table before each test file, so it must never point at a shared branch. Append-only tables such as `AuditEvent` and the Primary Admin row are left as they are (see [Files](#files)). Create a personal branch and use its URLs:

```bash
npx neonctl branches create --name dev-<you> --parent dev
```

Personal `dev-*` branches are kept by the branch hygiene job and count toward Neon's 10-branch cap. Copy the branch's pooled URL into `TEST_DATABASE_URL` and its direct URL into `TEST_DIRECT_URL` in `.env`. Use the migration-role URL for `TEST_DIRECT_URL`: the runtime role cannot delete everything, and the tests that run `down.sql` need the role that owns the tables. The harness reads only the `TEST_*` variables, refuses a value equal to `DATABASE_URL` or `DIRECT_URL`, and applies migrations itself, so there is no separate `migrate deploy` step.

### Commands

- `npm test`: both projects, with coverage.
- `npm run test:unit`: the `unit` project only. Needs no database.
- `npm run test:watch`: Vitest in watch mode.

### Files

Name tests that need no database `*.test.ts`, and database tests `*.db.test.ts`. `db` files run serially because they share one branch. Before each file the harness runs `DELETE` on every table through the migration role (`TEST_DIRECT_URL`); it never uses `TRUNCATE` and never disables a trigger. Two things survive the reset: tables guarded by a `TRUNCATE` trigger, such as the append-only `AuditEvent`, are skipped, so filter by your own ids instead of assuming an empty table; and a Primary Admin row cannot be deleted. The harness Primary Admin (`ensureHarnessPrimaryAdmin` in `src/test/harness-primary-admin.ts`) is the one committed Primary Admin: it persists across runs, and every other Primary Admin is created through `createPrimaryAdmin` inside a transaction that rolls back, as `src/test/factories.db.test.ts` does.

### Coverage

`npm test` enforces 80% line coverage on `src/lib`.

### Factories

Import from `src/test/factories.ts`. All use the app's `prisma` client.

| Factory                             | Defaults                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `createUser(overrides?)`            | Unique `@northeastern.edu` email, `emailVerified: true`, `status: "ACTIVE"`. `password` also creates the credential `Account`.                 |
| `createAdmin(overrides?)`           | `createUser` with `isAdmin: true`.                                                                                                             |
| `createPrimaryAdmin(overrides, tx)` | `createUser` with `isAdmin` and `isPrimaryAdmin`. Requires a rolled-back transaction client and displaces the harness Primary Admin inside it. |
| `createSession(user, overrides?)`   | Random token, `expiresAt` 30 days and `absoluteExpiresAt` 90 days from `Date.now()`, so a fake clock drives them.                              |
| `createPosition(overrides?)`        | Active position with a unique kebab-case `key` and a name. No holders: create `UserPosition` rows directly.                                    |

### Fakes

- `useFakeClock(start?)` in `src/test/fake-clock.ts`: fakes `Date` only, with `now`, `advance`, `set` and `restore`. The database's own `now()` is not faked, which is why `createSession` sets both expiry columns.
- `createCapturingMailer()` in `src/test/capturing-mailer.ts`: records `sendEmail({ to, template, data })` calls in `sent`, with `to(address)`, `last()` and `clear()`.
- `createFakeRateLimiter({ limit, windowMs })` in `src/test/fake-rate-limiter.ts`: in-memory sliding window with the `@upstash/ratelimit` result shape. `setUnavailable(true)` makes `limit()` reject, to test the fail-open path.

## CI and branch protection

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main` and `dev`. Seven checks are required:

- `typecheck`: `tsc --noEmit` against the generated Prisma client.
- `lint`: ESLint.
- `format`: Prettier `--check`. Run `npm run format` to fix it.
- `audit`: `npm audit --omit=dev --audit-level=high`; fails on high or critical advisories in production dependencies. The full `npm audit --audit-level=high` runs as a non-blocking step in the same job and stays informational.
- `migrations`: applies `prisma/migrations/` to a scratch Postgres and fails if `prisma/schema.prisma` differs from the result.
- `test`: runs `npm test` (the `unit` and `db` projects, with coverage) against the Neon `test` branch, which is reset to its parent (`dev`) first.
- `e2e`: Playwright SSO suite against SGAuth and two SDK product stubs on `*.sga.localhost`, using a scratch Postgres; traces are uploaded on failure.

### Running e2e locally

The suite starts SGAuth on `:3000` and the product stub twice, as `a.sga.localhost:3001` and `b.sga.localhost:3002`. It is Chromium only.

1. Add the hostnames to your hosts file, so the stubs' server-side calls to SGAuth resolve: `127.0.0.1 auth.sga.localhost a.sga.localhost b.sga.localhost`. Chromium resolves `*.localhost` on its own.
2. Set `SGAUTH_ENV=local`, `BETTER_AUTH_SECRET` (32 characters or more) and `DATABASE_URL` and `DIRECT_URL` to a personal Neon branch or a local Postgres with the migrations applied. The fixtures refuse to run for any other `SGAUTH_ENV`.
3. `npx playwright install chromium`, then `npm run e2e:build`, then `npm run e2e`.

The fixtures upsert three `@e2e.invalid` users and a position, and wipe those users' sessions and position grants on every run. SGAuth's sign-in email step allows 10 attempts per 10 minutes per IP, so restart the SGAuth server (or wait ten minutes) before running the suite twice in a row against a server you started yourself.

### Fixing a `migrations` failure

Run `npm run prisma:migrate-dev -- --name <change>` against a personal Neon branch (see [docs/MIGRATIONS.md](docs/MIGRATIONS.md)) and commit the new `prisma/migrations/` directory. Never edit a committed migration (see `docs/ENGINEERING.md` section 2); add a new one instead.

### Neon secrets for the `test` job

The `test` job needs these repository settings, all pointing at the Neon `test` branch whose parent is `dev`:

- Secrets: `NEON_API_KEY`, `NEON_TEST_DATABASE_URL` (pooled), `NEON_TEST_DIRECT_URL` (direct).
- Variable: `NEON_PROJECT_ID`.

`NEON_API_KEY` should be a project-scoped key used only for CI. It is exposed to the credential check and the branch reset step only, and the reset runs the `neonctl` version pinned in `package.json`.

Fork PRs do not receive secrets, so `test` fails on them by design.

### Serialized test runs

The `test` job runs in the `neon-test-branch` concurrency group so two PRs never share the branch mid-run. Per-run branches are not used because of Neon's 10-branch cap. GitHub keeps only one waiting run per group, so a third run cancels the waiting one; re-run the cancelled check.

### Dependency and code scanning

- Dependabot (`.github/dependabot.yml`) opens grouped PRs against `dev` every Monday, labelled `chore`. Majors outside the `nextjs`, `react` and `prisma` groups come one per PR.
- Dependabot PRs run CI with **Dependabot secrets, not Actions secrets**. `test` fails on them until `NEON_API_KEY`, `NEON_TEST_DATABASE_URL` and `NEON_TEST_DIRECT_URL` are also added under Settings → Secrets → Dependabot.
- Dependabot ignores `package.json` `overrides` (`deepmerge-ts`, `mysql2`). Remove an override by hand once its upstream pin is fixed.
- CodeQL (`.github/workflows/codeql.yml`) runs the `security-extended` suite on every PR, on every push to `dev` and `main`, and weekly. Alerts are under Security → Code scanning. It is not a required check, and code scanning "Default setup" must stay off.

### Branch protection

Changes to `main` and `dev` go through a pull request, and the seven checks above must pass. No approving review is required: the checks are the gate, and every change also goes through the pipeline's own review. Job names in `ci.yml` are the required check names, so renaming a job strands its check.

The rules live in the repository's `main/dev` ruleset (Settings → Rules → Rulesets), not in classic branch protection. A repository admin maintains it there:

- Require a pull request, with 0 required approvals and all review threads resolved.
- Require status checks to pass: `typecheck`, `lint`, `format`, `audit`, `migrations`, `test`, `e2e`. "Require branches to be up to date" is off.
- Block force pushes.

When a job is added, renamed or removed in `ci.yml`, update the ruleset's required checks in the same change. `.github/branch-protection.json` records the same check list for reference; it is not applied by any command.
