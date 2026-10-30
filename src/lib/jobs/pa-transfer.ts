import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { writeAuditEvent, type TransferCancelReason } from "@/lib/audit";
import { cancelOpenEmailChangeRequests } from "@/lib/email-change/cancel";
import { recipientIneligibility } from "@/lib/jobs/pa-transfer-machine";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";

// Database side of the Primary Admin transfer that the scheduled job owns:
// executes a COOLING transfer whose window has ended, expires a
// PENDING_ACCEPTANCE one nobody accepted, and cancels one whose recipient is no
// longer an eligible admin (active, admin and MFA-enrolled). Initiate, accept, decline and cancel are the user
// actions in pa-transfer-actions.ts, which reuse the helpers exported here.
//
// Concurrency: the job claims each transfer with FOR UPDATE SKIP LOCKED inside
// its own transaction, and everything is decided while that lock is held. A
// second run either skips the row or, once the first commits, no longer matches
// the status it selects on, so a transfer is acted on once. A user action takes
// the same row lock with a blocking FOR UPDATE (lockTransfer), so it waits for
// a running job and then re-reads the row.

/** Caps one run; the one-in-flight index means one pending row is the norm. */
const MAX_PER_RUN = 5;

export type TransferNotice = {
  kind: "initiated" | "accepted" | "cancelled" | "completed" | "expired";
  transferId: string;
  fromUserId: string;
  toUserId: string;
  reason?: TransferCancelReason;
  /** The raw cancel token, on `accepted` only. It is mailed and never logged. */
  cancelToken?: string;
};

/** Called after the state change commits. */
export type TransferNotifier = (notice: TransferNotice) => Promise<void> | void;

export type Tx = Prisma.TransactionClient;

type ClaimedTransfer = Prisma.PrimaryAdminTransferGetPayload<{
  include: { fromUser: true; toUser: true };
}>;

/**
 * Test seams. They default to nothing and production never passes them. The
 * harness cannot commit a Primary Admin (src/test/db-setup.ts), so a test
 * creates one inside the transaction under test and inspects it before the
 * rollback.
 */
export interface PaTransferHooks {
  /** After the row is claimed and read, before eligibility is checked. */
  afterClaim?: (tx: Tx, transfer: ClaimedTransfer) => Promise<void>;
  /** After every write, immediately before the transaction commits. */
  beforeCommit?: (tx: Tx) => Promise<void>;
}

export interface PaTransferOptions {
  now?: Date;
  notify?: TransferNotifier;
  hooks?: PaTransferHooks;
}

// A type alias, not an interface, so it is assignable to a job's result record.
export type PaTransferResult = {
  executed: number;
  cancelled: number;
  expired: number;
  notifyFailures: number;
};

// Loaded on the first notice: the notifier builds the mailer, which reads the
// whole environment, and a run with nothing to announce never needs it.
const notifyByEmail: TransferNotifier = async (notice) => {
  const { notifyTransfer } = await import("@/lib/jobs/pa-transfer-notify");
  await notifyTransfer(notice);
};

const SYSTEM = { actorType: "SYSTEM" } as const;

type SystemCancelReason = Extract<
  TransferCancelReason,
  "recipient_ineligible" | "sender_not_primary_admin"
>;

/**
 * The rule the initiate path applies, so the job and initiate cannot drift:
 * the recipient is active, an admin and MFA-enrolled.
 */
function recipientIsEligible(
  transfer: Pick<ClaimedTransfer, "fromUserId" | "toUser">,
): boolean {
  return recipientIneligibility(transfer.toUser, transfer.fromUserId) === null;
}

