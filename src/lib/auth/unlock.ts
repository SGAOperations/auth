import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { clearAccountLock } from "@/lib/auth/lockout";
import { consumeUnlockToken, hashUnlockToken } from "@/lib/auth/unlock-token";
import {
  TOKEN_ACTION_RESULTS,
  type TokenActionInput,
  type TokenActionOutcome,
  type TokenActionResult,
} from "@/lib/token-links/handler";

// The two halves of the emailed unlock link (docs/LOCKOUT.md). The page only
// reads; the POST consumes. An unknown, used or expired token is `invalid` in
// both, so the response never names the account or says why.

const searchParamsSchema = z.object({
  token: z.string().max(4096).optional(),
  result: z.enum(TOKEN_ACTION_RESULTS).optional(),
});

export type UnlockView =
  | { state: "ready"; token: string }
  | { state: TokenActionResult };

/**
 * What the GET page shows. Read-only by construction: it looks the token up
 * and never claims it, so a scanner pre-fetch consumes nothing.
 */
export async function loadUnlockView(
  searchParams: Record<string, string | string[] | undefined>,
  db: Pick<PrismaClient, "unlockToken">,
  now: Date = new Date(),
): Promise<UnlockView> {
  const parsed = searchParamsSchema.safeParse(searchParams);
  if (!parsed.success) return { state: "invalid" };
  const { token, result } = parsed.data;
  if (result) return { state: result };
  if (!token) return { state: "invalid" };

  const row = await db.unlockToken.findUnique({
    where: { tokenHash: hashUnlockToken(token) },
    select: { usedAt: true, expiresAt: true },
  });
  if (!row || row.usedAt !== null || row.expiresAt <= now) {
    return { state: "invalid" };
  }
  return { state: "ready", token };
}

/**
 * The POST's `consume`. The token, the lock and the audit row change in one
 * transaction, so a failure leaves the link usable and the account locked.
 */
export function createUnlockConsumer({
  prisma,
  onUnlocked,
}: {
  prisma: PrismaClient;
  onUnlocked: (tx: Prisma.TransactionClient, userId: string) => Promise<void>;
}): (input: TokenActionInput) => Promise<TokenActionOutcome> {
  return async function consume({ token }) {
    const now = new Date();
    return prisma.$transaction(async (tx): Promise<TokenActionOutcome> => {
      const userId = await consumeUnlockToken(tx, token, now);
      if (userId === null) return { result: "invalid" };
      await clearAccountLock(tx, { userId, now });
      await onUnlocked(tx, userId);
      return { result: "done" };
    });
  };
}
