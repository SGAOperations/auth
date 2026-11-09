-- Reverses migration.sql in this directory. No BEGIN/COMMIT: the caller controls
-- the transaction. Drops the submitter-position list.

DROP TABLE IF EXISTS "AccessSubmitterPosition";

-- Lets a later `migrate deploy` apply the migration again cleanly.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261106010000_access_submitter_positions';
