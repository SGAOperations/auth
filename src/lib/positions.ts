import "server-only";
import { z } from "zod";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  isKeyRetirementActive,
  positionKeySchema,
  positionNameSchema,
} from "@/lib/position-key";

export type PositionErrorCode =
  | "INVALID_INPUT"
  | "INVALID_KEY"
  | "KEY_TAKEN"
  | "KEY_RETIRED"
  | "KEY_IMMUTABLE"
  | "POSITION_LIMIT";

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
});

export type CreatePositionInput = z.infer<typeof createPositionInputSchema>;

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
  return null;
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
  const { key, name, category, description } = parsed.data;

  const run = async (tx: Db) => {
    await assertPositionKeyAvailable(key, { db: tx, now });
    return tx.position.create({
      data: {
        key,
        name,
        category,
        description,
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
