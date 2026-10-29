import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { loadTarget } from "@/lib/admin/users/queries";
import { audit, withAuditTransaction } from "@/lib/audit";
import { can, type AuthzDenialReason, type AuthzSubject } from "@/lib/authz";

export type RevokeUserSessionResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN"; reason: AuthzDenialReason };

/**
 * An admin ends one of another user's sessions. A session that is not that
 * user's answers `NOT_FOUND`, the same as an unknown id, so an admin cannot
 * probe session ids. The delete and its audit row commit together.
 */
export async function revokeUserSession(
  db: PrismaClient,
  actor: AuthzSubject,
  { userId, sessionId }: { userId: string; sessionId: string },
): Promise<RevokeUserSessionResult> {
  const target = await loadTarget(db, userId);
  if (!target || target.status === "DELETED") {
    return { ok: false, code: "NOT_FOUND" };
  }
  const decision = can(actor, "revokeSessions", target);
  if (!decision.allowed) {
    return { ok: false, code: "FORBIDDEN", reason: decision.reason };
  }

  return withAuditTransaction(db, async (tx) => {
    const { count } = await tx.session.deleteMany({
      where: { id: sessionId, userId },
    });
    if (count === 0) return { ok: false, code: "NOT_FOUND" } as const;
    await audit({
      type: "SESSION_REVOKED",
      actorType: "USER",
      actorUserId: actor.id,
      targetType: "SESSION",
      targetId: sessionId,
      metadata: { userId },
    });
    return { ok: true } as const;
  });
}
