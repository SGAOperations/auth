import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  sameKeySet,
  submitterKeysInputSchema,
} from "@/lib/access-submitters-input";
import { audit, withAuditTransaction } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

// The positions whose holders may submit access requests from Slack (#340). The
// list is global and fails closed: with no rows, nobody may submit.
//
// `setSubmitterPositionKeys` does not authorize. The caller runs
// `can(actor, "accessAdmin")` server-side before calling it, as `updateProduct`'s
// callers do.

type Db = PrismaClient | Prisma.TransactionClient;

export type AccessSubmitterErrorCode = "INVALID_INPUT" | "UNKNOWN_POSITION";

export class AccessSubmitterError extends Error {
  readonly code: AccessSubmitterErrorCode;
  /** Set for `INVALID_INPUT`. */
  readonly fieldErrors: Record<string, string[]>;
  /** Set for `UNKNOWN_POSITION`: the keys that name no active position. */
  readonly unknownKeys: string[];

  constructor(
    code: AccessSubmitterErrorCode,
    message: string,
    details: {
      fieldErrors?: Record<string, string[]>;
      unknownKeys?: string[];
    } = {},
  ) {
    super(message);
    this.name = "AccessSubmitterError";
    this.code = code;
    this.fieldErrors = details.fieldErrors ?? {};
    this.unknownKeys = details.unknownKeys ?? [];
  }
}

export interface SubmitterPosition {
  positionId: string;
  key: string;
  name: string;
}

/** The listed positions that are still active, by key. */
export async function listSubmitterPositions({
  db = prisma,
}: { db?: Db } = {}): Promise<SubmitterPosition[]> {
  const rows = await db.accessSubmitterPosition.findMany({
    where: { position: { deletedAt: null } },
    select: { position: { select: { id: true, key: true, name: true } } },
    orderBy: { position: { key: "asc" } },
  });
  return rows.map(({ position }) => ({
    positionId: position.id,
    key: position.key,
    name: position.name,
  }));
}

/** The keys of `listSubmitterPositions`. `[]` when nothing is configured. */
export async function listSubmitterPositionKeys({
  db = prisma,
}: { db?: Db } = {}): Promise<string[]> {
  return (await listSubmitterPositions({ db })).map(({ key }) => key);
}

/**
 * Replaces the list with `input.keys`. Every key must name an active position,
 * or nothing is written. A replace that changes nothing writes no rows and no
 * audit event. Concurrent replaces serialise on an advisory lock.
 */
export async function setSubmitterPositionKeys(
  input: unknown,
  actorUserId: string,
  { db = prisma }: { db?: PrismaClient } = {},
): Promise<{ changed: boolean; before: string[]; after: string[] }> {
  const parsed = submitterKeysInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AccessSubmitterError("INVALID_INPUT", "Invalid input", {
      fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<
        string,
        string[]
      >,
    });
  }
  const { keys } = parsed.data;

  return withAuditTransaction(db, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('access_submitter_positions', 0))`;

    const before = await listSubmitterPositionKeys({ db: tx });

    const positions = await tx.position.findMany({
      where: { key: { in: keys }, deletedAt: null },
      select: { id: true, key: true },
    });
    const found = new Set(positions.map(({ key }) => key));
    const unknownKeys = keys.filter((key) => !found.has(key));
    if (unknownKeys.length > 0) {
      throw new AccessSubmitterError(
        "UNKNOWN_POSITION",
        "Some keys name no active position",
        { unknownKeys },
      );
    }

    const after = positions.map(({ key }) => key).sort();
    if (sameKeySet(before, after)) return { changed: false, before, after };

    const ids = positions.map(({ id }) => id);
    // Also clears stale rows of deleted positions.
    await tx.accessSubmitterPosition.deleteMany({
      where: { positionId: { notIn: ids } },
    });
    await tx.accessSubmitterPosition.createMany({
      data: ids.map((positionId) => ({ positionId })),
      skipDuplicates: true,
    });

    await audit({
      type: "ACCESS_SUBMITTERS_UPDATED",
      actorType: "USER",
      actorUserId,
      metadata: { before, after },
    });
    return { changed: true, before, after };
  });
}
