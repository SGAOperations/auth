-- Reverses migration.sql in this directory. No BEGIN/COMMIT: the caller controls
-- the transaction. Revert the schema.prisma change after running it.

DROP TRIGGER primary_admin_must_exist ON "User";
DROP TRIGGER protect_primary_admin ON "User";
DROP FUNCTION require_primary_admin();
DROP FUNCTION protect_primary_admin();
DROP INDEX one_primary_admin;

-- Removes the table's indexes (including one_in_flight_primary_admin_transfer),
-- constraints and foreign keys with it.
DROP TABLE "PrimaryAdminTransfer";
DROP TYPE "PrimaryAdminTransferStatus";

-- Lets a later `migrate deploy` apply the migration again cleanly.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261016000000_primary_admin_invariants';
