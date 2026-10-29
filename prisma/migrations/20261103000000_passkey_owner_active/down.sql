-- Reverses migration.sql in this directory. No BEGIN/COMMIT: the caller controls
-- the transaction.

DROP TRIGGER IF EXISTS require_active_user_for_passkey ON "Passkey";
DROP FUNCTION IF EXISTS require_active_user_for_passkey();

-- Lets a later `migrate deploy` apply the migration again cleanly.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261103000000_passkey_owner_active';
