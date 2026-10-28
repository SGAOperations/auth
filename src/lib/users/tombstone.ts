import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  withAuditAnonymization,
  writeAuditEvent,
  type AuditActor,
} from "@/lib/audit";

export interface TombstoneInput {
  userId: string;
  reason: "admin";
  actor: AuditActor;
  /** Extra conditions on the row, so a caller can make the tombstone conditional. */
  guard?: Prisma.UserWhereInput;
}

/**
 * Scrubs a user's personal data and keeps the row (docs/DATA_HANDLING.md): the
 * id stays so audit rows and `assignedById`-style references still resolve.
 * Returns `{ tombstoned: false }` and writes nothing when the user is the
 * Primary Admin, is already deleted, or does not match `guard`.
 *
 * It runs in its own anonymization transaction, so a caller does not wrap it.
 * Writes exactly one audit row, `USER_DELETED`.
 */
export async function tombstoneUser(
  client: PrismaClient,
  { userId, reason, actor, guard }: TombstoneInput,
): Promise<{ tombstoned: boolean }> {
  return withAuditAnonymization(client, async (tx) => {
    // The old address is used below to find its tokens, and is never logged.
    const current = await tx.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        // Active positions only: the catalog caps the list at the per-user
        // limit, which counts them, and a deleted position is already history.
        positions: {
          where: { position: { deletedAt: null } },
          select: { positionId: true },
        },
      },
    });
    if (!current) return { tombstoned: false };

    const scrubbed = await tx.user.updateMany({
      where: {
        id: userId,
        status: { not: "DELETED" },
        isPrimaryAdmin: false,
        ...guard,
      },
      data: {
        status: "DELETED",
        deletedAt: new Date(),
        email: `deleted+${userId}@invalid`,
        name: "Deleted user",
        preferredName: null,
        image: null,
        emailVerified: false,
        twoFactorEnabled: false,
        isAdmin: false,
      },
    });
    if (scrubbed.count === 0) return { tombstoned: false };

    await tx.session.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });
    await tx.twoFactor.deleteMany({ where: { userId } });
    await tx.knownDevice.deleteMany({ where: { userId } });
    await tx.unlockToken.deleteMany({ where: { userId } });
    await tx.accountLock.deleteMany({ where: { userId } });
    await tx.userPosition.deleteMany({ where: { userId } });
    // Set-password and reset tokens carry the user id as their value, and
    // email-keyed rows carry the old address.
    await tx.verification.deleteMany({
      where: { OR: [{ value: userId }, { identifier: current.email }] },
    });

    // The strict audit catalog already keeps PII out of `metadata`, so only
    // the network fields need scrubbing. The rows themselves stay.
    await tx.auditEvent.updateMany({
      where: {
        OR: [{ actorUserId: userId }, { targetType: "USER", targetId: userId }],
      },
      data: { ip: null, userAgent: null },
    });

    // `writeAuditEvent`, not `audit()`: the row is about a scrubbed user, so its
    // own ip and user agent are null on purpose and must not fall back to the
    // request's.
    await writeAuditEvent(tx, {
      type: "USER_DELETED",
      ...actor,
      targetType: "USER",
      targetId: userId,
      metadata: {
        reason,
        removedPositionIds: current.positions.map(
          ({ positionId }) => positionId,
        ),
      },
      ip: null,
      userAgent: null,
    });
    return { tombstoned: true };
  });
}
