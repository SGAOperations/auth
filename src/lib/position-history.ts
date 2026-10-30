import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { AuditEvent } from "@/generated/prisma/client";
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
  "auditEvent" | "user" | "position" | "$queryRaw"
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

const ROW_SELECT = {
  id: true,
  type: true,
  actorType: true,
  actorUserId: true,
  targetType: true,
  targetId: true,
  metadata: true,
  createdAt: true,
} as const;

function metadataPositionId(metadata: Prisma.JsonValue): string | null {
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    return null;
  }
  const value = metadata.positionId;
  return typeof value === "string" ? value : null;
}

function isMembership(type: string): boolean {
  return (POSITION_MEMBERSHIP_TYPES as readonly string[]).includes(type);
}

/** The position an event is about: its target, or the id in a membership event. */
function rowPositionId(row: HistoryRow): string | null {
  return isMembership(row.type)
    ? metadataPositionId(row.metadata)
    : row.targetId;
}

async function shapePage(
  db: Pick<PositionHistoryDb, "user" | "position">,
  rows: readonly HistoryRow[],
  limit: number,
): Promise<PositionHistoryPage> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);

  const userIds = new Set<string>();
  const positionIds = new Set<string>();
  for (const row of page) {
    if (row.actorType === "USER" && row.actorUserId) {
      userIds.add(row.actorUserId);
    }
    if (isMembership(row.type) && row.targetId) userIds.add(row.targetId);
    const positionId = rowPositionId(row);
    if (positionId) positionIds.add(positionId);
  }

  const [users, positions] = await Promise.all([
    userIds.size > 0
      ? db.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, name: true, email: true, status: true },
        })
      : [],
    positionIds.size > 0
      ? db.position.findMany({
          where: { id: { in: [...positionIds] } },
          select: { id: true, key: true, name: true, deletedAt: true },
        })
      : [],
  ]);
  const userById = new Map<string, PersonRef>(users.map((u) => [u.id, u]));
  const positionById = new Map(positions.map((p) => [p.id, p]));
  // A user whose row is missing keeps its id and nothing else.
  const person = (id: string): PersonRef =>
    userById.get(id) ?? { id, name: null, email: null, status: null };

  const events = page.map((row): PositionHistoryEvent => {
    const positionId = rowPositionId(row);
    const position = positionId ? positionById.get(positionId) : undefined;
    return {
      id: row.id,
      // The queries select these types only.
      type: row.type as PositionHistoryEventType,
      createdAt: row.createdAt.toISOString(),
      actor: {
        type: row.actorType,
        user:
          row.actorType === "USER" && row.actorUserId
            ? person(row.actorUserId)
            : null,
      },
      user:
        isMembership(row.type) && row.targetId ? person(row.targetId) : null,
      position: position
        ? {
            id: position.id,
            key: position.key,
            name: position.name,
            deletedAt: position.deletedAt?.toISOString() ?? null,
          }
        : null,
      metadata: row.metadata,
    };
  });

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

  // The cursor goes in as an ISO string cast to the column's own type, so the
  // comparison does not depend on how the driver sends a Date.
  const after = cursor
    ? Prisma.sql`AND ("createdAt", "id") < (${cursor.createdAt.toISOString()}::timestamp(3), ${cursor.id})`
    : Prisma.empty;
  const take = limit + 1;

  // Literal type lists, written exactly as in the partial index
  // AuditEvent_positionId_member_idx, so the planner can match it.
  const rows = await db.$queryRaw<HistoryRow[]>`
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
    LIMIT ${take}`;

  return shapePage(db, rows, limit);
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

  const rows = await db.auditEvent.findMany({
    where: {
      targetType: "USER",
      targetId: userId,
      type: { in: [...POSITION_MEMBERSHIP_TYPES] },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: ROW_SELECT,
  });

  return shapePage(db, rows, limit);
}
