-- Serves the position history query (src/lib/position-history.ts): the assign
-- and unassign events of one position, newest first.
-- This index is not in schema.prisma on purpose: Prisma cannot model an
-- expression or partial index. If a future `prisma migrate dev` proposes
-- DROP INDEX "AuditEvent_positionId_member_idx", delete that line from the
-- generated SQL.

-- Not CONCURRENTLY: Prisma runs the file in one transaction. Adding an index is
-- an expand step.
CREATE INDEX "AuditEvent_positionId_member_idx"
  ON "AuditEvent" (("metadata"->>'positionId'), "createdAt" DESC, "id" DESC)
  WHERE "type" IN ('POSITION_ASSIGNED', 'POSITION_UNASSIGNED');
