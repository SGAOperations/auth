-- AUTH-T105: passkeys (WebAuthn) as an optional sign-in method, and the
-- database backstop that removes a user's passkeys when the account stops
-- being active.

-- CreateTable
CREATE TABLE "Passkey" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "publicKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialID" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "transports" TEXT,
    "aaguid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Passkey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Passkey_credentialID_key" ON "Passkey"("credentialID");

-- CreateIndex
CREATE INDEX "Passkey_userId_idx" ON "Passkey"("userId");

-- AddForeignKey
ALTER TABLE "Passkey" ADD CONSTRAINT "Passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deactivation (AUTH-T36) and tombstoning (AUTH-T78) both move
-- "User"."status" away from ACTIVE, however they are implemented. Deleting the
-- passkeys here means neither has to remember to, and a credential can never
-- outlive the account state that allowed it. Reactivation does not restore
-- them: the user enrolls again.
--
-- Known gaps: none for UPDATE of "status". TRUNCATE bypasses row-level
-- triggers, which is irrelevant here. The deletion writes no audit event: the
-- USER_DEACTIVATED / USER_DELETED event of the code that changed the status
-- covers it.
--
-- Reversal: run
--   npx prisma db execute --file prisma/migrations/20261102000000_passkey/down.sql
-- down.sql also removes this migration's row from _prisma_migrations so a later
-- `migrate deploy` re-applies it.

-- Prisma does not model triggers. If a future `prisma migrate dev` proposes
-- DROP TRIGGER or DROP FUNCTION for delete_passkeys_when_inactive or
-- require_active_user_for_passkey, delete that line from the generated SQL.
CREATE FUNCTION delete_passkeys_when_inactive() RETURNS trigger AS $$
BEGIN
    DELETE FROM "Passkey" WHERE "userId" = NEW."id";
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER delete_passkeys_when_inactive
AFTER UPDATE OF "status" ON "User"
FOR EACH ROW
WHEN (NEW."status" <> 'ACTIVE')
EXECUTE FUNCTION delete_passkeys_when_inactive();

-- The other half of the same rule. Without it, an insert racing a deactivation
-- could pass its status check, the deactivation could commit and delete, and
-- the insert could then commit a passkey for an inactive user. FOR SHARE locks
-- the "User" row, so the deactivating UPDATE waits for the insert to commit
-- (and its AFTER trigger then deletes the new row), and an insert that arrives
-- after the UPDATE waits for it and then sees the new status and fails.
CREATE FUNCTION require_active_user_for_passkey() RETURNS trigger AS $$
DECLARE
    owner_status "UserStatus";
BEGIN
    SELECT "status" INTO owner_status FROM "User" WHERE "id" = NEW."userId" FOR SHARE;
    IF owner_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'passkey owner is not active' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER require_active_user_for_passkey
BEFORE INSERT ON "Passkey"
FOR EACH ROW EXECUTE FUNCTION require_active_user_for_passkey();
