# Imported bcrypt hashes

Imported Chambers passwords stay bcrypt until each user's first SGAuth sign-in
re-hashes them to scrypt. This runbook tracks how many remain.

## Remaining hashes

Read-only. Run in the Neon SQL editor or `psql` on the read role.

```sql
SELECT u.status, count(*) AS remaining
FROM "Account" a JOIN "User" u ON u.id = a."userId"
WHERE a."providerId" = 'credential' AND a.password LIKE 'bcrypt$%'
GROUP BY u.status;
```

## Re-hash rate

```sql
SELECT date_trunc('day', "createdAt") AS day, count(*)
FROM "AuditEvent"
WHERE type = 'PASSWORD_REHASHED'
GROUP BY 1
ORDER BY 1;
```

## Removal criterion

When `remaining` is zero, or the remaining accounts are deliberately cleared so
they go through password reset, delete:

- `src/lib/auth/legacy-password.ts` and its tests
- the `password.verify` and `rehashAfterSignIn` wiring in
  `src/lib/auth/options.ts`
- the `bcryptjs` dependency
