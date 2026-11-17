import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { positionKeySchema } from "@/lib/position-key";

type Db = PrismaClient | Prisma.TransactionClient;

export const POSITION_HOLDERS_MAX_KEYS = 20;

export const positionHoldersBody = z.strictObject({
  keys: z.array(positionKeySchema).min(1).max(POSITION_HOLDERS_MAX_KEYS),
});

export type PositionHolder = {
  id: string;
  email: string;
  name: string;
  preferredName: string | null;
};

export type PositionHolders = {
  key: string;
  name: string;
  holders: PositionHolder[];
};

export type PositionHoldersResult = {
  positions: PositionHolders[];
  unknownKeys: string[];
};

/**
 * Who holds these positions now. Read live: a deactivated user or a
 * deleted position drops out on the next call. Read only, and reads are not
 * audited. A key with no active position is `unknownKeys`; a vacant position is
 * present with no holders.
 */
export async function loadPositionHolders(
  db: Db,
  keys: string[],
): Promise<PositionHoldersResult> {
  const requested = [...new Set(keys)];
  const rows = await db.position.findMany({
    where: { key: { in: requested }, deletedAt: null },
    select: {
      key: true,
      name: true,
      holders: {
        where: { user: { status: "ACTIVE" } },
        select: {
          assignedAt: true,
          user: {
            select: { id: true, email: true, name: true, preferredName: true },
          },
        },
      },
    },
  });

  // Active keys are unique, so a key matches at most one row.
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const positions: PositionHolders[] = [];
  const unknownKeys: string[] = [];
  for (const key of requested) {
    const row = byKey.get(key);
    if (!row) {
      unknownKeys.push(key);
      continue;
    }
    const holders = [...row.holders]
      .sort(
        (a, b) =>
          a.assignedAt.getTime() - b.assignedAt.getTime() ||
          (a.user.id < b.user.id ? -1 : a.user.id > b.user.id ? 1 : 0),
      )
      .map(({ user }) => user);
    positions.push({ key: row.key, name: row.name, holders });
  }
  return { positions, unknownKeys };
}
