-- Reverses migration.sql in this directory. No BEGIN/COMMIT: the caller controls
-- the transaction. Drops every stored Slack user token. Postgres cannot drop an
-- enum value, so the type is rebuilt without SLACK_OAUTH, and a link made by
-- that consent is recorded as SLACK_OPENID, the nearest remaining source.

DROP TABLE IF EXISTS "SlackUserToken";

ALTER TYPE "SlackLinkSource" RENAME TO "SlackLinkSource_old";
CREATE TYPE "SlackLinkSource" AS ENUM ('SLACK_COMMAND', 'SLACK_OPENID', 'IMPORT');
ALTER TABLE "SlackIdentity" ALTER COLUMN "linkedVia" TYPE "SlackLinkSource" USING (
  CASE "linkedVia"::text WHEN 'SLACK_OAUTH' THEN 'SLACK_OPENID' ELSE "linkedVia"::text END
)::"SlackLinkSource";
DROP TYPE "SlackLinkSource_old";

-- Lets a later `migrate deploy` apply the migration again cleanly.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107000000_slack_user_token';
