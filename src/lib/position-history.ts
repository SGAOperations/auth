import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { AuditEvent, UserStatus } from "@/generated/prisma/client";
import type { AuditActorType, AuditEventType } from "@/lib/audit";
import {
  decodeCursor,
  encodeCursor,
  type AuditCursor,
  type PersonRef,
} from "@/lib/audit-log";

// The two position detail pages' history: a position's own lifecycle events plus
// every assign and unassign of it, and a user's assign and unassign events.
// Every query takes its client as an argument, and the file never imports
// `@/lib/prisma`, so the pure tests never parse env.

export type PositionHistoryDb = Pick<
  Prisma.TransactionClient,
  "user" | "position" | "$queryRaw"
>;

export const POSITION_LIFECYCLE_TYPES = [
  "POSITION_CREATED",
  "POSITION_UPDATED",
  "POSITION_DELETED",
] as const satisfies readonly AuditEventType[];

export const POSITION_MEMBERSHIP_TYPES = [
  "POSITION_ASSIGNED",
  "POSITION_UNASSIGNED",
] as const satisfies readonly AuditEventType[];

export type PositionHistoryEventType =
  | (typeof POSITION_LIFECYCLE_TYPES)[number]
  | (typeof POSITION_MEMBERSHIP_TYPES)[number];

// --- Input --------------------------------------------------------------

export const historyIdSchema = z.uuid();

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .max(200)
    .transform((value, ctx) => {
      const cursor = decodeCursor(value);
      if (!cursor) {
        ctx.addIssue({ code: "custom", message: "Invalid page marker." });
        return z.NEVER;
      }
      return cursor;
    })
    .optional(),
});

export type HistoryQuery = z.output<typeof historyQuerySchema>;

// --- Errors -------------------------------------------------------------

export type HistoryErrorCode =
  | "INVALID_INPUT"
  | "POSITION_NOT_FOUND"
  | "USER_NOT_FOUND";

/** Fixed copy per code. It never echoes the input or a zod message. */
export const HISTORY_ERRORS: Record<
  HistoryErrorCode,
  { status: number; message: string }
> = {
  INVALID_INPUT: { status: 400, message: "Invalid request parameters." },
  POSITION_NOT_FOUND: { status: 404, message: "Position not found." },
  USER_NOT_FOUND: { status: 404, message: "User not found." },
};

// --- Output -------------------------------------------------------------

export interface PositionRef {
  id: string;
  key: string;
  name: string;
  /** ISO, UTC. */
  deletedAt: string | null;
}

export interface PositionHistoryEvent {
  id: string;
  type: PositionHistoryEventType;
  /** ISO, UTC. */
  createdAt: string;
  actor: { type: AuditActorType; user: PersonRef | null };
  /** The holder, for assign and unassign; `null` for lifecycle events. */
  user: PersonRef | null;
  position: PositionRef | null;
  /** As stored; its shape is owned by AUDIT_CATALOG. */
  metadata: Prisma.JsonValue;
}

export interface PositionHistoryPage {
  events: PositionHistoryEvent[];
  nextCursor: string | null;
}

// `ip` and `userAgent` are never read: request metadata belongs to the audit
// log viewer, not to the detail pages.
type HistoryRow = Pick<
  AuditEvent,
  | "id"
  | "type"
  | "actorType"
  | "actorUserId"
  | "targetType"
  | "targetId"
  | "metadata"
  | "createdAt"
>;

/**
 * A history row with its actor, holder and position joined in. Each `*FoundId`
 * is null when the joined row does not exist, and the other columns of that
 * group are then null too.
 */
interface JoinedRow extends HistoryRow {
  actorFoundId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorStatus: string | null;
  holderFoundId: string | null;
  holderName: string | null;
  holderEmail: string | null;
  holderStatus: string | null;
  positionFoundId: string | null;
  positionKey: string | null;
  positionName: string | null;
  positionDeletedAt: Date | null;
}

function isMembership(type: string): boolean {
  return (POSITION_MEMBERSHIP_TYPES as readonly string[]).includes(type);
}

/**
 * The cursor goes in as an ISO string cast to the column's own type, so the
 * comparison does not depend on how the driver sends a Date.
 */
function afterCursor(cursor: AuditCursor | undefined): Prisma.Sql {
  return cursor
    ? Prisma.sql`AND ("createdAt", "id") < (${cursor.createdAt.toISOString()}::timestamp(3), ${cursor.id})`
    : Prisma.empty;
}

/**
 * The tail of a history query: joins the actor, the holder and the position
 * onto a CTE named "page" that holds the page's AuditEvent rows, so the one
 * query returns everything a page shows. The holder is the target of an assign
 * or unassign; the position is the id in a membership event's metadata, or the
 * target of a lifecycle event. At most limit + 1 rows are joined, each by
 * primary key. Email and status are cast to text because the driver does not
 * read citext.
 */
