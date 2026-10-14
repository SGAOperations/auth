-- AUTH-T13: AuditEvent is append-only. UPDATE is allowed only under
-- `sgauth.audit_anonymize = 'on'` and only to null `ip`/`userAgent` or rewrite
-- `metadata` (AUTH-T78). The gate guards against accidental application writes;
-- it is not a security boundary against anyone holding the database role.
-- `type` has no CHECK on purpose: it is validated in `src/lib/audit.ts`, so
-- adding an event type needs no migration.
-- There is no FK on `actorUserId`/`targetId`: audit rows outlive their subjects,
-- and an FK action would itself be an UPDATE.

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'BREAK_GLASS');

-- CreateEnum
CREATE TYPE "AuditTargetType" AS ENUM ('USER', 'POSITION', 'PRODUCT', 'SESSION', 'TRANSFER');

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorUserId" TEXT,
    "targetType" "AuditTargetType",
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_type_createdAt_idx" ON "AuditEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_targetType_targetId_createdAt_idx" ON "AuditEvent"("targetType", "targetId", "createdAt");

ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actor_consistent"
  CHECK (("actorType" = 'USER') = ("actorUserId" IS NOT NULL));
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_target_pair"
  CHECK (("targetType" IS NULL) = ("targetId" IS NULL));

CREATE FUNCTION audit_event_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'AuditEvent is append-only: % rejected', TG_OP;
  END IF;
  IF current_setting('sgauth.audit_anonymize', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'AuditEvent is append-only: UPDATE rejected';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."actorType" IS DISTINCT FROM OLD."actorType"
     OR NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId"
     OR NEW."targetType" IS DISTINCT FROM OLD."targetType"
     OR NEW."targetId" IS DISTINCT FROM OLD."targetId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."ip" IS NOT NULL AND NEW."ip" IS DISTINCT FROM OLD."ip")
     OR (NEW."userAgent" IS NOT NULL AND NEW."userAgent" IS DISTINCT FROM OLD."userAgent") THEN
    RAISE EXCEPTION 'AuditEvent anonymization may only null ip/userAgent or rewrite metadata';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_event_append_only_row
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
CREATE TRIGGER audit_event_append_only_truncate
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();
