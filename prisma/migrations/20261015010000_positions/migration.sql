-- AUTH-T11: Position, UserPosition and RetiredPositionKey.
-- The DDL for the three tables below is written by hand to match what
-- `prisma migrate diff` generates for prisma/schema.prisma. Everything after the
-- "Backstops" marker cannot be expressed in the Prisma schema.

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPosition" (
    "userId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPosition_pkey" PRIMARY KEY ("userId","positionId")
);

-- CreateTable
CREATE TABLE "RetiredPositionKey" (
    "positionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetiredPositionKey_pkey" PRIMARY KEY ("positionId")
);

-- CreateIndex
CREATE INDEX "Position_deletedAt_idx" ON "Position"("deletedAt");

-- CreateIndex
CREATE INDEX "UserPosition_positionId_idx" ON "UserPosition"("positionId");

-- CreateIndex
CREATE INDEX "RetiredPositionKey_key_retiredAt_idx" ON "RetiredPositionKey"("key", "retiredAt");

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPosition" ADD CONSTRAINT "UserPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPosition" ADD CONSTRAINT "UserPosition_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPosition" ADD CONSTRAINT "UserPosition_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetiredPositionKey" ADD CONSTRAINT "RetiredPositionKey_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backstops (not expressible in the Prisma schema).
-- If a future `prisma migrate dev` proposes DROP INDEX "Position_key_active_key",
-- delete that line from the generated SQL: Prisma does not model partial indexes.

-- Uniqueness applies to active positions only, so a key can be reused after its
-- retirement window. A plain @unique would make that impossible.
CREATE UNIQUE INDEX "Position_key_active_key" ON "Position"("key") WHERE "deletedAt" IS NULL;

-- Defence in depth for the key format; the service layer validates first.
ALTER TABLE "Position" ADD CONSTRAINT "Position_key_format_check" CHECK ("key" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length("key") BETWEEN 2 AND 64);

-- Defence in depth for the display name length; the service layer validates first.
ALTER TABLE "Position" ADD CONSTRAINT "Position_name_length_check" CHECK (char_length(btrim("name")) BETWEEN 2 AND 100);

-- A key is immutable: retired keys and audit history refer to it. Prisma has no
-- way to declare column immutability.
CREATE FUNCTION position_key_immutable() RETURNS trigger AS $$
BEGIN
    IF NEW."key" IS DISTINCT FROM OLD."key" THEN
        RAISE EXCEPTION 'KEY_IMMUTABLE: position key cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER position_key_immutable
BEFORE UPDATE OF "key" ON "Position"
FOR EACH ROW EXECUTE FUNCTION position_key_immutable();

-- A user holds at most 50 active positions. A CHECK cannot count other rows, so
-- a trigger does it. The advisory lock serialises concurrent assignments for the
-- same user so two inserts cannot both pass the count.
CREATE FUNCTION enforce_user_position_limit() RETURNS trigger AS $$
DECLARE
    active_count integer;
BEGIN
    IF EXISTS (
        SELECT 1 FROM "Position" WHERE "id" = NEW."positionId" AND "deletedAt" IS NOT NULL
    ) THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(NEW."userId"::text, 0));

    IF TG_OP = 'UPDATE' THEN
        SELECT count(*) INTO active_count
        FROM "UserPosition" up
        JOIN "Position" p ON p."id" = up."positionId"
        WHERE up."userId" = NEW."userId"
          AND p."deletedAt" IS NULL
          AND NOT (up."userId" = OLD."userId" AND up."positionId" = OLD."positionId");
    ELSE
        SELECT count(*) INTO active_count
        FROM "UserPosition" up
        JOIN "Position" p ON p."id" = up."positionId"
        WHERE up."userId" = NEW."userId"
          AND p."deletedAt" IS NULL;
    END IF;

    IF active_count >= 50 THEN
        RAISE EXCEPTION 'POSITION_LIMIT: user % already holds 50 active positions', NEW."userId"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_position_limit
BEFORE INSERT OR UPDATE OF "userId", "positionId" ON "UserPosition"
FOR EACH ROW EXECUTE FUNCTION enforce_user_position_limit();
