-- Reverses migration.sql in this directory. No BEGIN/COMMIT: the caller controls
-- the transaction.

DROP TRIGGER IF EXISTS clamp_session_expiry ON "Session";
DROP FUNCTION IF EXISTS clamp_session_expiry();

-- Lets a later `migrate deploy` apply the migration again cleanly.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021000000_session_absolute_cap';
