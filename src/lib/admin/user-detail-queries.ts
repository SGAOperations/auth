import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  decodeCursor,
  encodeCursor,
  resolveRefs,
  type AuditCursor,
  type AuditLogRow,
} from "@/lib/audit-log";
import { describeDevice } from "@/lib/sessions/device";

// Reads for the admin user pages that the user-management endpoints do not
// serve. Server Components only: never import this into a client module.

export const TIMELINE_PAGE_SIZE = 20;

export interface UserSessionRow {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  ip: string | null;
  /** The raw user agent, for a tooltip. */
  userAgent: string | null;
  device: string;
}

/** The user's sessions that are neither idle-expired nor past the absolute cap, newest first. */
export async function listUserSessions(
  db: Pick<PrismaClient, "session">,
  userId: string,
  now: Date,
): Promise<UserSessionRow[]> {
  const rows = await db.session.findMany({
    where: {
      userId,
      expiresAt: { gt: now },
      absoluteExpiresAt: { gt: now },
    },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    // "" means a refused multi-hop x-forwarded-for.
    ip: row.ipAddress || null,
    userAgent: row.userAgent,
    device: describeDevice(row.userAgent),
  }));
}

export interface AssignablePosition {
  id: string;
  key: string;
  name: string;
  category: string | null;
}

/** Every position that is not deleted, by category and then name. */
export function listActivePositions(
  db: Pick<PrismaClient, "position">,
): Promise<AssignablePosition[]> {
  return db.position.findMany({
    where: { deletedAt: null },
    select: { id: true, key: true, name: true, category: true },
    orderBy: [{ category: "asc" }, { name: "asc" }, { id: "asc" }],
  });
}

type TimelineDb = Pick<
  Prisma.TransactionClient,
  "auditEvent" | "user" | "position" | "product"
>;

/**
 * What a user's timeline shows: what they did, what was done to them, and the
 * sessions an admin revoked for them (their audit row targets the session and
 * names the user in its metadata).
 */
function timelineWhere(userId: string): Prisma.AuditEventWhereInput {
  return {
    OR: [
      { actorUserId: userId },
      { targetType: "USER", targetId: userId },
      {
        type: "SESSION_REVOKED",
        metadata: { path: ["userId"], equals: userId },
      },
    ],
  };
}

export interface UserTimeline {
  events: AuditLogRow[];
  nextCursor: string | null;
}

/** One page of the timeline, newest first. A malformed cursor reads as the first page. */
export async function listUserAudit(
  db: TimelineDb,
  userId: string,
  cursorParam?: string,
): Promise<UserTimeline> {
  const cursor: AuditCursor | null = cursorParam
    ? decodeCursor(cursorParam)
    : null;
  const where: Prisma.AuditEventWhereInput = cursor
    ? {
        AND: [
          timelineWhere(userId),
          {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          },
        ],
      }
    : timelineWhere(userId);
  const rows = await db.auditEvent.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: TIMELINE_PAGE_SIZE + 1,
  });
  const page = rows.slice(0, TIMELINE_PAGE_SIZE);
  const last = page.at(-1);
  return {
    events: await resolveRefs(db, page),
    nextCursor:
      rows.length > TIMELINE_PAGE_SIZE && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}
