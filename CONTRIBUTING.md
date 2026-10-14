# Contributing

## CI and branch protection

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main` and `dev`. Six checks are required:

- `typecheck`: `tsc --noEmit` against the generated Prisma client.
- `lint`: ESLint.
- `format`: Prettier `--check`. Run `npm run format` to fix it.
- `audit`: `npm audit --omit=dev --audit-level=high`; fails on high or critical advisories in production dependencies. The full `npm audit` stays informational.
- `migrations`: applies `prisma/migrations/` to a scratch Postgres and fails if `prisma/schema.prisma` differs from the result.
- `test`: runs `npm test` against the Neon `test` branch, which is reset to its parent (`dev`) first.

### Fixing a `migrations` failure

Run `npx prisma migrate dev --name <change>` locally and commit the new `prisma/migrations/` directory. Never edit a committed migration (see `docs/ENGINEERING.md` section 2); add a new one instead.

### Neon secrets for the `test` job

The `test` job needs these repository settings, all pointing at the Neon `test` branch whose parent is `dev`:

- Secrets: `NEON_API_KEY`, `NEON_TEST_DATABASE_URL` (pooled), `NEON_TEST_DIRECT_URL` (direct).
- Variable: `NEON_PROJECT_ID`.

`NEON_API_KEY` should be a project-scoped key used only for CI. It is exposed to the credential check and the branch reset step only, and the reset runs the `neonctl` version pinned in `package.json`.

Fork PRs do not receive secrets, so `test` fails on them by design.

### Serialized test runs

The `test` job runs in the `neon-test-branch` concurrency group so two PRs never share the branch mid-run. Per-run branches are not used because of Neon's 10-branch cap. GitHub keeps only one waiting run per group, so a third run cancels the waiting one; re-run the cancelled check.

### Branch protection

Changes to `main` and `dev` go through a pull request, and the six checks above must pass. No approving review is required: the checks are the gate, and every change also goes through the pipeline's own review. Job names in `ci.yml` are the required check names, so renaming a job strands its check.

The rules live in `.github/branch-protection.json`. A repository admin applies them with:

```bash
gh api --method PUT repos/SGAOperations/auth/branches/dev/protection --input .github/branch-protection.json
gh api --method PUT repos/SGAOperations/auth/branches/main/protection --input .github/branch-protection.json
```
