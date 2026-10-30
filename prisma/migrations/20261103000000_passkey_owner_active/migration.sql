-- AUTH-T105: refuse a passkey for an owner who is not active.
--
-- This is its own migration, not an edit to 20261102000000_passkey: that one is
-- already recorded as applied on the shared branches, and `prisma migrate
-- deploy` never re-runs an applied migration, so an edit to it never reaches
-- them.

-- The other half of the delete_passkeys_when_inactive rule. Without it, an
-- insert racing a deactivation could pass its status check, the deactivation
-- could commit and delete, and the insert could then commit a passkey for an
-- inactive user. FOR SHARE locks the "User" row, so the deactivating UPDATE
-- waits for the insert to commit (and its AFTER trigger then deletes the new
-- row), and an insert that arrives after the UPDATE waits for it and then sees
-- the new status and fails.
--
-- Reversal: run
--   npx prisma db execute --file prisma/migrations/20261103000000_passkey_owner_active/down.sql
-- down.sql also removes this migration's row from _prisma_migrations so a later
-- `migrate deploy` re-applies it.

-- Prisma does not model triggers. If a future `prisma migrate dev` proposes
-- DROP TRIGGER or DROP FUNCTION for require_active_user_for_passkey, delete that
-- line from the generated SQL.
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
