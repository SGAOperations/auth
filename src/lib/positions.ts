import "server-only";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  isKeyRetirementActive,
  POSITION_KEY_MAX,
  positionKeySchema,
  positionNameSchema,
} from "@/lib/position-key";
import {
  managerChain,
  wouldCreateCycle,
  type ManagerNode,
} from "@/lib/position-org";

export type PositionErrorCode =
  | "INVALID_INPUT"
  | "INVALID_KEY"
  | "KEY_TAKEN"
  | "KEY_RETIRED"
  | "KEY_IMMUTABLE"
  | "POSITION_LIMIT"
  | "POSITION_NOT_FOUND"
  | "POSITION_DELETED"
  | "CONFIRM_KEY_MISMATCH"
  | "MANAGER_NOT_FOUND"
  | "MANAGER_CYCLE";

export class PositionError extends Error {
  readonly code: PositionErrorCode;

  constructor(code: PositionErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PositionError";
    this.code = code;
  }
}

type Db = Prisma.TransactionClient | PrismaClient;

const CATEGORY_MAX = 100;
const DESCRIPTION_MAX = 1000;

// Blank optional text is stored as null.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

export const createPositionInputSchema = z.object({
  key: positionKeySchema,
  name: positionNameSchema,
  category: optionalText(CATEGORY_MAX),
  description: optionalText(DESCRIPTION_MAX),
  isLeadership: z.boolean().default(false),
  managerPositionId: z
    .uuid()
    .nullish()
    .transform((value) => value ?? null),
});

export type CreatePositionInput = z.infer<typeof createPositionInputSchema>;

// The key is deliberately absent: it is immutable, and updatePosition rejects
// a body that names it before this schema runs.
export const updatePositionInputSchema = z
  .strictObject({
    name: positionNameSchema.optional(),
    category: optionalText(CATEGORY_MAX).optional(),
    description: optionalText(DESCRIPTION_MAX).optional(),
    isLeadership: z.boolean().optional(),
    // null clears the manager.
    managerPositionId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message:
      "Send at least one of name, category, description, isLeadership or managerPositionId",
  });

export type UpdatePositionInput = z.infer<typeof updatePositionInputSchema>;

/** The fields of a position that audit metadata records. */
export function positionSnapshot(position: {
  key: string;
  name: string;
  category: string | null;
  description: string | null;
  isLeadership: boolean;
  managerPositionId: string | null;
}) {
  const { key, name, category, description, isLeadership, managerPositionId } =
    position;
  return {
    key,
    name,
    category,
    description,
    isLeadership,
    managerPositionId,
  };
}

/**
 * Throws KEY_TAKEN when an active position holds the key, and KEY_RETIRED when
 * the key was retired inside the retirement window.
 */
export async function assertPositionKeyAvailable(
  key: string,
  { db = prisma, now = new Date() }: { db?: Db; now?: Date } = {},
): Promise<void> {
  const active = await db.position.findFirst({
    where: { key, deletedAt: null },
    select: { id: true },
  });
  if (active) {
    throw new PositionError("KEY_TAKEN", `Position key "${key}" is in use`);
  }

  const latestRetirement = await db.retiredPositionKey.findFirst({
    where: { key },
    orderBy: { retiredAt: "desc" },
    select: { retiredAt: true },
  });
  if (
    latestRetirement &&
    isKeyRetirementActive(latestRetirement.retiredAt, now)
  ) {
    throw new PositionError(
      "KEY_RETIRED",
      `Position key "${key}" was retired recently and cannot be reused yet`,
    );
  }
}

const ACTIVE_KEY_INDEX = "Position_key_active_key";
const MAX_CAUSE_DEPTH = 3;

// Under @prisma/client 7.10 with adapter-pg, database rejections are
// PrismaClientKnownRequestErrors: a duplicate active key is P2002, and check
// and trigger violations are P2039. The constraint or trigger name is in
// `message`, which is what gets matched. Messages from `cause` are included in
// case a later Prisma version wraps the driver error.
function collectMessages(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!(current instanceof Error)) break;
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

// The driver adapter reports the violated index at
// meta.driverAdapterError.cause.constraint.index; P2002 carries no meta.target.
function driverConstraintIndex(err: Prisma.PrismaClientKnownRequestError) {
  const adapterError: unknown = err.meta?.driverAdapterError;
  if (typeof adapterError !== "object" || adapterError === null) return null;
  const cause: unknown = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return null;
  const constraint: unknown = (cause as { constraint?: unknown }).constraint;
  if (typeof constraint !== "object" || constraint === null) return null;
  const index: unknown = (constraint as { index?: unknown }).index;
  return typeof index === "string" ? index : null;
}

