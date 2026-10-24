import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { audit, withAuditTransaction } from "@/lib/audit";

interface RevokeAllSessionsInput {
  prisma: PrismaClient;
  targetUserId: string;
  actorUserId: string;
  /** Request headers, for the audit row's IP and user agent. */
  headers?: Pick<Headers, "get">;
}

/**
 * Deletes every session of `targetUserId` and writes one SESSIONS_REVOKED row,
 * in one transaction: a failed audit write rolls the delete back.
 *
 * It does not authorize. The caller (the admin users endpoint, #48) must run
 * `can()` from `authz.ts` first. Revocation takes effect on the target's next
 * request because there is no cookie cache; their browser keeps a dead cookie
 * that resolves to no session.
 */
export function revokeAllSessionsForUser({
  prisma,
  targetUserId,
  actorUserId,
  headers,
}: RevokeAllSessionsInput): Promise<{ revoked: number }> {
  return withAuditTransaction(prisma, async (tx) => {
    const { count } = await tx.session.deleteMany({
      where: { userId: targetUserId },
    });
    await audit(
      {
        type: "SESSIONS_REVOKED",
        actorType: "USER",
        actorUserId,
        targetType: "USER",
        targetId: targetUserId,
        metadata: { scope: "all" },
      },
      { db: tx, headers },
    );
    return { revoked: count };
  });
}
