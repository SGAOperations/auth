-- #339: requests for access to an external product, made from Slack (epic #338).
--
-- Table, indexes and foreign key written by hand to match Prisma's output for
-- prisma/schema.prisma, and verified by the CI migrations drift check. The three
-- CHECKs at the end are hand-written: Prisma cannot express them. Expand-only:
-- one new table, nothing existing changes, so the code deployed while this runs
-- keeps working (docs/MIGRATIONS.md).
--
-- Reversal: run
--   npx prisma db execute --file prisma/migrations/20261106010000_access_request/down.sql

-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT,
    "positionKey" TEXT NOT NULL,
    "positionName" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessRequest_createdAt_idx" ON "AccessRequest"("createdAt");

-- CreateIndex
CREATE INDEX "AccessRequest_requesterId_idx" ON "AccessRequest"("requesterId");

-- AddForeignKey
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backstops for the zod schema built from src/lib/access-requests/limits.ts.
-- The numbers below mirror ACCESS_REQUEST_LIMITS.
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_product_length_check" CHECK (char_length("product") <= 100 AND char_length(btrim("product")) >= 1);

ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_access_length_check" CHECK (char_length("access") <= 500 AND char_length(btrim("access")) >= 1);

ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_position_snapshot_check" CHECK (char_length(btrim("positionKey")) >= 1 AND char_length(btrim("positionName")) >= 1);