function isActiveKeyUniqueViolation(err: unknown, message: string): boolean {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    driverConstraintIndex(err) === ACTIVE_KEY_INDEX
  ) {
    return true;
  }
  return message.includes(ACTIVE_KEY_INDEX);
}

/**
 * Translates database backstop failures into `PositionError`. Returns null for
 * anything else, which the caller rethrows as unexpected.
 */
export function toPositionError(err: unknown): PositionError | null {
  if (err instanceof PositionError) {
    return err;
  }

  const message = collectMessages(err);

  if (isActiveKeyUniqueViolation(err, message)) {
    return new PositionError("KEY_TAKEN", "Position key is in use");
  }
  if (message.includes("POSITION_LIMIT")) {
    return new PositionError(
      "POSITION_LIMIT",
      "User already holds the maximum number of active positions",
    );
  }
  if (message.includes("KEY_IMMUTABLE")) {
    return new PositionError("KEY_IMMUTABLE", "Position key cannot be changed");
  }
  if (message.includes("Position_key_format_check")) {
    return new PositionError("INVALID_KEY", "Position key format is invalid");
  }
  if (message.includes("Position_name_length_check")) {
    return new PositionError(
      "INVALID_INPUT",
      "Position name length is invalid",
    );
  }
  if (message.includes("MANAGER_NOT_FOUND")) {
    return new PositionError(
      "MANAGER_NOT_FOUND",
      "Manager position does not exist or is deleted",
    );
  }
  if (
    message.includes("MANAGER_CYCLE") ||
    message.includes("Position_manager_not_self_check")
  ) {
    return new PositionError(
      "MANAGER_CYCLE",
      "A position cannot report to itself or to a position below it",
    );
  }
  return null;
}

// The same lock the `position_manager_valid` trigger takes, so the service's
// read of the graph and its write sit in one serialised section.
async function lockManagerGraph(tx: Db) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('position_manager_graph', 0))`;
}

/**
 * Throws MANAGER_NOT_FOUND when the manager is not an active position, and
 * MANAGER_CYCLE when it is the position itself or sits below it. `positionId`
 * is null for a position that does not exist yet. Call inside a transaction.
 */
async function assertManagerValid(
  tx: Db,
  positionId: string | null,
  managerId: string,
): Promise<void> {
  await lockManagerGraph(tx);
  const nodes = await tx.position.findMany({
    where: { deletedAt: null },
    select: { id: true, managerPositionId: true },
  });
  if (!nodes.some((node) => node.id === managerId)) {
    throw new PositionError(
      "MANAGER_NOT_FOUND",
      "Manager position does not exist or is deleted",
    );
  }
  if (positionId !== null && wouldCreateCycle(nodes, positionId, managerId)) {
    throw new PositionError(
      "MANAGER_CYCLE",
      "A position cannot report to itself or to a position below it",
    );
  }
}

/**
 * Creates a position. Does not check authorization and writes no audit row;
 * the calling handler owns both.
 */
export async function createPosition(
  input: unknown,
  actorId: string | null,
  { db = prisma, now = new Date() }: { db?: Db; now?: Date } = {},
) {
  const parsed = createPositionInputSchema.safeParse(input);
  if (!parsed.success) {
    const keyIssue = parsed.error.issues.some(
      (issue) => issue.path[0] === "key",
    );
    throw new PositionError(
      keyIssue ? "INVALID_KEY" : "INVALID_INPUT",
      parsed.error.message,
    );
  }
  const { key, name, category, description, isLeadership, managerPositionId } =
    parsed.data;

  const run = async (tx: Db) => {
    await assertPositionKeyAvailable(key, { db: tx, now });
    if (managerPositionId !== null) {
      await assertManagerValid(tx, null, managerPositionId);
    }
    return tx.position.create({
      data: {
        key,
        name,
        category,
        description,
        isLeadership,
        managerPositionId,
        createdById: actorId,
        updatedById: actorId,
      },
    });
  };

  try {
    return "$transaction" in db
      ? await db.$transaction((tx) => run(tx))
      : await run(db);
  } catch (err) {
    // The availability check ran inside the transaction, so a unique violation
    // on the active-key index means a concurrent create won the race. Re-check
    // outside the failed transaction so the reported reason reflects committed
    // state; when it still passes, the violation maps to KEY_TAKEN below.
    if (
      "$transaction" in db &&
      isActiveKeyUniqueViolation(err, collectMessages(err))
    ) {
      await assertPositionKeyAvailable(key, { db, now });
    }
    const mapped = toPositionError(err);
    if (mapped) {
      throw mapped;
    }
    throw err;
  }
}

// FOR UPDATE only holds inside a transaction, so a bare client opens one.
async function inTransaction<T>(
  db: Db,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return "$transaction" in db ? await db.$transaction(run) : await run(db);
  } catch (err) {
    throw toPositionError(err) ?? err;
  }
}

/**
 * Locks the row so a concurrent update or delete waits, then reads it. Throws
 * POSITION_NOT_FOUND for an unknown id and POSITION_DELETED for a soft-deleted
 * position. Call inside a transaction.
 */
async function lockPosition(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "Position" WHERE "id" = ${id} FOR UPDATE`;
  const position = await tx.position.findUnique({ where: { id } });
  if (!position) {
    throw new PositionError("POSITION_NOT_FOUND", "Position not found");
  }
  if (position.deletedAt) {
    throw new PositionError("POSITION_DELETED", "Position is deleted");
  }
  return position;
}

