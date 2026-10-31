-- Reverses migration.sql in this directory. No BEGIN/COMMIT: the caller controls
-- the transaction. Drops every Slack link and product key.

DROP TABLE IF EXISTS "SlackLinkToken";
DROP TABLE IF EXISTS "SlackIdentity";
DROP TABLE IF EXISTS "ProductApiKey";
DROP TYPE IF EXISTS "SlackLinkSource";

-- Lets a later `migrate deploy` apply the migration again cleanly.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261105000000_slack_identity';