async function claimIneligibleInFlight(tx: Tx) {
  // The recipient test is the one the execute path applies, so a transfer that
  // would be refused at execution is cancelled as soon as the job sees it. It
  // mirrors recipientIneligibility minus SELF, which a transfer row cannot have.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT t."id" FROM "PrimaryAdminTransfer" t
    JOIN "User" u ON u."id" = t."toUserId"
    WHERE t."status" IN ('PENDING_ACCEPTANCE', 'COOLING')
      AND (u."status" <> 'ACTIVE' OR NOT u."isAdmin" OR NOT u."twoFactorEnabled")
    ORDER BY t."createdAt" LIMIT 1 FOR UPDATE OF t SKIP LOCKED`;
  return rows[0] ? readTransfer(tx, rows[0].id) : null;
}

async function claimDueCooling(tx: Tx, now: Date) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PrimaryAdminTransfer"
    WHERE "status" = 'COOLING' AND "executesAt" <= ${now}
    ORDER BY "executesAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
  return rows[0] ? readTransfer(tx, rows[0].id) : null;
}

async function claimStalePending(tx: Tx, now: Date) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PrimaryAdminTransfer"
    WHERE "status" = 'PENDING_ACCEPTANCE' AND "acceptanceExpiresAt" <= ${now}
    ORDER BY "acceptanceExpiresAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
  return rows[0] ? readTransfer(tx, rows[0].id) : null;
}

/** Takes the row lock a user action holds for its whole transaction. */
export async function lockTransfer(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "PrimaryAdminTransfer" WHERE "id" = ${id} FOR UPDATE`;
}

function readTransfer(tx: Tx, id: string) {
  return tx.primaryAdminTransfer.findUniqueOrThrow({
    where: { id },
    include: { fromUser: true, toUser: true },
  });
}

export function noticeFor(
  kind: TransferNotice["kind"],
  transfer: Pick<ClaimedTransfer, "id" | "fromUserId" | "toUserId">,
  extra: Pick<TransferNotice, "reason" | "cancelToken"> = {},
): TransferNotice {
  return {
    kind,
    transferId: transfer.id,
    fromUserId: transfer.fromUserId,
    toUserId: transfer.toUserId,
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.cancelToken ? { cancelToken: extra.cancelToken } : {}),
  };
}

async function cancelIneligible(
  tx: Tx,
  transfer: ClaimedTransfer,
  now: Date,
  reason: SystemCancelReason,
): Promise<TransferNotice> {
  await tx.primaryAdminTransfer.update({
    where: { id: transfer.id },
    data: {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledById: null,
      cancelTokenHash: null,
      reason,
    },
  });
  await writeAuditEvent(tx, {
    type: "PA_TRANSFER_CANCELLED",
    ...SYSTEM,
    targetType: "TRANSFER",
    targetId: transfer.id,
    metadata: { reason, via: "system" },
  });
  return noticeFor("cancelled", transfer, { reason });
}

/**
 * For the revoke-admin and deactivate paths: inside their transaction, after
 * they change `userId`, cancel the in-flight transfer that names that user as
 * recipient if they can no longer receive it. Returns the notice to send after
 * commit, or `null` when there is nothing to cancel.
 */