/** The editable fields whose value changed; `name` is never null. */
export type PositionChanges = {
  name?: string;
  category?: string | null;
  description?: string | null;
  isLeadership?: boolean;
  managerPositionId?: string | null;
};

/**
 * Updates name, category, description, leadership and manager. `before` and `after` hold only the
 * fields whose value changed; when none did, nothing is written and `changed`
 * is false. A body that names `key` is refused even when it is unchanged.
 * Writes no audit row; the calling handler owns that and authorization.
 */
export async function updatePosition(
  id: string,
  input: unknown,
  actorId: string | null,
  { db = prisma }: { db?: Db } = {},
) {
  if (typeof input === "object" && input !== null && "key" in input) {
    throw new PositionError("KEY_IMMUTABLE", "Position key cannot be changed");
  }
  const parsed = updatePositionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PositionError("INVALID_INPUT", parsed.error.message);
  }
  const requested = parsed.data;

  return inTransaction(db, async (tx) => {
    // Graph lock first when the manager may change; see deletePosition.
    if (requested.managerPositionId !== undefined) {
      await lockManagerGraph(tx);
    }
    const current = await lockPosition(tx, id);

    const before: PositionChanges = {};
    const after: PositionChanges = {};
    if (requested.name !== undefined && requested.name !== current.name) {
      before.name = current.name;
      after.name = requested.name;
    }
    if (
      requested.category !== undefined &&
      requested.category !== current.category
    ) {
      before.category = current.category;
      after.category = requested.category;
    }
    if (
      requested.description !== undefined &&
      requested.description !== current.description
    ) {
      before.description = current.description;
      after.description = requested.description;
    }
    if (
      requested.isLeadership !== undefined &&
      requested.isLeadership !== current.isLeadership
    ) {
      before.isLeadership = current.isLeadership;
      after.isLeadership = requested.isLeadership;
    }
    if (
      requested.managerPositionId !== undefined &&
      requested.managerPositionId !== current.managerPositionId
    ) {
      before.managerPositionId = current.managerPositionId;
      after.managerPositionId = requested.managerPositionId;
    }

    if (Object.keys(after).length === 0) {
      return { position: current, before, after, changed: false };
    }
    if (after.managerPositionId) {
      await assertManagerValid(tx, id, after.managerPositionId);
    }
    const position = await tx.position.update({
      where: { id },
      data: { ...after, updatedById: actorId },
    });
    return { position, before, after, changed: true };
  });
}

/**
 * Soft-deletes a position. `confirmKey` must equal the key exactly. Sets
 * `deletedAt`, retires the key, and keeps every UserPosition row: holders
 * lose the position on their next session read, which filters on `deletedAt`.
 * Direct reports lose their manager in the same transaction, so every active
 * edge keeps pointing at an active position.
 * Returns the pre-delete snapshot, the sorted holder ids and the sorted ids of
 * the reports that lost their manager, for the audit row.
 * Writes no audit row; the calling handler owns that and authorization.
 */