const JOIN_REFS = Prisma.sql`
  SELECT e."id", e."type", e."actorType", e."actorUserId", e."targetType", e."targetId", e."metadata", e."createdAt",
         a."id" AS "actorFoundId", a."name" AS "actorName", a."email"::text AS "actorEmail", a."status"::text AS "actorStatus",
         h."id" AS "holderFoundId", h."name" AS "holderName", h."email"::text AS "holderEmail", h."status"::text AS "holderStatus",
         p."id" AS "positionFoundId", p."key" AS "positionKey", p."name" AS "positionName", p."deletedAt" AS "positionDeletedAt"
  FROM "page" e
  LEFT JOIN "User" a ON e."actorType" = 'USER' AND a."id" = e."actorUserId"
  LEFT JOIN "User" h ON e."type" IN ('POSITION_ASSIGNED', 'POSITION_UNASSIGNED') AND h."id" = e."targetId"
  LEFT JOIN "Position" p ON p."id" = CASE
    WHEN e."type" IN ('POSITION_ASSIGNED', 'POSITION_UNASSIGNED') THEN e."metadata"->>'positionId'
    ELSE e."targetId"
  END
  ORDER BY e."createdAt" DESC, e."id" DESC`;

// A user whose row is missing keeps its id and nothing else.
function person(
  id: string,
  foundId: string | null,
  name: string | null,
  email: string | null,
  status: string | null,
): PersonRef {
  if (foundId === null) return { id, name: null, email: null, status: null };
  return { id, name, email, status: status as UserStatus };
}

function shapePage(
  rows: readonly JoinedRow[],
  limit: number,
): PositionHistoryPage {
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  const events = page.map(
    (row): PositionHistoryEvent => ({
      id: row.id,
      // The queries select these types only.
      type: row.type as PositionHistoryEventType,
      createdAt: row.createdAt.toISOString(),
      actor: {
        type: row.actorType,
        user:
          row.actorType === "USER" && row.actorUserId
            ? person(
                row.actorUserId,
                row.actorFoundId,
                row.actorName,
                row.actorEmail,
                row.actorStatus,
              )
            : null,
      },
      user:
        isMembership(row.type) && row.targetId
          ? person(
              row.targetId,
              row.holderFoundId,
              row.holderName,
              row.holderEmail,
              row.holderStatus,
            )
          : null,
      position: row.positionFoundId
        ? {
            id: row.positionFoundId,
            key: row.positionKey ?? "",
            name: row.positionName ?? "",
            deletedAt: row.positionDeletedAt?.toISOString() ?? null,
          }
        : null,
      metadata: row.metadata,
    }),
  );

  return {
    events,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

// --- Queries ------------------------------------------------------------

/**
 * A position's create, update and delete events plus every assign and unassign
 * of it, newest first. `null` means no such position; a soft-deleted one is
 * found, because deleted positions keep their history.
 */
export async function getPositionHistory(
  db: PositionHistoryDb,
  positionId: string,
  { limit, cursor }: { limit: number; cursor?: AuditCursor },
): Promise<PositionHistoryPage | null> {
  const position = await db.position.findUnique({
    where: { id: positionId },
    select: { id: true },
  });
  if (!position) return null;

  const after = afterCursor(cursor);
  const take = limit + 1;

  // Literal type lists, written exactly as in the partial index
  // AuditEvent_positionId_member_idx, so the planner can match it.
  const rows = await db.$queryRaw<JoinedRow[]>`
    WITH "page" AS (
      (SELECT "id", "type", "actorType", "actorUserId", "targetType", "targetId", "metadata", "createdAt"
       FROM "AuditEvent"
       WHERE "targetType" = 'POSITION'
         AND "targetId" = ${positionId}
         AND "type" IN ('POSITION_CREATED', 'POSITION_UPDATED', 'POSITION_DELETED')
         ${after}
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT ${take})
      UNION ALL
      (SELECT "id", "type", "actorType", "actorUserId", "targetType", "targetId", "metadata", "createdAt"
       FROM "AuditEvent"
       WHERE "type" IN ('POSITION_ASSIGNED', 'POSITION_UNASSIGNED')
         AND "metadata"->>'positionId' = ${positionId}
         ${after}
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT ${take})
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${take})
    ${JOIN_REFS}`;

  return shapePage(rows, limit);
}

/**
 * Every assign and unassign of a user, newest first. `null` means no such user;
 * users are never hard-deleted, so deactivated and tombstoned ones are found.
 */
export async function getUserPositionHistory(
  db: PositionHistoryDb,
  userId: string,
  { limit, cursor }: { limit: number; cursor?: AuditCursor },
): Promise<PositionHistoryPage | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) return null;

  const rows = await db.$queryRaw<JoinedRow[]>`
    WITH "page" AS (
      SELECT "id", "type", "actorType", "actorUserId", "targetType", "targetId", "metadata", "createdAt"
      FROM "AuditEvent"
      WHERE "targetType" = 'USER'
        AND "targetId" = ${userId}
        AND "type" IN ('POSITION_ASSIGNED', 'POSITION_UNASSIGNED')
        ${afterCursor(cursor)}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${limit + 1})
    ${JOIN_REFS}`;

  return shapePage(rows, limit);
}
