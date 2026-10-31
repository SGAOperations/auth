import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  AUDIT_PII_METADATA_FIELDS,
  withAuditAnonymization,
  writeAuditEvent,
  type AuditActor,
} from "@/lib/audit";
import {
  cancelForIneligibleRecipient,
  lockInFlightTransferTo,
  type TransferNotice,
} from "@/lib/jobs/pa-transfer";
import { TOMBSTONE_NAME, tombstoneEmail } from "@/lib/retention/policy";

export interface TombstoneInput {
  userId: string;
  /** The rule that fired: `admin` for the admin delete, else a retention rule. */
  reason: "admin" | "deactivated_30d" | "inactive_12mo" | "unverified_7d";
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
 * Writes exactly one audit row, `USER_DELETED`, plus `PA_TRANSFER_CANCELLED`
 * when it cancels a transfer to this user; the notice for that one is returned
 * for the caller to send after the commit.
 */
export async function tombstoneUser(
  client: PrismaClient,
  { userId, reason, actor, guard }: TombstoneInput,
): Promise<{ tombstoned: boolean; transferNotice?: TransferNotice | null }> {
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

    // Before the user row, the order the job uses: see lockInFlightTransferTo.
    await lockInFlightTransferTo(tx, userId);
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
        email: tombstoneEmail(userId),
        name: TOMBSTONE_NAME,
        preferredName: null,
        image: null,
        emailVerified: false,
        twoFactorEnabled: false,
        isAdmin: false,
        inactivityNoticeSentAt: null,
      },
    });
    if (scrubbed.count === 0) return { tombstoned: false };

    // The scrub made the user a non-admin, so a transfer to them cannot go on.
    const transferNotice = await cancelForIneligibleRecipient(
      tx,
      userId,
      new Date(),
    );

    await tx.session.deleteMany({ where: { userId } });
    await tx.account.deleteMany({ where: { userId } });
    await tx.twoFactor.deleteMany({ where: { userId } });
    await tx.knownDevice.deleteMany({ where: { userId } });
    await tx.unlockToken.deleteMany({ where: { userId } });
    // A pending request holds an address that is not the user's own yet.
    await tx.emailChangeRequest.deleteMany({ where: { userId } });
    await tx.accountLock.deleteMany({ where: { userId } });
    await tx.userPosition.deleteMany({ where: { userId } });
    // The Slack account the user linked (#313) identifies them.
    await tx.slackIdentity.deleteMany({ where: { userId } });
    // Set-password and reset tokens carry the user id as their value, and
    // email-keyed rows carry the old address.
    await tx.verification.deleteMany({
      where: { OR: [{ value: userId }, { identifier: current.email }] },
    });

    // The strict audit catalog keeps PII out of `metadata` except the keys it
    // lists in AUDIT_PII_METADATA_FIELDS, which are removed here. The network
    // fields are nulled, and the rows themselves stay.
    await tx.auditEvent.updateMany({
      where: {
        OR: [{ actorUserId: userId }, { targetType: "USER", targetId: userId }],
      },
      data: { ip: null, userAgent: null },
    });
    for (const [type, fields] of Object.entries(AUDIT_PII_METADATA_FIELDS)) {
      await tx.$executeRaw`
        UPDATE "AuditEvent"
        SET "metadata" = "metadata" - ${[...fields]}::text[]
        WHERE "type" = ${type}
          AND "targetType" = 'USER'::"AuditTargetType"
          AND "targetId" = ${userId}`;
    }

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
    return { tombstoned: true, transferNotice };
  });
}
