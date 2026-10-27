import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { apiError } from "@/lib/admin-api";
import type { AuthzDecision, AuthzSubject } from "@/lib/authz";
import { MAX_ACTIVE_POSITIONS_PER_USER } from "@/lib/position-key";
import { toPositionError } from "@/lib/positions";

/** The most positions one PATCH may assign or unassign. */
const MAX_POSITIONS_PER_REQUEST = MAX_ACTIVE_POSITIONS_PER_USER;
/** The most users one bulk assign may name; keeps it one short transaction. */
const MAX_USERS_PER_REQUEST = 200;

const dedupe = (ids: string[]) => [...new Set(ids)];

const idList = (max: number) => z.array(z.uuid()).max(max).transform(dedupe);

/** A path parameter naming a user or a position. */
export const assignmentIdSchema = z.uuid();

export const updateUserPositionsInputSchema = z
  .strictObject({
    assign: idList(MAX_POSITIONS_PER_REQUEST).default([]),
    unassign: idList(MAX_POSITIONS_PER_REQUEST).default([]),
  })
  .refine((value) => value.assign.length > 0 || value.unassign.length > 0, {
    message: "Send at least one position to assign or unassign",
  })
  .refine((value) => !value.assign.some((id) => value.unassign.includes(id)), {
    message: "A position can't be both assigned and unassigned",
    path: ["unassign"],
  });

export type UpdateUserPositionsInput = z.output<
  typeof updateUserPositionsInputSchema
>;

export const assignPositionToUsersInputSchema = z.strictObject({
  userIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_USERS_PER_REQUEST)
    .transform(dedupe),
});

export type AssignPositionToUsersInput = z.output<
  typeof assignPositionToUsersInputSchema
>;

export type AssignmentErrorCode =
  | "INVALID_INPUT"
  | "USER_NOT_FOUND"
  | "USER_DELETED"
  | "POSITION_NOT_FOUND"
  | "POSITION_DELETED"
  | "POSITION_LIMIT"
  | "FORBIDDEN";

export type AssignmentErrorDetails = {
  userIds?: string[];
  positionIds?: string[];
  reason?: string;
};

export class AssignmentError extends Error {
  readonly code: AssignmentErrorCode;
  readonly details: AssignmentErrorDetails;

  constructor(code: AssignmentErrorCode, details: AssignmentErrorDetails = {}) {
    super(code);
    this.name = "AssignmentError";
    this.code = code;
    this.details = details;
  }
}

// Exhaustive over AssignmentErrorCode, so a new code fails tsc until it has a row.
const ASSIGNMENT_ERRORS: Record<
  AssignmentErrorCode,
  { status: number; message: string }
> = {
  INVALID_INPUT: {
    status: 400,
    message: "Check the highlighted fields and try again.",
  },
  FORBIDDEN: {
    status: 403,
    message: "You do not have permission to change these users' positions.",
  },
  USER_NOT_FOUND: { status: 404, message: "Some users don't exist." },
  POSITION_NOT_FOUND: { status: 404, message: "Some positions don't exist." },
  USER_DELETED: { status: 409, message: "Some users have been deleted." },
  POSITION_DELETED: {
    status: 409,
    message: "Some positions have been deleted.",
  },
  POSITION_LIMIT: {
    status: 409,
    message: `A user can hold at most ${MAX_ACTIVE_POSITIONS_PER_USER} positions.`,
  },
};

export function assignmentErrorResponse(err: AssignmentError): Response {
  const { status, message } = ASSIGNMENT_ERRORS[err.code];
  return apiError(status, err.code, message, err.details);
}

type Authorize = (target: AuthzSubject) => AuthzDecision;

type ActivePosition = {
  id: string;
  key: string;
  name: string;
  category: string | null;
};

const sorted = (ids: Iterable<string>) => [...ids].sort();

// The trigger's POSITION_LIMIT is the real guarantee; the pre-checks give the
// caller a precise error, and a race past them lands here.
async function mapBackstop<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AssignmentError) throw err;
    if (toPositionError(err)?.code === "POSITION_LIMIT") {
      throw new AssignmentError("POSITION_LIMIT");
    }
    throw err;
  }
}

function authorizeAll(users: AuthzSubject[], authorize: Authorize) {
  const denied = users.flatMap((user) => {
    const decision = authorize(user);
    return decision.allowed ? [] : [{ id: user.id, reason: decision.reason }];
  });
  if (denied.length > 0) {
    throw new AssignmentError("FORBIDDEN", {
      userIds: denied.map((entry) => entry.id),
      reason: denied[0]?.reason,
    });
  }
}

type LockedUser = AuthzSubject;

async function lockUsers(
  tx: Prisma.TransactionClient,
  userIds: string[],
): Promise<LockedUser[]> {
  const rows = await tx.$queryRaw<LockedUser[]>`
    SELECT "id", "isAdmin", "isPrimaryAdmin", "status"
    FROM "User"
    WHERE "id" IN (${Prisma.join(userIds)})
    ORDER BY "id"
    FOR SHARE`;
  const found = new Set(rows.map((row) => row.id));
  const missing = userIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AssignmentError("USER_NOT_FOUND", { userIds: sorted(missing) });
  }
  const deleted = rows.filter((row) => row.status === "DELETED");
  if (deleted.length > 0) {
    throw new AssignmentError("USER_DELETED", {
      userIds: deleted.map((row) => row.id),
    });
  }
  return rows;
}

