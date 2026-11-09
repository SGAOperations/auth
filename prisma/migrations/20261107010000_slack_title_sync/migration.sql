-- #359: when the Slack title sync last processed a token holder, and when its
-- read-back last matched what it wrote.
--
-- Matches `prisma migrate diff` from prisma/schema.prisma. Expand-only: two
-- nullable columns, nothing existing changes, so the code deployed while this
-- runs keeps working (docs/MIGRATIONS.md).
--
-- Reversal: run
--   npx prisma db execute --file prisma/migrations/20261107010000_slack_title_sync/down.sql
-- AlterTable
ALTER TABLE "SlackUserToken" ADD COLUMN     "titleCheckedAt" TIMESTAMP(3),
ADD COLUMN     "titleSyncedAt" TIMESTAMP(3);
