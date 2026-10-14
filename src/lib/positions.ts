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

function describeConstraintTarget(meta: unknown): string {
  return JSON.stringify(meta ?? null);
}

/**
 * Translates database backstop failures into `PositionError`. Returns null for
 * anything else, which the caller rethrows as unexpected.
 */
export function toPositionError(err: unknown): PositionError | null {
  if (err instanceof PositionError) {
    return err;
  }

  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    describeConstraintTarget(err.meta).includes("key")
  ) {
    return new PositionError("KEY_TAKEN", "Position key is in use");
  }

  const message = err instanceof Error ? err.message : "";
  if (message.includes("POSITION_LIMIT")) {
    return new PositionError(
      "POSITION_LIMIT",
      "User already holds the maximum number of active positions",
    );
  }
  if (message.includes("Position_key_format_check")) {
    return new PositionError("INVALID_KEY", "Position key format is invalid");
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
    throw toPositionError(err) ?? err;
  }
}
