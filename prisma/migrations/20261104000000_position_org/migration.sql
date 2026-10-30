-- Adds Position."isLeadership" and the self-referencing "managerPositionId" for the org chart.
-- The DDL above the "Backstops" marker is written by hand to match what
-- `prisma migrate diff` generates for prisma/schema.prisma. Everything after the
-- marker cannot be expressed in the Prisma schema.
-- Expand-only: both columns are nullable or defaulted, so the code that is
-- deployed while this runs keeps working (docs/MIGRATIONS.md).

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "isLeadership" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "managerPositionId" TEXT;

-- CreateIndex
CREATE INDEX "Position_managerPositionId_idx" ON "Position"("managerPositionId");

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_managerPositionId_fkey" FOREIGN KEY ("managerPositionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backstops (not expressible in the Prisma schema).
-- If a future `prisma migrate dev` proposes dropping the check or the trigger
-- below, delete that line from the generated SQL: Prisma does not model them.

-- A position never reports to itself. Defence in depth; the service layer
-- validates first.
ALTER TABLE "Position" ADD CONSTRAINT "Position_manager_not_self_check" CHECK ("managerPositionId" IS NULL OR "managerPositionId" <> "id");

-- A manager must be an active position, and the chain of managers must not loop
-- back. A CHECK cannot read other rows, so a trigger does it. The advisory lock
-- serialises every manager edit so two edits cannot each pass the walk and
-- together close a loop. The service layer takes the same lock.
CREATE FUNCTION position_manager_valid() RETURNS trigger AS $$
BEGIN
    IF NEW."managerPositionId" IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('position_manager_graph', 0));

    IF NOT EXISTS (
        SELECT 1 FROM "Position" WHERE "id" = NEW."managerPositionId" AND "deletedAt" IS NULL
    ) THEN
        RAISE EXCEPTION 'MANAGER_NOT_FOUND: manager position % does not exist or is deleted', NEW."managerPositionId"
            USING ERRCODE = 'check_violation';
    END IF;

    -- Walk up from the manager. The path array is a loop guard, so a loop that
    -- already exists elsewhere in the table cannot make the walk run forever.
    IF EXISTS (
        WITH RECURSIVE chain("id", "managerPositionId", "path") AS (
            SELECT p."id", p."managerPositionId", ARRAY[p."id"]
            FROM "Position" p
            WHERE p."id" = NEW."managerPositionId"
          UNION ALL
            SELECT p."id", p."managerPositionId", chain."path" || p."id"
            FROM "Position" p
            JOIN chain ON p."id" = chain."managerPositionId"
            WHERE NOT (p."id" = ANY (chain."path"))
        )
        SELECT 1 FROM chain WHERE chain."id" = NEW."id"
    ) THEN
        RAISE EXCEPTION 'MANAGER_CYCLE: position % cannot report to %', NEW."id", NEW."managerPositionId"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER position_manager_valid
BEFORE INSERT OR UPDATE OF "managerPositionId" ON "Position"
FOR EACH ROW EXECUTE FUNCTION position_manager_valid();
