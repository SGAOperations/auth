-- Reverses migration.sql in this directory. No BEGIN/COMMIT: the caller controls
-- the transaction. Drops the two sync timestamps; the next run starts from a
-- clean slate, which only changes the order people are processed in.

ALTER TABLE "SlackUserToken" DROP COLUMN IF EXISTS "titleCheckedAt",
DROP COLUMN IF EXISTS "titleSyncedAt";

-- Lets a later `migrate deploy` apply the migration again cleanly.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107010000_slack_title_sync';
