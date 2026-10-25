import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";

type UnlockTokenDb = Pick<PrismaClient, "unlockToken">;

/** One hour, per AUTH-T64. */
export const UNLOCK_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Lower-case hex SHA-256: the only form of a token that is ever stored. */
export function hashUnlockToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Stores the hash of a fresh token and returns the raw token for the email
 * link. The raw token is never logged or persisted.
 */
export async function issueUnlockToken(
  db: UnlockTokenDb,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await db.unlockToken.create({
    data: {
      userId,
      tokenHash: hashUnlockToken(raw),
      expiresAt: new Date(now.getTime() + UNLOCK_TOKEN_TTL_MS),
    },
  });
  return raw;
}

/**
 * Marks every unused token of the user as used, so an older emailed link dies
 * once any unlock path (link, password reset, admin) has run.
 */
export async function revokeUnlockTokens(
  db: UnlockTokenDb,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.unlockToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: now },
  });
}

/**
 * Marks the token used and returns its `userId`. Unknown, used and expired
 * tokens all return `null`, so a caller cannot tell them apart.
 */
export async function consumeUnlockToken(
  db: UnlockTokenDb,
  raw: string,
  now: Date = new Date(),
): Promise<string | null> {
  const tokenHash = hashUnlockToken(raw);
  // The conditional update is the atomic single-use guard.
  const { count } = await db.unlockToken.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (count !== 1) return null;
  const row = await db.unlockToken.findUnique({
    where: { tokenHash },
    select: { userId: true },
  });
  return row?.userId ?? null;
}
