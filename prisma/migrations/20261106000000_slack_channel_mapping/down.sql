-- Reverses migration.sql in this directory. No BEGIN/COMMIT: the caller controls
-- the transaction. Drops every role-to-channel mapping.

DROP TABLE IF EXISTS "SlackChannelMapping";

-- Lets a later `migrate deploy` apply the migration again cleanly.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261106000000_slack_channel_mapping';