export async function deletePosition(
  id: string,
  confirmKey: unknown,
  actorId: string | null,
  { db = prisma, now = new Date() }: { db?: Db; now?: Date } = {},
) {
  const parsedConfirmKey = z
    .string()
    .max(POSITION_KEY_MAX)
    .safeParse(confirmKey);
  if (!parsedConfirmKey.success) {
    throw new PositionError("INVALID_INPUT", parsedConfirmKey.error.message);
  }

  return inTransaction(db, async (tx) => {
    // The graph lock comes before the row lock, here and in updatePosition, so
    // two transactions never wait on each other in opposite orders. It also
    // means a concurrent "set the manager to this position" either finishes
    // first (and is cleared below) or waits and then fails because the manager
    // is deleted.
    await lockManagerGraph(tx);
    const current = await lockPosition(tx, id);
    if (parsedConfirmKey.data !== current.key) {
      throw new PositionError(
        "CONFIRM_KEY_MISMATCH",
        "confirmKey does not match the position key",
      );
    }

    const reports = await tx.position.findMany({
      where: { managerPositionId: id },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (reports.length > 0) {
      await tx.position.updateMany({
        where: { managerPositionId: id },
        data: { managerPositionId: null, updatedById: actorId },
      });
    }

    await tx.position.update({
      where: { id },
      data: { deletedAt: now, updatedById: actorId },
    });
    await tx.retiredPositionKey.create({
      data: { positionId: id, key: current.key, retiredAt: now },
    });
    const holders = await tx.userPosition.findMany({
      where: { positionId: id },
      select: { userId: true },
      orderBy: { userId: "asc" },
    });
    return {
      before: positionSnapshot(current),
      deletedAt: now,
      holderIds: holders.map((holder) => holder.userId),
      reportIds: reports.map((report) => report.id),
    };
  });
}

const summarySelect = {
  id: true,
  key: true,
  name: true,
  category: true,
  description: true,
  isLeadership: true,
  managerPositionId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  _count: {
    select: { holders: true, reports: { where: { deletedAt: null } } },
  },
} satisfies Prisma.PositionSelect;

type SummaryRow = Prisma.PositionGetPayload<{ select: typeof summarySelect }>;

export type PositionSummary = Omit<SummaryRow, "_count"> & {
  holderCount: number;
  /** Active positions that list this one as their manager. */
  reportCount: number;
};

function toSummary({ _count, ...rest }: SummaryRow): PositionSummary {
  return { ...rest, holderCount: _count.holders, reportCount: _count.reports };
}

/** One position, deleted or not, with its holder count. Null when unknown. */
export async function getPositionSummary(
  id: string,
  { db = prisma }: { db?: Db } = {},
): Promise<PositionSummary | null> {
  const row = await db.position.findUnique({
    where: { id },
    select: summarySelect,
  });
  return row ? toSummary(row) : null;
}

/** Ordered by category (uncategorized last), then key. Not paginated. */
export async function listPositions({
  includeDeleted = false,
  db = prisma,
}: { includeDeleted?: boolean; db?: Db } = {}): Promise<PositionSummary[]> {
  const rows = await db.position.findMany({
    where: includeDeleted ? undefined : { deletedAt: null },
    select: summarySelect,
    orderBy: [{ category: { sort: "asc", nulls: "last" } }, { key: "asc" }],
  });
  return rows.map(toSummary);
}

export type PositionGraphNode = ManagerNode & {
  key: string;
  name: string;
  category: string | null;
  isLeadership: boolean;
};

/** The active positions with their manager edges: the org chart's input. */
export async function loadPositionGraph({
  db = prisma,
}: { db?: Db } = {}): Promise<PositionGraphNode[]> {
  return db.position.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      key: true,
      name: true,
      category: true,
      isLeadership: true,
      managerPositionId: true,
    },
    orderBy: [{ category: { sort: "asc", nulls: "last" } }, { name: "asc" }],
  });
}

/** Active leadership positions, by category (uncategorized last), then name. */
export async function listLeadershipPositions({
  db = prisma,
}: { db?: Db } = {}): Promise<PositionGraphNode[]> {
  const graph = await loadPositionGraph({ db });
  return graph.filter((position) => position.isLeadership);
}

/**
 * The managers above a position, from its immediate manager up to the root.
 * Null for an unknown or deleted position.
 */
export async function getManagerChain(
  positionId: string,
  { db = prisma }: { db?: Db } = {},
): Promise<PositionGraphNode[] | null> {
  const graph = await loadPositionGraph({ db });
  if (!graph.some((position) => position.id === positionId)) return null;
  return managerChain(graph, positionId);
}