async function lockPositions(
  tx: Prisma.TransactionClient,
  positionIds: string[],
) {
  const rows = await tx.$queryRaw<{ id: string; deletedAt: Date | null }[]>`
    SELECT "id", "deletedAt"
    FROM "Position"
    WHERE "id" IN (${Prisma.join(positionIds)})
    ORDER BY "id"
    FOR SHARE`;
  const found = new Set(rows.map((row) => row.id));
  const missing = positionIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new AssignmentError("POSITION_NOT_FOUND", {
      positionIds: sorted(missing),
    });
  }
  const deleted = rows.filter((row) => row.deletedAt !== null);
  if (deleted.length > 0) {
    throw new AssignmentError("POSITION_DELETED", {
      positionIds: deleted.map((row) => row.id),
    });
  }
}

/**
 * Assigns and unassigns positions for one user, unassigns first so a swap at
 * the cap succeeds. Writes no audit row and makes no authorization decision of
 * its own: `authorize` is called on the locked user row, and the calling
 * handler audits `assigned` and `unassigned`.
 */
export async function updateUserPositions(
  tx: Prisma.TransactionClient,
  {
    actorId,
    userId,
    assign,
    unassign,
    authorize,
  }: {
    actorId: string;
    userId: string;
    assign: string[];
    unassign: string[];
    authorize: Authorize;
  },
): Promise<{
  assigned: string[];
  unassigned: string[];
  positions: ActivePosition[];
}> {
  return mapBackstop(async () => {
    const [user] = await lockUsers(tx, [userId]);
    if (!user)
      throw new AssignmentError("USER_NOT_FOUND", { userIds: [userId] });
    authorizeAll([user], authorize);

    await lockPositions(tx, [...assign, ...unassign]);

    const held = await tx.userPosition.findMany({
      where: { userId, positionId: { in: unassign } },
      select: { positionId: true },
    });
    const unassigned = sorted(held.map((row) => row.positionId));
    if (unassigned.length > 0) {
      await tx.userPosition.deleteMany({
        where: { userId, positionId: { in: unassigned } },
      });
    }

    const alreadyHeld = new Set(
      (
        await tx.userPosition.findMany({
          where: { userId, positionId: { in: assign } },
          select: { positionId: true },
        })
      ).map((row) => row.positionId),
    );
    const activeCount = await tx.userPosition.count({
      where: { userId, position: { deletedAt: null } },
    });
    const incoming = assign.filter((id) => !alreadyHeld.has(id));
    if (activeCount + incoming.length > MAX_ACTIVE_POSITIONS_PER_USER) {
      throw new AssignmentError("POSITION_LIMIT", { userIds: [userId] });
    }

    const created =
      incoming.length === 0
        ? []
        : await tx.userPosition.createManyAndReturn({
            data: sorted(incoming).map((positionId) => ({
              userId,
              positionId,
              assignedById: actorId,
            })),
            skipDuplicates: true,
            select: { positionId: true },
          });

    const positions = await tx.position.findMany({
      where: { deletedAt: null, holders: { some: { userId } } },
      select: { id: true, key: true, name: true, category: true },
      orderBy: { key: "asc" },
    });
    return {
      assigned: sorted(created.map((row) => row.positionId)),
      unassigned,
      positions,
    };
  });
}

/**
 * Assigns one position to many users, all or nothing. A user at the cap fails
 * the whole request. Writes no audit row; `authorize` is called on each locked
 * user row, and the calling handler audits `assigned`.
 */
export async function assignPositionToUsers(
  tx: Prisma.TransactionClient,
  {
    actorId,
    positionId,
    userIds,
    authorize,
  }: {
    actorId: string;
    positionId: string;
    userIds: string[];
    authorize: Authorize;
  },
): Promise<{ assigned: string[]; alreadyHeld: string[] }> {
  return mapBackstop(async () => {
    await lockPositions(tx, [positionId]);
    const users = await lockUsers(tx, userIds);
    authorizeAll(users, authorize);

    const holders = await tx.userPosition.findMany({
      where: { positionId, userId: { in: userIds } },
      select: { userId: true },
    });
    const held = new Set(holders.map((row) => row.userId));
    const incoming = userIds.filter((id) => !held.has(id));

    if (incoming.length > 0) {
      const counts = await tx.userPosition.groupBy({
        by: ["userId"],
        where: { userId: { in: incoming }, position: { deletedAt: null } },
        _count: { _all: true },
      });
      const full = counts
        .filter((row) => row._count._all >= MAX_ACTIVE_POSITIONS_PER_USER)
        .map((row) => row.userId);
      if (full.length > 0) {
        throw new AssignmentError("POSITION_LIMIT", { userIds: sorted(full) });
      }
    }

    const created =
      incoming.length === 0
        ? []
        : await tx.userPosition.createManyAndReturn({
            data: sorted(incoming).map((userId) => ({
              userId,
              positionId,
              assignedById: actorId,
            })),
            skipDuplicates: true,
            select: { userId: true },
          });
    const assigned = new Set(created.map((row) => row.userId));
    return {
      assigned: sorted(assigned),
      alreadyHeld: sorted(userIds.filter((id) => !assigned.has(id))),
    };
  });
}
