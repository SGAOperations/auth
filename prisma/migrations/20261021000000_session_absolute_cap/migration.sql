-- The 90-day absolute session cap, enforced at the database level.
--
-- Why: Better Auth's endpoints, including /token, trust only "expiresAt", and
-- its sliding refresh writes "expiresAt" with no knowledge of the cap. Clamping
-- "expiresAt" to "absoluteExpiresAt" on every write makes Better Auth's own
-- expiry check enforce the cap on every path. This trigger is what makes that
-- hold, including for the daily refresh.
--
-- What it enforces, on every INSERT and UPDATE of "Session", from any writer:
--   * "absoluteExpiresAt" <= "createdAt" + 90 days
--   * "absoluteExpiresAt" never increases
--   * "expiresAt" <= "absoluteExpiresAt"
--
-- Coupling: 90 days must match SESSION_ABSOLUTE_MAX_AGE_MS in
-- src/lib/auth/session-lifetime.ts and the "absoluteExpiresAt" column default.
--
-- Known gaps: none for INSERT and UPDATE. TRUNCATE bypasses row-level
-- triggers, which is irrelevant here.
--
-- Reversal: run
--   npx prisma db execute --file prisma/migrations/20261021000000_session_absolute_cap/down.sql
-- down.sql also removes this migration's row from _prisma_migrations so a later
-- `migrate deploy` re-applies it.

-- Prisma does not model triggers. If a future `prisma migrate dev` proposes
-- DROP TRIGGER or DROP FUNCTION for clamp_session_expiry, delete that line from
-- the generated SQL.
CREATE FUNCTION clamp_session_expiry() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW."absoluteExpiresAt" := LEAST(NEW."absoluteExpiresAt", NEW."createdAt" + interval '90 days');
    ELSE
        NEW."absoluteExpiresAt" := LEAST(NEW."absoluteExpiresAt", OLD."absoluteExpiresAt");
    END IF;
    NEW."expiresAt" := LEAST(NEW."expiresAt", NEW."absoluteExpiresAt");
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clamp_session_expiry
BEFORE INSERT OR UPDATE ON "Session"
FOR EACH ROW EXECUTE FUNCTION clamp_session_expiry();
