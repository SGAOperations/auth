-- #358: the Slack user token a leader grants with `users.profile:write`, and the
-- SLACK_OAUTH link source for a Slack account linked by that consent.
--
-- Matches `prisma migrate diff` from prisma/schema.prisma. Expand-only: one new
-- table and one new enum value, nothing existing changes, so the code deployed
-- while this runs keeps working (docs/MIGRATIONS.md).
--
-- Reversal: run
--   npx prisma db execute --file prisma/migrations/20261107000000_slack_user_token/down.sql
-- AlterEnum
ALTER TYPE "SlackLinkSource" ADD VALUE 'SLACK_OAUTH' BEFORE 'IMPORT';

-- CreateTable
CREATE TABLE "SlackUserToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackUserToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlackUserToken_userId_key" ON "SlackUserToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackUserToken_slackTeamId_slackUserId_key" ON "SlackUserToken"("slackTeamId", "slackUserId");

-- AddForeignKey
ALTER TABLE "SlackUserToken" ADD CONSTRAINT "SlackUserToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