export async function cancelForIneligibleRecipient(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<TransferNotice | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PrimaryAdminTransfer"
    WHERE "toUserId" = ${userId} AND "status" IN ('PENDING_ACCEPTANCE', 'COOLING')
    FOR UPDATE`;
  if (!rows[0]) return null;
  const transfer = await readTransfer(tx, rows[0].id);
  if (recipientIsEligible(transfer)) return null;
  return cancelIneligible(tx, transfer, now, "recipient_ineligible");
}

async function execute(
  tx: Tx,
  transfer: ClaimedTransfer,
  now: Date,
): Promise<TransferNotice> {
  // Transaction-local, never a plain SET: see the primary_admin_invariants
  // migration header (a session-level SET leaks through the pooler).
  await tx.$executeRaw`SET LOCAL sgauth.pa_transfer = 'on'`;
  // Clear the sender first: the unique index cannot be deferred.
  await tx.user.update({
    where: { id: transfer.fromUserId },
    data: { isPrimaryAdmin: false },
  });
  await tx.user.update({
    where: { id: transfer.toUserId },
    data: { isPrimaryAdmin: true },
  });
  // Sessions live only in the database (no cookie cache), so deleting them
  // forces both users to sign in again with their new standing.
  await tx.session.deleteMany({
    where: { userId: { in: [transfer.fromUserId, transfer.toUserId] } },
  });
  for (const userId of [transfer.fromUserId, transfer.toUserId]) {
    await writeAuditEvent(tx, {
      type: "SESSIONS_REVOKED",
      ...SYSTEM,
      targetType: "USER",
      targetId: userId,
      metadata: { scope: "all" },
    });
  }
  // Both users' standing changed, so no email change they are the target or
  // requester of may be confirmed under the old standing.
  await cancelOpenEmailChangeRequests(
    tx,
    [transfer.fromUserId, transfer.toUserId],
    now,
  );
  // The cancel link dies with the transfer.
  await tx.primaryAdminTransfer.update({
    where: { id: transfer.id },
    data: { status: "COMPLETED", completedAt: now, cancelTokenHash: null },
  });
  await writeAuditEvent(tx, {
    type: "PA_TRANSFER_COMPLETED",
    ...SYSTEM,
    targetType: "TRANSFER",
    targetId: transfer.id,
  });
  return noticeFor("completed", transfer);
}

async function expire(
  tx: Tx,
  transfer: ClaimedTransfer,
): Promise<TransferNotice> {
  await tx.primaryAdminTransfer.update({
    where: { id: transfer.id },
    data: { status: "EXPIRED" },
  });
  await writeAuditEvent(tx, {
    type: "PA_TRANSFER_EXPIRED",
    ...SYSTEM,
    targetType: "TRANSFER",
    targetId: transfer.id,
  });
  return noticeFor("expired", transfer);
}

async function processOne(
  tx: Tx,
  now: Date,
  hooks: PaTransferHooks,
): Promise<TransferNotice | null> {
  // First, so a transfer to a user who lost admin or was deactivated is
  // cancelled promptly even when nothing called cancelForIneligibleRecipient.
  const ineligible = await claimIneligibleInFlight(tx);
  if (ineligible) {
    await hooks.afterClaim?.(tx, ineligible);
    const notice = await cancelIneligible(
      tx,
      ineligible,
      now,
      "recipient_ineligible",
    );
    await hooks.beforeCommit?.(tx);
    return notice;
  }

  const due = await claimDueCooling(tx, now);
  if (due) {
    await hooks.afterClaim?.(tx, due);
    // Re-read inside the lock: the parties may have changed during cooling.
    const fresh = await readTransfer(tx, due.id);
    let notice: TransferNotice;
    if (!recipientIsEligible(fresh)) {
      notice = await cancelIneligible(tx, due, now, "recipient_ineligible");
    } else if (!fresh.fromUser.isPrimaryAdmin) {
      notice = await cancelIneligible(tx, due, now, "sender_not_primary_admin");
    } else {
      notice = await execute(tx, due, now);
    }
    await hooks.beforeCommit?.(tx);
    return notice;
  }

  const stale = await claimStalePending(tx, now);
  if (!stale) return null;
  await hooks.afterClaim?.(tx, stale);
  const notice = await expire(tx, stale);
  await hooks.beforeCommit?.(tx);
  return notice;
}

export async function runPaTransferJob(
  options: PaTransferOptions = {},
): Promise<PaTransferResult> {
  const now = options.now ?? new Date();
  const notify = options.notify ?? notifyByEmail;
  const hooks = options.hooks ?? {};
  const result: PaTransferResult = {
    executed: 0,
    cancelled: 0,
    expired: 0,
    notifyFailures: 0,
  };

  for (let i = 0; i < MAX_PER_RUN; i += 1) {
    const notice = await prisma.$transaction((tx) =>
      processOne(tx, now, hooks),
    );
    if (!notice) break;

    if (notice.kind === "completed") result.executed += 1;
    else if (notice.kind === "cancelled") result.cancelled += 1;
    else result.expired += 1;

    // The state change has committed, so a failing notifier is counted and
    // logged, never rethrown.
    try {
      await notify(notice);
    } catch (err) {
      result.notifyFailures += 1;
      logger.error("pa_transfer.notify_failed", {
        err,
        transferId: notice.transferId,
        kind: notice.kind,
      });
    }
  }

  return result;
}
