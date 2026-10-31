-- Reverses migration.sql in this directory. No BEGIN/COMMIT: the caller controls
-- the transaction.

DROP TRIGGER IF EXISTS delete_passkeys_when_inactive ON "User";
DROP FUNCTION IF EXISTS delete_passkeys_when_inactive();
DROP TABLE IF EXISTS "Passkey";

-- Lets a later `migrate deploy` apply the migration again cleanly.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261102000000_passkey';
