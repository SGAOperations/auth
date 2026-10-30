import "server-only";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Cancels every open email-change request that `userId` is the target of or the
 * requester of. Called inside the transaction that changes the user's admin
 * flags or deactivates them, so a link mailed under the old authority cannot be
 * confirmed afterwards. Returns how many were cancelled.
 */
export async function cancelOpenEmailChangeRequests(
  tx: Prisma.TransactionClient,
  userIds: string | readonly string[],
  now: Date,
): Promise<number> {
  const ids = typeof userIds === "string" ? [userIds] : [...userIds];
  const { count } = await tx.emailChangeRequest.updateMany({
    where: {
      consumedAt: null,
      cancelledAt: null,
      OR: [{ userId: { in: ids } }, { requestedById: { in: ids } }],
    },
    data: { cancelledAt: now },
  });
  return count;
}
