-- #330: which Slack channel the holders of a product role join.
--
-- Table, index and foreign keys generated from prisma/schema.prisma. The two
-- CHECKs at the end are hand-written: Prisma cannot express them. Expand-only:
-- one new table, nothing existing changes, so the code deployed while this runs
-- keeps working (docs/MIGRATIONS.md).
--
-- Reversal: run
--   npx prisma db execute --file prisma/migrations/20261106000000_slack_channel_mapping/down.sql

-- CreateTable
CREATE TABLE "SlackChannelMapping" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackChannelId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackChannelMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlackChannelMapping_positionId_slackTeamId_slackChannelId_key" ON "SlackChannelMapping"("positionId", "slackTeamId", "slackChannelId");

-- AddForeignKey
ALTER TABLE "SlackChannelMapping" ADD CONSTRAINT "SlackChannelMapping_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackChannelMapping" ADD CONSTRAINT "SlackChannelMapping_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backstops for the zod schemas in src/lib/slack/ids.ts.
ALTER TABLE "SlackChannelMapping" ADD CONSTRAINT "SlackChannelMapping_slackTeamId_check" CHECK ("slackTeamId" ~ '^T[A-Z0-9]{2,20}$');

ALTER TABLE "SlackChannelMapping" ADD CONSTRAINT "SlackChannelMapping_slackChannelId_check" CHECK ("slackChannelId" ~ '^[CG][A-Z0-9]{2,20}$');
