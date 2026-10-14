-- AUTH-T12: Primary Admin invariants at the database level, and the
-- PrimaryAdminTransfer table.
--
-- Why: the design allows exactly one Primary Admin (PA), who can never be
-- deleted, demoted or deactivated, and who changes only through the transfer
-- flow. authz.ts is the primary check for all of that. This migration is the
-- backstop, so a bug or a hand-written query in application code cannot break
-- the rule.
--
-- What it enforces:
--   * one_primary_admin: at most one User row has "isPrimaryAdmin" = true.
--   * protect_primary_admin (BEFORE UPDATE OR DELETE on "User"): a PA row cannot
--     be deleted, cannot lose "isAdmin", cannot become non-ACTIVE, and a
--     non-active or non-admin user cannot be promoted to PA. Clearing the flag
--     is allowed only inside a transaction that set sgauth.pa_transfer = 'on'.
--   * primary_admin_must_exist (deferred constraint trigger): a transaction that
--     clears the flag must leave a PA behind at commit. Together with the unique
--     index this gives "exactly one" once a PA exists. A database with no PA
--     yet is unaffected, because the trigger fires only when the flag is cleared.
--   * one_in_flight_primary_admin_transfer: at most one transfer is in
--     PENDING_ACCEPTANCE or COOLING.
--
-- The session variable is NOT a security boundary. It stops accidental writes
-- from application code, and anyone holding the database role can set it. It is
-- set only by the transfer service (AUTH-T37) and the break-glass script
-- (AUTH-T39).
--
-- Setting the variable: always transaction-local, either
--   SELECT set_config('sgauth.pa_transfer', 'on', true);
-- or SET LOCAL sgauth.pa_transfer = 'on';
-- Never a plain SET. A session-level SET leaks to the next client that gets the
-- same pooled Neon connection.
--
-- Transfer order: clear the old PA first, then set the new one, then commit. A
-- unique index cannot be deferred, so the new PA cannot be set while the old
-- flag is still true.
--
-- Known gap: TRUNCATE bypasses row-level triggers. Do not grant TRUNCATE on
-- "User" to the application role.
--
-- Reversal: run
--   npx prisma db execute --file prisma/migrations/20261016000000_primary_admin_invariants/down.sql
-- then revert the schema.prisma change. down.sql also removes this migration's
-- row from _prisma_migrations so a later `migrate deploy` re-applies it.

-- CreateEnum
CREATE TYPE "PrimaryAdminTransferStatus" AS ENUM ('PENDING_ACCEPTANCE', 'COOLING', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "PrimaryAdminTransfer" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" "PrimaryAdminTransferStatus" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptanceExpiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + '7 days'::interval),
    "acceptedAt" TIMESTAMP(3),
    "executesAt" TIMESTAMP(3),
    "cancelTokenHash" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "reason" TEXT,

    CONSTRAINT "PrimaryAdminTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrimaryAdminTransfer_cancelTokenHash_key" ON "PrimaryAdminTransfer"("cancelTokenHash");

-- CreateIndex
CREATE INDEX "PrimaryAdminTransfer_fromUserId_idx" ON "PrimaryAdminTransfer"("fromUserId");

-- CreateIndex
CREATE INDEX "PrimaryAdminTransfer_toUserId_idx" ON "PrimaryAdminTransfer"("toUserId");

-- CreateIndex
CREATE INDEX "PrimaryAdminTransfer_status_executesAt_idx" ON "PrimaryAdminTransfer"("status", "executesAt");

-- AddForeignKey
ALTER TABLE "PrimaryAdminTransfer" ADD CONSTRAINT "PrimaryAdminTransfer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrimaryAdminTransfer" ADD CONSTRAINT "PrimaryAdminTransfer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrimaryAdminTransfer" ADD CONSTRAINT "PrimaryAdminTransfer_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backstops (not expressible in the Prisma schema).
-- If a future `prisma migrate dev` proposes DROP INDEX "one_primary_admin" or
-- DROP INDEX "one_in_flight_primary_admin_transfer", delete that line from the
-- generated SQL: Prisma does not model expression or partial indexes.

-- At most one Primary Admin.
CREATE UNIQUE INDEX one_primary_admin ON "User" ((true)) WHERE "isPrimaryAdmin";

-- At most one transfer in flight.
CREATE UNIQUE INDEX one_in_flight_primary_admin_transfer ON "PrimaryAdminTransfer" ((true)) WHERE "status" IN ('PENDING_ACCEPTANCE', 'COOLING');

-- A transfer needs two different people.
ALTER TABLE "PrimaryAdminTransfer" ADD CONSTRAINT "PrimaryAdminTransfer_distinct_parties" CHECK ("fromUserId" <> "toUserId");

-- Guards the Primary Admin row. The variable is unset (NULL) or '' outside a
-- transfer, and both count as off.
CREATE FUNCTION protect_primary_admin() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."isPrimaryAdmin" THEN
            RAISE EXCEPTION 'protect_primary_admin: the Primary Admin cannot be deleted'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NOT OLD."isPrimaryAdmin" AND NOT NEW."isPrimaryAdmin" THEN
        RETURN NEW;
    END IF;

    IF OLD."isPrimaryAdmin" AND NOT NEW."isPrimaryAdmin" THEN
        IF current_setting('sgauth.pa_transfer', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'protect_primary_admin: clearing isPrimaryAdmin requires sgauth.pa_transfer'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- NEW is the Primary Admin, either already or by promotion. "<> 'ACTIVE'"
    -- rather than "= 'DEACTIVATED'": a DELETED tombstone is just as fatal.
    IF NOT NEW."isAdmin" OR NEW."status" <> 'ACTIVE' THEN
        RAISE EXCEPTION 'protect_primary_admin: the Primary Admin must remain an active admin'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_primary_admin
BEFORE UPDATE OR DELETE ON "User"
FOR EACH ROW EXECUTE FUNCTION protect_primary_admin();

-- The other half of "exactly one": the index allows at most one, and this
-- deferred check stops a transaction from clearing the Primary Admin and
-- committing without setting a new one.
CREATE FUNCTION require_primary_admin() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE "isPrimaryAdmin") THEN
        RAISE EXCEPTION 'primary_admin_must_exist: a transaction cannot leave zero Primary Admins'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER primary_admin_must_exist
AFTER UPDATE OF "isPrimaryAdmin" ON "User"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."isPrimaryAdmin" AND NOT NEW."isPrimaryAdmin")
EXECUTE FUNCTION require_primary_admin();
