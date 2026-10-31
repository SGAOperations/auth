import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";

/** What the security card shows of a passkey. Never the key or credential id. */
export interface PasskeyListItem {
  id: string;
  name: string | null;
  /** ISO 8601, so it crosses into a client component as a plain string. */
  createdAt: string;
  /** Synced across the person's devices by their password manager. */
  backedUp: boolean;
}

type PasskeyDb = { passkey: Pick<PrismaClient["passkey"], "findMany"> };

/** The user's own passkeys, oldest first. */
export async function loadPasskeys(
  db: PasskeyDb,
  userId: string,
): Promise<PasskeyListItem[]> {
  const rows = await db.passkey.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, createdAt: true, backedUp: true },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    backedUp: row.backedUp,
  }));
}
